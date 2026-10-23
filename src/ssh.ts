/**
 * SSH client wrapper — the Node.js equivalent of
 * ``app.utils.ssh_helper`` in the Python project.
 *
 * Backed by the ``ssh2`` package (pure-JS, no external binaries),
 * which gives us a uniform code path on Linux, macOS and Windows.
 *
 * Public API
 * ──────────
 * - :class:`ConnectionPool` (see ``./pool.js``) — reuses one connection
 *   per host across commands.
 * - :func:`runCommand`               — single non-interactive command
 * - :func:`runInteractiveCommand`    — command that consumes one or
 *                                       more ``expect/answer`` pairs
 * - :func:`runPlaybook`               — runs a list of steps parsed
 *                                       from a playbook body
 *
 * Each public function returns a :class:`CommandResult` and never
 * throws for "expected" failures (auth rejected, command not found,
 * non-zero exit code, …).  Unexpected programmer errors propagate
 * so the MCP dispatcher can decide how to surface them.
 *
 * Timeouts
 * ────────
 * ``timeoutSeconds`` is a **hard cap**: a command that is still running
 * when the cap expires is terminated and reported as
 * ``success: false`` / ``exit_code: null`` with a note in ``stderr``.
 * For playbooks the cap applies to the whole playbook — each step only
 * gets the time that is left.
 */
import type { Client } from "ssh2";
import {
    ConnectionPool,
    SshConnectionError,
    openConnection,
    type PoolLease,
} from "./pool.js";
import type { CommandResult, ExpectAnswer, HostCreds } from "./types.js";

export { SshConnectionError };

const DEFAULT_TIMEOUT_S = 30;

export interface SshRunnerOptions {
    /** Hard cap for the operation, in seconds. */
    timeoutSeconds?: number;
    /** Optional connection pool; when omitted a throw-away connection is used. */
    pool?: ConnectionPool;
}

// ── low-level execution helpers ───────────────────────────────────────────

/**
 * Run `command` on an already-open connection and resolve with the
 * result.  The command is terminated when `timeoutSeconds` elapses.
 */
export function execOnClient(
    client: Client,
    command: string,
    timeoutSeconds: number,
): Promise<CommandResult> {
    const started = Date.now();
    return new Promise<CommandResult>((resolve, reject) => {
        client.exec(command, { pty: false }, (err, stream) => {
            if (err) {
                reject(err);
                return;
            }
            let stdout = "";
            let stderr = "";
            let settled = false;
            let timer: NodeJS.Timeout | null = null;

            const finish = (code: number | null, timedOut: boolean): void => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (timedOut) {
                    try {
                        stream.close();
                    } catch {
                        // ignore
                    }
                    stderr += `\n[mcp-ssh] command timed out after ${timeoutSeconds}s`;
                }
                resolve({
                    command,
                    stdout,
                    stderr,
                    exit_code: timedOut ? null : code,
                    success: !timedOut && code === 0,
                    duration_ms: Date.now() - started,
                });
            };

            timer = setTimeout(
                () => finish(null, true),
                Math.max(1, timeoutSeconds) * 1000,
            );

            stream
                .on("close", (code: number | null) => finish(code, false))
                .on("data", (data: Buffer) => {
                    stdout += data.toString("utf8");
                });
            stream.stderr.on("data", (data: Buffer) => {
                stderr += data.toString("utf8");
            });
        });
    });
}

/**
 * Run `command` on an already-open connection and feed back `expects`
 * in order.
 *
 * The implementation is a simple state machine over the shell
 * stream's output buffer: every time data arrives we look for the
 * next expect pattern; once it matches, we write the corresponding
 * answer (with a trailing newline).  The stream is closed when:
 *   - the server exits (``close`` event), or
 *   - the timeout elapses (hard cap).
 *
 * Mirrors the behaviour of :func:`app.utils.ssh_helper.run_interactive_command`
 * — the model supplies the same shape of input.
 */
export function shellOnClient(
    client: Client,
    command: string,
    expects: ExpectAnswer[],
    timeoutSeconds: number,
): Promise<CommandResult> {
    const started = Date.now();
    return new Promise<CommandResult>((resolve, reject) => {
        // `ssh2` uses PseudoTtyOptions for an allocated PTY; passing
        // `{ rows, cols, term }` is the standard incantation for an
        // xterm-sized PTY.  sudo and similar tools require a PTY
        // because they check `isatty(stdout)`.
        client.shell({ rows: 24, cols: 80, term: "xterm-256color" }, (err, stream) => {
            if (err) {
                reject(err);
                return;
            }
            let stdout = "";
            let stderr = "";
            let expectIdx = 0;
            let settled = false;
            let timer: NodeJS.Timeout | null = null;

            const finish = (code: number | null, timedOut: boolean): void => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (timedOut) {
                    try {
                        stream.close();
                    } catch {
                        // ignore
                    }
                    stderr += `\n[mcp-ssh] command timed out after ${timeoutSeconds}s`;
                }
                resolve({
                    command,
                    stdout,
                    stderr,
                    exit_code: timedOut ? null : code,
                    success: !timedOut && code === 0,
                    duration_ms: Date.now() - started,
                });
            };

            timer = setTimeout(
                () => finish(null, true),
                Math.max(1, timeoutSeconds) * 1000,
            );

            stream
                .on("close", (code: number | null) => finish(code, false))
                .on("data", (data: Buffer) => {
                    const text = data.toString("utf8");
                    stdout += text;
                    // Try to match the next expect.
                    while (expectIdx < expects.length) {
                        const exp = expects[expectIdx];
                        if (exp.expect && stdout.includes(exp.expect)) {
                            stream.write(`${exp.answer}\n`);
                            stderr += `[wrote answer for expect #${expectIdx + 1}]\n`;
                            expectIdx += 1;
                        } else {
                            break;
                        }
                    }
                })
                .stderr.on("data", (data: Buffer) => {
                    stderr += data.toString("utf8");
                });

            stream.write(`${command}\n`);
        });
    });
}

/**
 * True when the failure means "the connection is gone" and the command
 * therefore deserves a retry on a fresh connection.  Authentication
 * failures are explicitly excluded — retrying them only doubles the
 * delay before the same error.
 */
function isConnectionFailure(err: unknown): boolean {
    const parts: string[] = [];
    if (err instanceof SshConnectionError) {
        parts.push(err.message);
        if (err.cause instanceof Error) parts.push(err.cause.message);
    } else if (err instanceof Error) {
        parts.push(err.message);
    }
    const message = parts.join(" | ");
    if (/authentication|auth method|publickey|password/i.test(message)) {
        return false;
    }
    return /not connected|connection closed|socket closed|closed before ready|econnreset|epipe|econnrefused/i.test(
        message,
    );
}

/**
 * Describe why a command failed.  Used for the command statistics the
 * pool keeps (and which the monitoring tool reports).
 */
function failureReason(result: CommandResult): string {
    const stderr = result.stderr?.trim();
    if (stderr) return stderr;
    if (result.exit_code === null) return "command did not produce an exit code";
    return `command exited with code ${result.exit_code}`;
}

/**
 * Run `fn` with a connection for `creds`.  Uses the pool when one is
 * supplied, otherwise opens (and closes) a dedicated connection.
 *
 * A connection-level failure is retried once on a fresh connection —
 * a pooled socket may have been closed by the peer while it was idle.
 *
 * Every command is reported to the pool so that the monitoring tool can
 * show what ran on which host.
 */
async function runWithConnection(
    creds: HostCreds,
    command: string,
    timeoutSeconds: number,
    options: SshRunnerOptions,
    fn: (client: Client) => Promise<CommandResult>,
): Promise<CommandResult> {
    const pool = options.pool;
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
        let lease: PoolLease | null = null;
        let client: Client | null = null;
        const started = Date.now();
        try {
            if (pool) {
                lease = await pool.acquire(creds, timeoutSeconds);
                client = lease.client;
            } else {
                client = await openConnection(creds, timeoutSeconds);
            }
            const result = await fn(client);
            pool?.recordCommand(creds.id, {
                command: result.command,
                success: result.success,
                exitCode: result.exit_code,
                error: result.success ? null : failureReason(result),
                durationMs: result.duration_ms,
            });
            return result;
        } catch (err) {
            lastError = err;
            if (attempt === 0 && isConnectionFailure(err)) {
                // The retry may still succeed, so the failure is only
                // recorded once the command really gave up.
                if (pool) pool.invalidate(creds.id);
                continue;
            }
            pool?.recordCommand(creds.id, {
                command,
                success: false,
                exitCode: null,
                error: (err as Error).message ?? String(err),
                durationMs: Date.now() - started,
            });
            throw err;
        } finally {
            if (!pool && client) {
                try {
                    client.end();
                } catch {
                    // ignore
                }
            }
            lease?.release();
        }
    }

    throw lastError;
}

// ── non-interactive command ───────────────────────────────────────────────

export async function runCommand(
    creds: HostCreds,
    command: string,
    options: SshRunnerOptions = {},
): Promise<CommandResult> {
    const timeout = options.timeoutSeconds ?? DEFAULT_TIMEOUT_S;
    return runWithConnection(
        creds,
        command,
        timeout,
        options,
        (client) => execOnClient(client, command, timeout),
    );
}

// ── interactive command (expect/answer) ───────────────────────────────────

export async function runInteractiveCommand(
    creds: HostCreds,
    command: string,
    expects: ExpectAnswer[],
    options: SshRunnerOptions = {},
): Promise<CommandResult> {
    const timeout = options.timeoutSeconds ?? DEFAULT_TIMEOUT_S;
    return runWithConnection(
        creds,
        command,
        timeout,
        options,
        (client) => shellOnClient(client, command, expects, timeout),
    );
}

// ── playbook runner ───────────────────────────────────────────────────────

/**
 * Parse a playbook body into individual steps.
 *
 * Supports the same two formats the Python side accepts:
 *
 *  1. Structured: lines starting with ``# @section "…"``,
 *     ``# @desc "…"``, ``# @note "…"``, ``# @danger "…"``,
 *     ``# @on "<command>"`` are directives (section metadata,
 *     interactive commands).  Plain lines are regular commands.
 *  2. Legacy: one command per line; an interactive line can be
 *     followed by ``expect: <text>`` and ``answer: <text>`` pairs.
 *
 * Returns an ordered list of steps the caller can dispatch one-by-one.
 */
export interface ParsedStep {
    command: string;
    expects: ExpectAnswer[];
}

export function parsePlaybook(body: string): ParsedStep[] {
    const lines = body.split(/\r?\n/);
    const steps: ParsedStep[] = [];
    let i = 0;
    while (i < lines.length) {
        const raw = lines[i];
        const line = raw.trim();
        if (!line) {
            i += 1;
            continue;
        }

        // # @on "<command>" — interactive command with optional inline
        // expect/answer pairs in subsequent lines, same syntax as legacy.
        // NOTE: must be checked BEFORE the generic ``line.startsWith("#")``
        // comment skip, otherwise the directive would be silently dropped.
        if (line.startsWith("# @on ")) {
            const m = line.match(/^# @on\s+["'](.+?)["']\s*$/);
            if (m) {
                const scan = scanExpectAnswers(lines, i + 1);
                steps.push({ command: m[1], expects: scan.expects });
                // skip past the consumed expect/answer lines
                i = i + 1 + scan.consumed;
                continue;
            }
        }

        // Skip pure comment / metadata lines.
        if (
            line.startsWith("# @section ") ||
            line.startsWith("# @desc ") ||
            line.startsWith("# @note ") ||
            line.startsWith("# @danger ")
        ) {
            i += 1;
            continue;
        }

        // Skip ordinary comments.
        if (line.startsWith("#")) {
            i += 1;
            continue;
        }

        // Malformed leftovers (an ``expect:`` without a matching
        // ``answer:``) must never be executed as a shell command.
        if (/^(expect|answer)\s*:/i.test(line)) {
            i += 1;
            continue;
        }

        // Plain command — may have trailing expect:/answer: pairs.
        const scan = scanExpectAnswers(lines, i + 1);
        steps.push({ command: line, expects: scan.expects });
        i = i + 1 + scan.consumed;
    }
    return steps;
}

interface ExpectScan {
    expects: ExpectAnswer[];
    /** Number of lines consumed after the command line. */
    consumed: number;
}

/**
 * Collect the ``expect:``/``answer:`` pairs that follow a command.
 *
 * Blank lines between the command and its pairs are tolerated, and the
 * number of consumed lines is reported so the caller can skip exactly
 * what was parsed (the old implementation counted the same lines twice
 * and could drift out of sync).
 */
function scanExpectAnswers(lines: string[], start: number): ExpectScan {
    const out: ExpectAnswer[] = [];
    let i = start;

    while (i < lines.length) {
        const line = lines[i].trim();
        if (!line) {
            i += 1;
            continue;
        }
        const expectMatch = line.match(/^expect:\s*(.+)$/i);
        if (!expectMatch) break;

        // Look for the matching answer on the next non-blank line.
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j += 1;
        const ansMatch = (lines[j] ?? "").trim().match(/^answer:\s*(.+)$/i);
        if (!ansMatch) break;

        out.push({
            expect: expectMatch[1].trim().replace(/^["']|["']$/g, ""),
            answer: ansMatch[1].trim().replace(/^["']|["']$/g, ""),
        });
        i = j + 1;
    }

    return { expects: out, consumed: Math.max(0, i - start) };
}

export interface PlaybookStepResult extends CommandResult {
    step_index: number;
}

/**
 * Run a multi-step playbook.  Stops on the first non-zero exit code
 * and returns the partial transcript.
 *
 * All steps share a single SSH connection (pooled when a pool is
 * supplied) and `timeoutSeconds` is the budget for the *whole*
 * playbook — each step only gets the time that is left.
 */
export async function runPlaybook(
    creds: HostCreds,
    body: string,
    options: SshRunnerOptions = {},
): Promise<{ step_count: number; all_success: boolean; results: PlaybookStepResult[] }> {
    const steps = parsePlaybook(body);
    const totalTimeout = options.timeoutSeconds ?? DEFAULT_TIMEOUT_S;
    const started = Date.now();
    const results: PlaybookStepResult[] = [];
    let allSuccess = true;
    let lease: PoolLease | null = null;
    let client: Client | null = null;

    try {
        if (options.pool) {
            lease = await options.pool.acquire(creds, totalTimeout);
            client = lease.client;
        } else {
            client = await openConnection(creds, totalTimeout);
        }

        for (let i = 0; i < steps.length; i += 1) {
            const step = steps[i];
            const remaining = totalTimeout - (Date.now() - started) / 1000;
            if (remaining <= 0) {
                allSuccess = false;
                const budget = {
                    command: step.command,
                    stdout: "",
                    stderr: `[mcp-ssh] playbook exceeded its ${totalTimeout}s budget`,
                    exit_code: null,
                    success: false,
                    duration_ms: Date.now() - started,
                    step_index: i + 1,
                };
                options.pool?.recordCommand(creds.id, {
                    command: step.command,
                    success: false,
                    exitCode: null,
                    error: budget.stderr,
                    durationMs: budget.duration_ms,
                });
                results.push(budget);
                break;
            }
            const r = step.expects.length
                ? await shellOnClient(client, step.command, step.expects, remaining)
                : await execOnClient(client, step.command, remaining);
            options.pool?.recordCommand(creds.id, {
                command: step.command,
                success: r.success,
                exitCode: r.exit_code,
                error: r.success ? null : failureReason(r),
                durationMs: r.duration_ms,
            });
            results.push({ ...r, step_index: i + 1 });
            if (!r.success) {
                allSuccess = false;
                break;
            }
        }
    } catch (err) {
        // The playbook aborted (e.g. the connection died): the step that
        // was running is recorded as a failed command.
        const current = steps[results.length];
        options.pool?.recordCommand(creds.id, {
            command: current?.command ?? "",
            success: false,
            exitCode: null,
            error: (err as Error).message ?? String(err),
            durationMs: Date.now() - started,
        });
        throw err;
    } finally {
        if (!options.pool && client) {
            try {
                client.end();
            } catch {
                // ignore
            }
        }
        lease?.release();
    }

    return {
        step_count: results.length,
        all_success: allSuccess,
        results,
    };
}
