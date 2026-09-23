/**
 * SSH client wrapper — the Node.js equivalent of
 * ``app.utils.ssh_helper`` in the Python project.
 *
 * Backed by the ``ssh2`` package (pure-JS, no external binaries),
 * which gives us a uniform code path on Linux, macOS and Windows.
 *
 * Public API
 * ──────────
 * - :class:`SshClient`
 * - :func:`runCommand`               — single non-interactive command
 * - :func:`runInteractiveCommand`    — command that consumes one or
 *                                       more ``expect/answer`` pairs
 * - :func:`runPlaybook`              — runs a list of steps parsed
 *                                       from a playbook body
 *
 * Each public function returns a :class:`CommandResult` and never
 * throws for "expected" failures (auth rejected, command not found,
 * non-zero exit code, …).  Unexpected programmer errors propagate
 * so the MCP dispatcher can decide how to surface them.
 */
import { Client, type ConnectConfig } from "ssh2";
import type { CommandResult, ExpectAnswer, HostCreds } from "./types.js";

const DEFAULT_TIMEOUT_S = 30;

export interface SshClientOptions {
    timeoutSeconds?: number;
    /** When ``true`` (default), the connection is closed even on
     *  early errors. */
    alwaysClose?: boolean;
}

export class SshConnectionError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = "SshConnectionError";
    }
}

// ── low-level connection helper ───────────────────────────────────────────

function connect(creds: HostCreds, timeoutSeconds: number): Promise<Client> {
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

// ── non-interactive command ───────────────────────────────────────────────

export async function runCommand(
    creds: HostCreds,
    command: string,
    options: SshClientOptions = {},
): Promise<CommandResult> {
    const timeout = options.timeoutSeconds ?? DEFAULT_TIMEOUT_S;
    const started = Date.now();
    let conn: Client | null = null;

    try {
        conn = await connect(creds, timeout);
        const result = await new Promise<CommandResult>((resolve, reject) => {
            conn!.exec(command, { pty: false }, (err, stream) => {
                if (err) return reject(err);
                let stdout = "";
                let stderr = "";
                stream
                    .on("close", (code: number | null) => {
                        resolve({
                            command,
                            stdout,
                            stderr,
                            exit_code: typeof code === "number" ? code : null,
                            success: code === 0,
                            duration_ms: Date.now() - started,
                        });
                    })
                    .on("data", (data: Buffer) => {
                        stdout += data.toString("utf8");
                    })
                    .stderr.on("data", (data: Buffer) => {
                        stderr += data.toString("utf8");
                    });
            });
        });
        return result;
    } finally {
        if (conn) {
            try {
                conn.end();
            } catch {
                // ignore
            }
        }
    }
}

// ── interactive command (expect/answer) ───────────────────────────────────

/**
 * Run ``command`` and feed back ``expects`` in order.
 *
 * The implementation is a simple state machine over the shell
 * stream's output buffer: every time data arrives we look for the
 * next expect pattern; once it matches, we write the corresponding
 * answer (with a trailing newline).  The stream is closed when:
 *   - the server exits (``close`` event), or
 *   - the configured timeout elapses, or
 *   - all expects have been satisfied AND we observe a short idle
 *     period with no more data.
 *
 * Mirrors the behaviour of :func:`app.utils.ssh_helper.run_interactive_command`
 * — the model supplies the same shape of input.
 */
export async function runInteractiveCommand(
    creds: HostCreds,
    command: string,
    expects: ExpectAnswer[],
    options: SshClientOptions = {},
): Promise<CommandResult> {
    const timeout = options.timeoutSeconds ?? DEFAULT_TIMEOUT_S;
    const started = Date.now();
    let conn: Client | null = null;
    let watchdog: NodeJS.Timeout | null = null;

    try {
        conn = await connect(creds, timeout);

        const result = await new Promise<CommandResult>((resolve, reject) => {
            // `ssh2` uses PseudoTtyOptions for an allocated PTY; passing
            // `{ rows, cols, term }` is the standard incantation for an
            // xterm-sized PTY.  sudo and similar tools require a PTY
            // because they check `isatty(stdout)`.
            conn!.shell({ rows: 24, cols: 80, term: "xterm-256color" }, (err, stream) => {
                if (err) return reject(err);

                let stdout = "";
                let stderr = "";
                let expectIdx = 0;
                let closed = false;

                const armWatchdog = () => {
                    if (watchdog) clearTimeout(watchdog);
                    watchdog = setTimeout(() => {
                        if (closed) return;
                        closed = true;
                        try {
                            stream.close();
                        } catch {
                            // ignore
                        }
                        resolve({
                            command,
                            stdout,
                            stderr,
                            exit_code: null,
                            success: false,
                            duration_ms: Date.now() - started,
                        });
                    }, timeout * 1000);
                };

                const finish = (code: number | null) => {
                    if (closed) return;
                    closed = true;
                    if (watchdog) clearTimeout(watchdog);
                    resolve({
                        command,
                        stdout,
                        stderr,
                        exit_code: typeof code === "number" ? code : null,
                        success: code === 0,
                        duration_ms: Date.now() - started,
                    });
                };

                stream
                    .on("close", finish)
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
                        armWatchdog();
                    })
                    .stderr.on("data", (data: Buffer) => {
                        stderr += data.toString("utf8");
                        armWatchdog();
                    });

                armWatchdog();
                stream.write(`${command}\n`);
            });
        });
        return result;
    } finally {
        if (watchdog) clearTimeout(watchdog);
        if (conn) {
            try {
                conn.end();
            } catch {
                // ignore
            }
        }
    }
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
                const expects = collectExpectAnswers(lines, i + 1);
                steps.push({ command: m[1], expects });
                // skip past the consumed expect/answer lines
                i += 1 + countExpectAnswerLines(lines, i + 1);
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

        // Plain command — may have trailing expect:/answer: pairs.
        const expects = collectExpectAnswers(lines, i + 1);
        steps.push({ command: line, expects });
        i += 1 + countExpectAnswerLines(lines, i + 1);
    }
    return steps;
}

function collectExpectAnswers(
    lines: string[],
    start: number,
): ExpectAnswer[] {
    const out: ExpectAnswer[] = [];
    let i = start;
    while (i < lines.length) {
        const line = lines[i].trim();
        if (!line) break;
        const expectMatch = line.match(/^expect:\s*(.+)$/i);
        if (expectMatch) {
            const expect = expectMatch[1].trim().replace(/^["']|["']$/g, "");
            // Look for the matching answer on the next non-blank line.
            const ansLine = (lines[i + 1] ?? "").trim();
            const ansMatch = ansLine.match(/^answer:\s*(.+)$/i);
            if (ansMatch) {
                const answer = ansMatch[1].trim().replace(/^["']|["']$/g, "");
                out.push({ expect, answer });
                i += 2;
                continue;
            }
            break;
        }
        break;
    }
    return out;
}

function countExpectAnswerLines(lines: string[], start: number): number {
    let count = 0;
    let i = start;
    while (i < lines.length) {
        const line = lines[i].trim();
        if (!line) break;
        if (/^expect:\s*/i.test(line)) {
            count += 1;
            const ans = (lines[i + 1] ?? "").trim();
            if (/^answer:\s*/i.test(ans)) {
                count += 1;
                i += 2;
                continue;
            }
            break;
        }
        break;
    }
    return count;
}

export interface PlaybookStepResult extends CommandResult {
    step_index: number;
}

/**
 * Run a multi-step playbook.  Stops on the first non-zero exit code
 * and returns the partial transcript.
 */
export async function runPlaybook(
    creds: HostCreds,
    body: string,
    options: SshClientOptions = {},
): Promise<{ step_count: number; all_success: boolean; results: PlaybookStepResult[] }> {
    const steps = parsePlaybook(body);
    const results: PlaybookStepResult[] = [];
    let allSuccess = true;

    for (let i = 0; i < steps.length; i += 1) {
        const step = steps[i];
        const r = step.expects.length
            ? await runInteractiveCommand(creds, step.command, step.expects, options)
            : await runCommand(creds, step.command, options);
        results.push({ ...r, step_index: i + 1 });
        if (!r.success) {
            allSuccess = false;
            break;
        }
    }

    return {
        step_count: results.length,
        all_success: allSuccess,
        results,
    };
}
