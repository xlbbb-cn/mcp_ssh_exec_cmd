/**
 * Live monitor for the SSH connection pool.
 *
 * The monitor keeps a :class:`ConnectionPool` warm, probes every enabled
 * host once per refresh interval and renders a table with the state of
 * each pooled connection:
 *
 *   - **status** — `up` (the probe command succeeded), `down` (the
 *     connection failed) or `disabled` (the host is switched off).
 *   - **latency** — how long the probe took, end to end.
 *   - **pool** — the age of the pooled connection, i.e. how long the
 *     session has been reused without being re-established.
 *
 * The screen is redrawn every ``intervalMs`` milliseconds (one second by
 * default) and the user leaves the view with the ``q`` key (Ctrl+C works
 * as well).
 *
 * The monitor is deliberately decoupled from the storage layer: the
 * caller supplies the hosts and a *probe* function, which keeps the
 * rendering logic testable without a real SSH server.
 */
import type { ConnectionPool } from "./pool.js";
import { runCommand } from "./ssh.js";
import type { HostCreds } from "./types.js";

/** Default redraw interval — one frame per second. */
export const DEFAULT_INTERVAL_MS = 1000;

/** Default per-host probe timeout in seconds. */
export const DEFAULT_PROBE_TIMEOUT_S = 5;

/**
 * Default probe command.  ``echo`` exists both in a POSIX shell and in
 * ``cmd.exe``, so the probe works on Windows and Linux hosts alike.
 */
export const DEFAULT_PROBE_COMMAND = "echo";

/** The subset of a host record the monitor needs. */
export interface MonitorHost {
    id: string;
    system_name: string;
    ip_address: string;
    ssh_port: number;
    ssh_username: string;
    is_enable: boolean;
}

/** Connection state of one monitored host. */
export type MonitorStatus = "pending" | "up" | "down" | "disabled";

/** Live state of one monitored host. */
export interface MonitorHostState {
    host: MonitorHost;
    status: MonitorStatus;
    /** Duration of the last probe in ms (`null` before the first probe). */
    latencyMs: number | null;
    /** Timestamp of the last probe. */
    lastCheckedAt: number | null;
    /** Timestamp of the last successful probe. */
    lastOkAt: number | null;
    /** Error message of the last failed probe. */
    error: string | null;
    /** Number of probes performed. */
    checks: number;
    /** Number of failed probes. */
    failures: number;
    /** Age of the pooled connection in ms (`null` when there is none). */
    pooledForMs: number | null;
    /** Number of pool operations currently in flight for this host. */
    activeOps: number;
}

/** Everything the renderer needs for one frame. */
export interface MonitorFrame {
    /** 1-based number of the rendered frame. */
    tick: number;
    /** Timestamp of the frame. */
    updatedAt: number;
    /** Configured redraw interval in ms. */
    intervalMs: number;
    /** Duration of the last tick in ms. */
    tickMs: number;
    /** Configured per-host probe timeout in seconds. */
    probeTimeoutSeconds: number;
    /** Number of pooled connections. */
    poolSize: number;
    /** Maximum number of pooled connections. */
    poolMaxHosts: number;
    /** Idle timeout of the pool in ms. */
    poolIdleMs: number;
    /** Per-host states. */
    hosts: MonitorHostState[];
}

/** Result of a single probe. */
export interface ProbeOutcome {
    ok: boolean;
    /** How long the probe took, in ms. */
    latencyMs: number;
    /** Failure reason (only meaningful when ``ok`` is false). */
    error?: string | null;
}

/** Probes one host and reports whether it is reachable. */
export type ProbeFn = (host: MonitorHost) => Promise<ProbeOutcome>;

export interface PoolMonitorOptions {
    /** Hosts to monitor (disabled ones are shown but not probed). */
    hosts: MonitorHost[];
    /** Probes a single host. */
    probe: ProbeFn;
    /** Redraw interval in ms. Defaults to {@link DEFAULT_INTERVAL_MS}. */
    intervalMs?: number;
    /** Per-host probe timeout in seconds (shown in the header). */
    probeTimeoutSeconds?: number;
    /** The pool to watch — its size and entries are rendered. */
    pool?: ConnectionPool;
    /** Where the frames are written. Defaults to stdout. */
    write?: (chunk: string) => void;
    /** Clear the screen before every frame. Defaults to stdout being a TTY. */
    clearScreen?: boolean;
    /** Render a single frame and return instead of looping. */
    once?: boolean;
    /** Terminal width used for the layout. Defaults to stdout's width. */
    width?: number;
}

// ── formatting helpers ─────────────────────────────────────────────────────

/** Shorten `text` to `width` characters, marking the cut with an ellipsis. */
export function truncate(text: string, width: number): string {
    if (width <= 0) return "";
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length <= width) return clean;
    if (width === 1) return "…";
    return `${clean.slice(0, width - 1)}…`;
}

/** Format a duration in ms as `1m03s` / `12s` / `340ms`. */
export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return "-";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const totalSeconds = Math.floor(ms / 1000);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60);
    if (minutes === 0) return `${seconds}s`;
    const hours = Math.floor(minutes / 60);
    if (hours === 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
    return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Format a timestamp as `HH:MM:SS`. */
export function formatClock(timestamp: number): string {
    const d = new Date(timestamp);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const COLUMN_TITLES = [
    "HOST",
    "ADDRESS",
    "USER",
    "STATUS",
    "LATENCY",
    "LAST OK",
    "POOL",
];

/** Minimum width of a column before it is squeezed. */
const MIN_COLUMN_WIDTH = 4;

/**
 * Compute the width of every column: the natural width of the content,
 * shrunk column by column until the table fits into `available`.
 */
function layoutColumns(
    rows: string[][],
    available: number,
): number[] {
    const widths = COLUMN_TITLES.map((title, i) =>
        Math.max(
            title.length,
            ...rows.map((row) => (row[i] ?? "").length),
            MIN_COLUMN_WIDTH,
        ),
    );
    const gap = 2;
    const total = () =>
        widths.reduce((sum, w) => sum + w, 0) + gap * (widths.length - 1);

    // Squeeze the widest column until the table fits.
    let guard = 0;
    while (total() > available && guard < 1000) {
        guard += 1;
        let widest = 0;
        for (let i = 1; i < widths.length; i += 1) {
            if (widths[i] > widths[widest]) widest = i;
        }
        if (widths[widest] <= MIN_COLUMN_WIDTH) break;
        widths[widest] -= 1;
    }
    return widths;
}

/** Render one frame of the monitor as a block of text. */
export function formatMonitorFrame(
    frame: MonitorFrame,
    width = 100,
): string {
    const available = Math.max(40, width);
    const rows = frame.hosts.map((state) => [
        state.host.system_name || state.host.id,
        `${state.host.ip_address}:${state.host.ssh_port}`,
        state.host.ssh_username,
        state.status,
        state.latencyMs === null ? "-" : `${state.latencyMs}ms`,
        state.lastOkAt === null ? "-" : formatClock(state.lastOkAt),
        state.pooledForMs === null ? "-" : formatDuration(state.pooledForMs),
    ]);

    const widths = layoutColumns(rows, available);
    const line = (cells: string[]) =>
        cells
            .map((cell, i) => truncate(cell, widths[i]).padEnd(widths[i]))
            .join("  ")
            .trimEnd();

    const lines: string[] = [];
    lines.push(
        `SSH connection pool monitor · ${formatClock(frame.updatedAt)} · tick ${frame.tick} · refresh ${frame.intervalMs}ms · last tick ${frame.tickMs}ms`,
    );
    lines.push(
        `pool ${frame.poolSize}/${frame.poolMaxHosts} connections · idle timeout ${formatDuration(frame.poolIdleMs)} · probe timeout ${frame.probeTimeoutSeconds}s · press q to quit`,
    );
    lines.push("");
    lines.push(line(COLUMN_TITLES));
    lines.push(line(widths.map((w) => "-".repeat(w))));
    for (const row of rows) {
        lines.push(line(row));
    }

    const problems = frame.hosts.filter(
        (s) => s.status === "down" && s.error,
    );
    if (problems.length > 0) {
        lines.push("");
        lines.push(`problems (${problems.length}):`);
        for (const problem of problems) {
            const label = `${problem.host.system_name || problem.host.id} (${problem.host.ip_address}:${problem.host.ssh_port})`;
            const indent = "  ";
            const room = Math.max(10, available - indent.length);
            lines.push(`${indent}${truncate(label, room)}: ${truncate(problem.error ?? "", room)}`);
        }
    }

    return lines.join("\n");
}

// ── the default SSH probe ──────────────────────────────────────────────────

export interface SshProbeOptions {
    /** Resolves the (decrypted) credentials of a host. */
    getCreds: (hostId: string) => Promise<HostCreds | null>;
    /** The pool the probe should use. */
    pool?: ConnectionPool;
    /** Per-probe timeout in seconds. */
    timeoutSeconds: number;
    /** The command executed on the remote host. */
    command: string;
}

/**
 * Build a probe that runs a command on the host through the connection
 * pool.  A failed probe never throws — the error is reported as the
 * outcome instead.
 */
export function createSshProbe(options: SshProbeOptions): ProbeFn {
    return async (host: MonitorHost): Promise<ProbeOutcome> => {
        const creds = await options.getCreds(host.id);
        if (!creds) {
            return { ok: false, latencyMs: 0, error: "host not found in the store" };
        }
        const started = Date.now();
        try {
            const result = await runCommand(creds, options.command, {
                pool: options.pool,
                timeoutSeconds: options.timeoutSeconds,
            });
            const latencyMs = Date.now() - started;
            if (result.success) {
                return { ok: true, latencyMs };
            }
            const reason = (
                result.stderr || `command exited with code ${result.exit_code}`
            ).trim();
            return { ok: false, latencyMs, error: reason };
        } catch (err) {
            return {
                ok: false,
                latencyMs: Date.now() - started,
                error: (err as Error).message,
            };
        }
    };
}

// ── keyboard handling ──────────────────────────────────────────────────────

/**
 * Listen for the quit key.  ``q`` (and Ctrl+C) stop the monitor; the
 * terminal is put back into its normal mode afterwards.
 */
function attachQuitKeys(onQuit: () => void): () => void {
    const stdin = process.stdin;
    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
        // Not an interactive terminal — there is no key to read.
        return () => {};
    }

    const onData = (chunk: Buffer) => {
        // 0x03 = Ctrl+C (raw mode swallows the signal).
        if (chunk.includes(0x03)) {
            onQuit();
            return;
        }
        const text = chunk.toString("utf8");
        if (text.includes("q") || text.includes("Q")) {
            onQuit();
        }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);

    const onSigint = () => onQuit();
    process.on("SIGINT", onSigint);

    return () => {
        stdin.removeListener("data", onData);
        process.removeListener("SIGINT", onSigint);
        try {
            stdin.setRawMode(false);
        } catch {
            // ignore
        }
        stdin.pause();
    };
}

// ── the monitor loop ───────────────────────────────────────────────────────

/**
 * Run the monitor until the user presses ``q``.
 *
 * Returns the process exit code (0 on a clean stop).
 */
export async function runPoolMonitor(
    options: PoolMonitorOptions,
): Promise<number> {
    const intervalMs = Math.max(50, options.intervalMs ?? DEFAULT_INTERVAL_MS);
    const probeTimeoutSeconds =
        options.probeTimeoutSeconds ?? DEFAULT_PROBE_TIMEOUT_S;
    const write =
        options.write ?? ((chunk: string) => void process.stdout.write(chunk));
    const clearScreen =
        options.clearScreen ?? Boolean(process.stdout.isTTY);
    const width = options.width ?? process.stdout.columns ?? 100;

    const states = new Map<string, MonitorHostState>();
    for (const host of options.hosts) {
        states.set(host.id, {
            host,
            status: host.is_enable ? "pending" : "disabled",
            latencyMs: null,
            lastCheckedAt: null,
            lastOkAt: null,
            error: null,
            checks: 0,
            failures: 0,
            pooledForMs: null,
            activeOps: 0,
        });
    }

    if (states.size === 0) {
        write("No hosts to monitor.\n");
        return 0;
    }

    let quitting = false;
    let wake: (() => void) | null = null;

    const requestQuit = () => {
        if (quitting) return;
        quitting = true;
        wake?.();
    };

    const detachKeys = attachQuitKeys(requestQuit);

    const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                wake = null;
                resolve();
            }, ms);
            wake = () => {
                clearTimeout(timer);
                wake = null;
                resolve();
            };
        });

    let tick = 0;
    let lastTickMs = 0;
    const render = () => {
        const pool = options.pool;
        const limits = pool?.limits ?? { idleMs: 0, maxHosts: 0 };
        const entries = pool?.snapshot() ?? [];
        const byHost = new Map(entries.map((e) => [e.hostId, e]));
        const now = Date.now();
        for (const state of states.values()) {
            const entry = byHost.get(state.host.id);
            state.pooledForMs = entry ? now - entry.createdAt : null;
            state.activeOps = entry?.active ?? 0;
        }
        tick += 1;
        const frame: MonitorFrame = {
            tick,
            updatedAt: now,
            intervalMs,
            tickMs: lastTickMs,
            probeTimeoutSeconds,
            poolSize: entries.length,
            poolMaxHosts: limits.maxHosts,
            poolIdleMs: limits.idleMs,
            hosts: [...states.values()],
        };
        if (clearScreen) write("\u001b[2J\u001b[3J\u001b[H");
        write(`${formatMonitorFrame(frame, width)}\n`);
    };

    const runProbes = async () => {
        const targets = options.hosts.filter((h) => h.is_enable);
        await Promise.all(
            targets.map(async (host) => {
                const state = states.get(host.id);
                if (!state) return;
                try {
                    const outcome = await options.probe(host);
                    state.checks += 1;
                    state.latencyMs = outcome.latencyMs;
                    state.lastCheckedAt = Date.now();
                    if (outcome.ok) {
                        state.status = "up";
                        state.error = null;
                        state.lastOkAt = state.lastCheckedAt;
                    } else {
                        state.status = "down";
                        state.error = outcome.error ?? "probe failed";
                        state.failures += 1;
                    }
                } catch (err) {
                    state.checks += 1;
                    state.failures += 1;
                    state.lastCheckedAt = Date.now();
                    state.status = "down";
                    state.error = (err as Error).message;
                }
            }),
        );
    };

    const tickOnce = async () => {
        const started = Date.now();
        await runProbes();
        lastTickMs = Date.now() - started;
        render();
    };

    try {
        await tickOnce();
        if (options.once) return 0;
        while (!quitting) {
            await sleep(intervalMs);
            if (quitting) break;
            await tickOnce();
        }
    } finally {
        detachKeys();
    }

    write("\nMonitor stopped.\n");
    return 0;
}
