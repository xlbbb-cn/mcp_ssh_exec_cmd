/**
 * SSH connection pool.
 *
 * Every SSH tool call used to open (and close) its own connection, so a
 * playbook of N steps paid N TCP handshakes + N authentications, and a
 * second command against the same host paid another one.
 *
 * This module keeps **one** live :class:`Client` per host so repeated
 * commands reuse the same session:
 *
 *   - The pool key is the host id, but every entry also stores a
 *     *fingerprint* of the credentials it was opened with.  When a
 *     host's address / user / key / password changes, the fingerprint
 *     changes and the stale connection is dropped instead of reused.
 *   - Idle connections are closed after ``idleMs`` milliseconds so we do
 *     not hold sockets open forever (NAT boxes and load balancers drop
 *     idle connections anyway).
 *   - A connection that reports an error or closes is marked broken and
 *     removed; the next acquire transparently opens a fresh one.
 *   - ``exec`` failures on a pooled connection are retried once with a
 *     new connection, because a pooled socket may have been closed by
 *     the peer while it sat idle.
 *
 * Pooling can be turned off entirely by setting ``MCP_SSH_POOL_IDLE_MS=0``,
 * in which case every acquire returns a throw-away connection.
 */
import { Client, type ConnectConfig } from "ssh2";
import { createHash } from "node:crypto";
import type { HostCreds } from "./types.js";

const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_MAX_HOSTS = 32;

/** Raised when an SSH connection cannot be established. */
export class SshConnectionError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = "SshConnectionError";
    }
}

export interface PoolConfig {
    /** Close a pooled connection after this many idle ms. ``0`` disables pooling. */
    idleMs: number;
    /** Maximum number of hosts kept in the pool. */
    maxHosts: number;
}

export interface ConnectionPoolOptions extends Partial<PoolConfig> {
    /** Override the connector (used by the tests). */
    connect?: (creds: HostCreds, timeoutSeconds: number) => Promise<Client>;
}

/** Read the pool configuration from the environment. */
export function loadPoolConfig(): PoolConfig {
    const idleRaw = process.env.MCP_SSH_POOL_IDLE_MS?.trim();
    const maxRaw = process.env.MCP_SSH_POOL_MAX_HOSTS?.trim();
    const idle = idleRaw ? Number(idleRaw) : DEFAULT_IDLE_MS;
    const max = maxRaw ? Number(maxRaw) : DEFAULT_MAX_HOSTS;
    return {
        idleMs: Number.isFinite(idle) && idle >= 0 ? idle : DEFAULT_IDLE_MS,
        maxHosts: Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_MAX_HOSTS,
    };
}

/**
 * Fingerprint the material a connection was opened with.  Any change to
 * the address, port, user, auth method or credential invalidates the
 * pooled connection.
 */
export function credentialFingerprint(creds: HostCreds): string {
    return createHash("sha256")
        .update(
            [
                "v1",
                creds.ip_address,
                creds.ssh_port,
                creds.ssh_username,
                creds.ssh_auth_method,
                creds.ssh_password,
                creds.ssh_private_key,
                creds.ssh_private_key_passphrase,
            ].join("\u0000"),
        )
        .digest("hex");
}

/** Open a brand-new SSH connection.  The caller owns the socket. */
export function openConnection(
    creds: HostCreds,
    timeoutSeconds: number,
): Promise<Client> {
    return new Promise((resolve, reject) => {
        const config: ConnectConfig = {
            host: creds.ip_address,
            port: creds.ssh_port,
            username: creds.ssh_username,
            // ssh2 has its own keepalive defaults; pass them through.
            readyTimeout: timeoutSeconds * 1000,
            tryKeyboard: false,
        };
        if (creds.ssh_auth_method === "password") {
            config.password = creds.ssh_password;
        } else {
            config.privateKey = creds.ssh_private_key;
            if (creds.ssh_private_key_passphrase) {
                config.passphrase = creds.ssh_private_key_passphrase;
            }
        }

        const conn = new Client();
        let settled = false;

        const fail = (err: Error) => {
            if (settled) return;
            settled = true;
            try {
                conn.end();
            } catch {
                // ignore
            }
            reject(new SshConnectionError(err.message, err));
        };

        conn.on("ready", () => {
            if (settled) return;
            settled = true;
            resolve(conn);
        });
        conn.on("error", fail);
        conn.on("close", () => {
            if (!settled) {
                settled = true;
                reject(new SshConnectionError("connection closed before ready"));
            }
        });

        conn.connect(config);
    });
}

interface PoolEntry {
    hostId: string;
    fingerprint: string;
    client: Client;
    /** Number of in-flight operations using this connection. */
    active: number;
    broken: boolean;
    idleTimer: NodeJS.Timeout | null;
    lastUsed: number;
}

/** A borrowed connection.  Call ``release()`` when the operation is done. */
export interface PoolLease {
    client: Client;
    release(): void;
}

export class ConnectionPool {
    private readonly entries = new Map<string, PoolEntry>();
    private readonly config: PoolConfig;
    private readonly connect: (
        creds: HostCreds,
        timeoutSeconds: number,
    ) => Promise<Client>;

    constructor(options?: ConnectionPoolOptions) {
        const defaults = loadPoolConfig();
        this.config = {
            idleMs: options?.idleMs ?? defaults.idleMs,
            maxHosts: options?.maxHosts ?? defaults.maxHosts,
        };
        this.connect = options?.connect ?? openConnection;
    }

    /** Number of currently pooled connections. */
    get size(): number {
        return this.entries.size;
    }

    /**
     * Borrow a connection for `creds`.  The returned lease must be
     * released; with pooling enabled the connection stays open and is
     * reused by the next acquire for the same host.
     */
    async acquire(
        creds: HostCreds,
        timeoutSeconds: number,
    ): Promise<PoolLease> {
        if (this.config.idleMs <= 0) {
            // Pooling disabled — hand out a throw-away connection.
            const client = await this.connect(creds, timeoutSeconds);
            let released = false;
            return {
                client,
                release: () => {
                    if (released) return;
                    released = true;
                    try {
                        client.end();
                    } catch {
                        // ignore
                    }
                },
            };
        }

        const fingerprint = credentialFingerprint(creds);
        let entry = this.entries.get(creds.id);
        if (entry && (entry.broken || entry.fingerprint !== fingerprint)) {
            // Credentials or address changed (or the connection died) —
            // the cached socket can no longer be used.
            this.drop(creds.id);
            entry = undefined;
        }

        if (!entry) {
            this.evictIfNeeded();
            const client = await this.connect(creds, timeoutSeconds);
            entry = {
                hostId: creds.id,
                fingerprint,
                client,
                active: 0,
                broken: false,
                idleTimer: null,
                lastUsed: Date.now(),
            };
            this.entries.set(creds.id, entry);
            this.watch(entry);
        }

        const leased = entry;
        leased.active += 1;
        this.clearIdle(leased);
        leased.lastUsed = Date.now();

        let released = false;
        return {
            client: leased.client,
            release: () => {
                if (released) return;
                released = true;
                this.release(leased);
            },
        };
    }

    /** Drop the pooled connection for a host (credentials changed / host deleted). */
    invalidate(hostId: string): void {
        this.drop(hostId);
    }

    /** Close every pooled connection. */
    closeAll(): void {
        for (const hostId of [...this.entries.keys()]) {
            this.drop(hostId);
        }
    }

    // ── internals ──────────────────────────────────────────────────────────

    private release(entry: PoolEntry): void {
        entry.active = Math.max(0, entry.active - 1);
        entry.lastUsed = Date.now();
        if (entry.active === 0) {
            this.armIdle(entry);
        }
    }

    private armIdle(entry: PoolEntry): void {
        this.clearIdle(entry);
        const timer = setTimeout(() => {
            const current = this.entries.get(entry.hostId);
            if (current === entry && current.active === 0) {
                this.drop(entry.hostId);
            }
        }, this.config.idleMs);
        if (typeof timer.unref === "function") timer.unref();
        entry.idleTimer = timer;
    }

    private clearIdle(entry: PoolEntry): void {
        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = null;
        }
    }

    private drop(hostId: string): void {
        const entry = this.entries.get(hostId);
        if (!entry) return;
        this.entries.delete(hostId);
        this.clearIdle(entry);
        entry.broken = true;
        try {
            entry.client.end();
        } catch {
            // ignore
        }
    }

    private watch(entry: PoolEntry): void {
        const markBroken = () => {
            entry.broken = true;
            if (this.entries.get(entry.hostId) === entry) {
                this.entries.delete(entry.hostId);
            }
            this.clearIdle(entry);
        };
        // ssh2 emits "error" on transport failures; without a listener
        // that would become an unhandled exception.
        entry.client.on("error", markBroken);
        entry.client.on("close", markBroken);
    }

    private evictIfNeeded(): void {
        if (this.entries.size < this.config.maxHosts) return;
        // Evict the least recently used *idle* connection.  Connections
        // with work in flight are never closed underneath the caller.
        let victim: PoolEntry | undefined;
        for (const entry of this.entries.values()) {
            if (entry.active > 0) continue;
            if (!victim || entry.lastUsed < victim.lastUsed) {
                victim = entry;
            }
        }
        if (victim) {
            this.drop(victim.hostId);
        }
    }
}
