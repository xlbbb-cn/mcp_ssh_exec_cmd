/**
 * MCP tool that monitors the live SSH connection pool.
 *
 * The tool answers the question "what is the server doing right
 * now?" without exposing anything sensitive:
 *
 *   - one row per host that has a pooled connection or command
 *     traffic,
 *   - the host's `uid` (the same identifier `host_list` returns) and
 *     its `sys_name` — never an address, port, user name or
 *     credential,
 *   - how many commands ran, how many of them failed, and what the
 *     last command was.
 *
 * The command lines and error messages are redacted before they are
 * rendered (see ``../redact.js``): secrets are masked and IP addresses
 * are replaced, so the table can be shown to a model or pasted into a
 * ticket without leaking credentials.
 */
import { z } from "zod";
import {
    redactHostLiterals,
    redactText,
    truncate,
} from "../redact.js";
import type {
    ConnectionPool,
    HostCommandStats,
    PoolCommandRecord,
    PoolEntryInfo,
} from "../pool.js";
import type { HostStore } from "../storage.js";
import { HOST_ID_DESCRIPTION, hostNotFoundError, type McpTool } from "./_types.js";

// ── schemas ───────────────────────────────────────────────────────────────

const poolStatusSchema = {
    host_id: z
        .string()
        .optional()
        .describe(
            HOST_ID_DESCRIPTION +
                " Omit it to get one row per host with traffic.",
        ),
    format: z
        .enum(["table", "json"])
        .optional()
        .describe(
            "'table' (default) renders a markdown table, 'json' returns " +
                "the same data as a JSON document.",
        ),
    include_history: z
        .boolean()
        .optional()
        .describe(
            "Also list the most recent commands per host. Default false.",
        ),
    include_idle_hosts: z
        .boolean()
        .optional()
        .describe(
            "Include hosts that have neither a pooled connection nor " +
                "command traffic. Default false.",
        ),
};

// ── rendering helpers ─────────────────────────────────────────────────────

/** Connection state of one host. */
type PoolState = "pooled" | "busy" | "down" | "idle" | "new";

const COLUMNS = [
    "UID",
    "SYS_NAME",
    "STATE",
    "EXECUTED",
    "FAILED",
    "LAST CMD",
    "LAST RESULT",
    "LAST ERROR",
    "LAST RUN",
    "POOL AGE",
];

/** One rendered row of the monitoring table. */
interface PoolRow {
    uid: string;
    sysName: string;
    state: PoolState;
    executed: number;
    failed: number;
    /** Redacted last command. */
    lastCommand: string;
    /** `ok` / `exit=1` / `timeout` / `error`. */
    lastResult: string;
    /** Redacted error message of the last failure. */
    lastError: string;
    /** Human readable "time since the last command". */
    lastRun: string;
    /** Age of the pooled connection. */
    poolAge: string;
    /** Redacted recent commands (oldest first). */
    recent: Array<{ command: string; result: string }>;
}

/** Format a duration in ms as `1m03s` / `12s` / `340ms`. */
function formatDuration(ms: number): string {
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
function formatClock(timestamp: number): string {
    const d = new Date(timestamp);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format "how long ago" a timestamp is. */
function formatAgo(timestamp: number, now: number): string {
    const delta = now - timestamp;
    if (delta < 1000) return "just now";
    return `${formatDuration(delta)} ago`;
}

/** Describe the outcome of one command. */
function describeResult(record: PoolCommandRecord): string {
    if (record.success) return "ok";
    if (record.error && /timed out/i.test(record.error)) return "timeout";
    if (record.exitCode !== null && record.exitCode !== undefined) {
        return `exit=${record.exitCode}`;
    }
    return "error";
}

/** Escape the characters that would break a markdown table cell. */
function cell(text: string): string {
    return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Build the row of one host. */
function buildRow(
    uid: string,
    sysName: string,
    entry: PoolEntryInfo | undefined,
    stats: HostCommandStats | undefined,
    now: number,
    literals: Array<string | null | undefined>,
): PoolRow {
    const state: PoolState = entry
        ? entry.broken
            ? "down"
            : entry.active > 0
              ? "busy"
              : "pooled"
        : stats && stats.executed > 0
          ? "idle"
          : "new";

    // The command and the error are masked once more with the host's own
    // literals (its address, its user name) on top of the generic
    // redaction.
    const mask = (text: string) => redactHostLiterals(text, literals);

    const last = stats?.lastCommand ?? null;
    return {
        uid,
        sysName,
        state,
        executed: stats?.executed ?? 0,
        failed: stats?.failed ?? 0,
        lastCommand: last ? truncate(mask(redactText(last.command)), 60) : "-",
        lastResult: last ? describeResult(last) : "-",
        lastError:
            last && last.error ? truncate(mask(redactText(last.error)), 60) : "-",
        lastRun: stats?.lastRunAt ? formatAgo(stats.lastRunAt, now) : "-",
        poolAge: entry ? formatDuration(now - entry.createdAt) : "-",
        recent: (stats?.history ?? []).map((record) => ({
            command: truncate(mask(redactText(record.command)), 60),
            result: describeResult(record),
        })),
    };
}

/** Render the rows as a markdown table. */
function renderTable(rows: PoolRow[]): string {
    const body = rows.map((row) =>
        [
            row.uid,
            row.sysName,
            row.state,
            String(row.executed),
            String(row.failed),
            row.lastCommand,
            row.lastResult,
            row.lastError,
            row.lastRun,
            row.poolAge,
        ].map(cell),
    );
    const widths = COLUMNS.map((title, i) =>
        Math.max(title.length, ...body.map((cells) => cells[i].length)),
    );
    const line = (cells: string[]) =>
        cells
            .map((value, i) => value.padEnd(widths[i]))
            .join("  ")
            .trimEnd();
    const lines = [
        line(COLUMNS),
        line(widths.map((w) => "-".repeat(w))),
        ...body.map(line),
    ];
    return lines.join("\n");
}

// ── tool factory ──────────────────────────────────────────────────────────

/**
 * Build the pool monitoring tool.
 *
 * `store` is needed to resolve the `sys_name` of a host id — the same
 * mapping `host_list` performs.  Only the id and the name are used, no
 * other host field ever reaches the output.
 */
export function buildPoolTools(
    store: HostStore,
    pool: ConnectionPool,
): McpTool[] {
    return [
        {
            name: "pool_status",
            description:
                "Monitor the live SSH connection pool of this server. " +
                "Returns one row per host with a pooled connection or " +
                "command traffic: the host uid (the same value host_list " +
                "returns), its sys_name, the connection state, how many " +
                "commands were executed, how many failed, the last " +
                "command and the last error. The table is desensitized: " +
                "secrets are masked, IP addresses are replaced and no " +
                "credential, address or user name is shown. Use it to " +
                "check whether a command actually ran and how the " +
                "connection to a host behaves.",
            schema: poolStatusSchema,
            handler: async (raw) => {
                const args = z.object(poolStatusSchema).parse(raw ?? {});
                const now = Date.now();

                const hosts = await store.listPublic();
                const names = new Map(
                    hosts.map((h) => [h.id, h.system_name || h.id]),
                );
                // The address and the user name of a host are masked in
                // every text the table echoes — they are metadata the
                // MCP surface never publishes.
                const literals = new Map(
                    hosts.map((h) => [
                        h.id,
                        [h.ip_address, h.ssh_username],
                    ]),
                );
                if (args.host_id && !names.has(args.host_id)) {
                    throw hostNotFoundError(args.host_id);
                }

                const entries = new Map(
                    pool.snapshot().map((entry) => [entry.hostId, entry]),
                );
                const stats = new Map(
                    pool.commandStatsSnapshot().map((s) => [s.hostId, s]),
                );

                const ids = new Set<string>([
                    ...entries.keys(),
                    ...stats.keys(),
                ]);
                if (args.include_idle_hosts) {
                    for (const host of hosts) ids.add(host.id);
                }
                if (args.host_id) ids.add(args.host_id);

                const rows = [...ids]
                    .map((id) =>
                        buildRow(
                            id,
                            names.get(id) ?? id,
                            entries.get(id),
                            stats.get(id),
                            now,
                            literals.get(id) ?? [],
                        ),
                    )
                    .sort(
                        (a, b) =>
                            b.executed - a.executed ||
                            a.sysName.localeCompare(b.sysName),
                    );

                const limits = pool.limits;
                const executed = rows.reduce((sum, r) => sum + r.executed, 0);
                const failed = rows.reduce((sum, r) => sum + r.failed, 0);

                if (args.format === "json") {
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    {
                                        generated_at: new Date(now).toISOString(),
                                        pool: {
                                            size: entries.size,
                                            max_hosts: limits.maxHosts,
                                            idle_ms: limits.idleMs,
                                        },
                                        totals: {
                                            hosts: rows.length,
                                            executed,
                                            failed,
                                        },
                                        hosts: rows.map((row) => ({
                                            uid: row.uid,
                                            sys_name: row.sysName,
                                            state: row.state,
                                            executed: row.executed,
                                            failed: row.failed,
                                            last_command: row.lastCommand,
                                            last_result: row.lastResult,
                                            last_error: row.lastError,
                                            last_run: row.lastRun,
                                            pool_age: row.poolAge,
                                            ...(args.include_history
                                                ? { recent: row.recent }
                                                : {}),
                                        })),
                                    },
                                    null,
                                    2,
                                ),
                            },
                        ],
                    };
                }

                const lines: string[] = [];
                lines.push(
                    `SSH connection pool · ${entries.size}/${limits.maxHosts} connections · ` +
                        `idle timeout ${formatDuration(limits.idleMs)} · ` +
                        `${executed} commands executed · ${failed} failed · ` +
                        `updated ${formatClock(now)}`,
                );
                lines.push(
                    "Commands and error messages are desensitized " +
                        "(secrets masked, IP addresses replaced).",
                );
                lines.push("");
                if (rows.length === 0) {
                    lines.push(
                        "No host has a pooled connection or command traffic yet.",
                    );
                } else {
                    lines.push(renderTable(rows));
                }

                if (args.include_history) {
                    const withHistory = rows.filter((r) => r.recent.length > 0);
                    lines.push("");
                    if (withHistory.length === 0) {
                        lines.push("No command has been executed yet.");
                    } else {
                        lines.push("Recent commands:");
                        for (const row of withHistory) {
                            lines.push(
                                `  ${row.sysName} (${row.uid}): ` +
                                    row.recent
                                        .map(
                                            (r) =>
                                                `${r.result} \`${r.command}\``,
                                        )
                                        .join(" · "),
                            );
                        }
                    }
                }

                return {
                    content: [{ type: "text", text: lines.join("\n") }],
                };
            },
        },
    ];
}
