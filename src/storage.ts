/**
 * Persistent storage for SSH host records.
 *
 * The on-disk file is a single JSON document containing a list of
 * :class:`HostRecord` objects.  Reads are cached in memory; writes
 * rewrite the whole file atomically (write to ``.tmp`` + rename) so a
 * crash never leaves a partial file behind.
 *
 * Sensitive fields are encrypted via :mod:`./crypto` using the
 * process-wide master key.  The file is created with mode 0o600 on
 * POSIX so it is only readable by the owning user.
 *
 * The encrypted fields are ``ssh_password``, ``ssh_private_key`` and
 * ``ssh_private_key_passphrase``; everything else is stored in clear
 * text.
 */
import { randomUUID } from "node:crypto";
import {
    chmod,
    mkdir,
    readFile,
    rename,
    writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { encryptSecret, decryptSecret } from "./crypto.js";
import { getHostsFilePath } from "./paths.js";
import type {
    HostCreds,
    HostInput,
    HostPublic,
    HostRecord,
} from "./types.js";

interface StoreShape {
    version: 1;
    hosts: HostRecord[];
}

/** Reject ports that would fail later with a confusing connect error. */
function validatePort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(
            `ssh_port must be an integer between 1 and 65535 (got ${String(port)})`,
        );
    }
}

export class HostStore {
    private master: Buffer;
    private cache: HostRecord[] = [];
    private loaded = false;

    constructor(master: Buffer) {
        this.master = master;
    }

    // ── file I/O ───────────────────────────────────────────────────────────

    private async ensureLoaded(): Promise<void> {
        if (this.loaded) return;
        const filePath = getHostsFilePath();
        if (!existsSync(filePath)) {
            this.cache = [];
            this.loaded = true;
            return;
        }
        const raw = await readFile(filePath, "utf8");
        try {
            const parsed = JSON.parse(raw) as StoreShape;
            if (
                !parsed ||
                typeof parsed !== "object" ||
                !Array.isArray(parsed.hosts)
            ) {
                throw new Error("hosts file is malformed: missing 'hosts' array");
            }
            this.cache = parsed.hosts;
        } catch (err) {
            throw new Error(
                `failed to parse ${filePath}: ${(err as Error).message}`,
            );
        }
        this.loaded = true;
    }

    private async persist(): Promise<void> {
        const filePath = getHostsFilePath();
        await mkdir(dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp`;
        const body: StoreShape = { version: 1, hosts: this.cache };
        await writeFile(tmp, JSON.stringify(body, null, 2), {
            mode: 0o600,
        });
        if (process.platform !== "win32") {
            try {
                await chmod(tmp, 0o600);
            } catch {
                // best effort
            }
        }
        await rename(tmp, filePath);
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private toPublic(rec: HostRecord): HostPublic {
        return {
            id: rec.id,
            ip_address: rec.ip_address,
            system_name: rec.system_name,
            ssh_port: rec.ssh_port,
            ssh_username: rec.ssh_username,
            ssh_auth_method: rec.ssh_auth_method,
            is_enable: rec.is_enable,
            created_at: rec.created_at,
            updated_at: rec.updated_at,
        };
    }

    private toCreds(rec: HostRecord): HostCreds {
        return {
            id: rec.id,
            ip_address: rec.ip_address,
            system_name: rec.system_name,
            ssh_port: rec.ssh_port,
            ssh_username: rec.ssh_username,
            ssh_auth_method: rec.ssh_auth_method,
            ssh_password: rec.ssh_password
                ? decryptSecret(rec.ssh_password, this.master)
                : "",
            ssh_private_key: rec.ssh_private_key
                ? decryptSecret(rec.ssh_private_key, this.master)
                : "",
            ssh_private_key_passphrase: rec.ssh_private_key_passphrase
                ? decryptSecret(rec.ssh_private_key_passphrase, this.master)
                : "",
            is_enable: rec.is_enable,
        };
    }

    private nowIso(): string {
        return new Date().toISOString();
    }

    // ── CRUD ───────────────────────────────────────────────────────────────

    async listPublic(): Promise<HostPublic[]> {
        await this.ensureLoaded();
        return this.cache.map((r) => this.toPublic(r));
    }

    async getPublicById(id: string): Promise<HostPublic | null> {
        await this.ensureLoaded();
        const rec = this.cache.find((r) => r.id === id);
        return rec ? this.toPublic(rec) : null;
    }

    async getCredsById(id: string): Promise<HostCreds | null> {
        await this.ensureLoaded();
        const rec = this.cache.find((r) => r.id === id);
        return rec ? this.toCreds(rec) : null;
    }

    async create(
        input: HostInput,
        options: { dryRun?: boolean } = {},
    ): Promise<HostPublic> {
        await this.ensureLoaded();
        if (!input.ip_address) {
            throw new Error("ip_address is required");
        }
        if (this.cache.some((r) => r.ip_address === input.ip_address)) {
            throw new Error(
                `host with ip_address '${input.ip_address}' already exists`,
            );
        }
        const authMethod = input.ssh_auth_method ?? "password";
        if (authMethod !== "password" && authMethod !== "pubkey") {
            throw new Error("ssh_auth_method must be 'password' or 'pubkey'");
        }
        if (authMethod === "password" && !input.ssh_password) {
            throw new Error("ssh_password is required for auth_method=password");
        }
        if (authMethod === "pubkey" && !input.ssh_private_key) {
            throw new Error("ssh_private_key is required for auth_method=pubkey");
        }
        const port = input.ssh_port ?? 22;
        validatePort(port);
        const now = this.nowIso();
        const rec: HostRecord = {
            id: randomUUID(),
            ip_address: input.ip_address,
            system_name: input.system_name ?? "",
            ssh_port: port,
            ssh_username: input.ssh_username ?? "root",
            ssh_auth_method: authMethod,
            ssh_password: input.ssh_password
                ? encryptSecret(input.ssh_password, this.master)
                : "",
            ssh_private_key: input.ssh_private_key
                ? encryptSecret(input.ssh_private_key, this.master)
                : "",
            ssh_private_key_passphrase: input.ssh_private_key_passphrase
                ? encryptSecret(input.ssh_private_key_passphrase, this.master)
                : "",
            is_enable: input.is_enable ?? true,
            created_at: now,
            updated_at: now,
        };
        if (options.dryRun) {
            // Validate-only: report what would be created without
            // touching the store or the file on disk.
            return this.toPublic(rec);
        }
        this.cache.push(rec);
        await this.persist();
        return this.toPublic(rec);
    }

    async update(
        id: string,
        patch: Partial<HostInput>,
    ): Promise<HostPublic | null> {
        await this.ensureLoaded();
        const idx = this.cache.findIndex((r) => r.id === id);
        if (idx < 0) return null;
        const current = this.cache[idx];

        // Detect if the user wants to flip auth methods; that requires
        // matching credential to be supplied.
        const nextAuth = patch.ssh_auth_method ?? current.ssh_auth_method;
        if (nextAuth !== "password" && nextAuth !== "pubkey") {
            throw new Error("ssh_auth_method must be 'password' or 'pubkey'");
        }

        if (patch.ip_address && patch.ip_address !== current.ip_address) {
            if (this.cache.some((r) => r.ip_address === patch.ip_address)) {
                throw new Error(
                    `host with ip_address '${patch.ip_address}' already exists`,
                );
            }
        }

        const port = patch.ssh_port ?? current.ssh_port;
        validatePort(port);

        const updated: HostRecord = {
            ...current,
            ip_address: patch.ip_address ?? current.ip_address,
            system_name:
                patch.system_name !== undefined
                    ? patch.system_name
                    : current.system_name,
            ssh_port: port,
            ssh_username: patch.ssh_username ?? current.ssh_username,
            ssh_auth_method: nextAuth,
            is_enable: patch.is_enable ?? current.is_enable,
            updated_at: this.nowIso(),
        };

        if (patch.ssh_password !== undefined) {
            updated.ssh_password = patch.ssh_password
                ? encryptSecret(patch.ssh_password, this.master)
                : "";
        }
        if (patch.ssh_private_key !== undefined) {
            updated.ssh_private_key = patch.ssh_private_key
                ? encryptSecret(patch.ssh_private_key, this.master)
                : "";
        }
        if (patch.ssh_private_key_passphrase !== undefined) {
            updated.ssh_private_key_passphrase = patch.ssh_private_key_passphrase
                ? encryptSecret(patch.ssh_private_key_passphrase, this.master)
                : "";
        }

        // Final sanity: the auth method's required credential must be set
        // (either kept from before or freshly supplied in this patch).
        if (updated.ssh_auth_method === "password" && !updated.ssh_password) {
            throw new Error(
                "ssh_password is required when ssh_auth_method=password",
            );
        }
        if (updated.ssh_auth_method === "pubkey" && !updated.ssh_private_key) {
            throw new Error(
                "ssh_private_key is required when ssh_auth_method=pubkey",
            );
        }

        this.cache[idx] = updated;
        await this.persist();
        return this.toPublic(updated);
    }

    async delete(id: string): Promise<boolean> {
        await this.ensureLoaded();
        const before = this.cache.length;
        this.cache = this.cache.filter((r) => r.id !== id);
        if (this.cache.length === before) return false;
        await this.persist();
        return true;
    }
}
