/**
 * MCP tool definitions for remote SSH command execution.
 *
 * Direct mirror of the SSH tools in ``app.services.llm_tools``:
 *
 *   * ``ssh_run_command``     — single non-interactive command
 *   * ``ssh_run_interactive``  — command that consumes expect/answer
 *   * ``ssh_run_playbook``     — multi-step playbook
 *
 * All three accept ``host_id`` only; credentials are resolved
 * server-side from the encrypted store and never appear in tool
 * responses.
 */
import { z } from "zod";
import { SshConnectionError, runCommand, runInteractiveCommand, runPlaybook } from "../ssh.js";
import type { HostStore } from "../storage.js";
import type { ConnectionPool } from "../pool.js";
import { HOST_ID_DESCRIPTION, HOST_LIST_HINT, hostNotFoundError, type McpTool } from "./_types.js";

// ── shared schema bits ────────────────────────────────────────────────────

const timeoutSeconds = z
    .number()
    .int()
    .min(1)
    .max(600)
    .describe(
        "Hard timeout in seconds. REQUIRED. The model must " +
        "estimate an appropriate timeout based on the command's " +
        "complexity (1-600 seconds). The command is terminated when " +
        "the timeout expires.",
    );

function summarise(result: { stdout: string; stderr: string; exit_code: number | null; success: boolean; duration_ms: number }): string {
    const limit = 8000;
    const trunc = (s: string) =>
        s.length <= limit ? s : s.slice(0, limit) + `\n... [truncated, original length=${s.length} chars]`;
    const chunks: string[] = [];
    if (result.stdout) chunks.push(`[stdout]\n${trunc(result.stdout)}`);
    if (result.stderr) chunks.push(`[stderr]\n${trunc(result.stderr)}`);
    chunks.push(
        `[exit_code=${result.exit_code} success=${result.success} duration_ms=${result.duration_ms}]`,
    );
    return chunks.join("\n");
}

function toolError(prefix: string, err: unknown) {
    const message =
        err instanceof SshConnectionError
            ? `${prefix}: ${err.message}`
            : `${prefix}: ${(err as Error).message ?? String(err)}`;
    return {
        isError: true,
        content: [{ type: "text" as const, text: `Tool error: ${message}` }],
    };
}

// ── tool factory ──────────────────────────────────────────────────────────

export function buildSshTools(store: HostStore, pool?: ConnectionPool): McpTool[] {
    return [
        {
            name: "ssh_run_command",
            description:
                "Run a single non-interactive shell command on a remote host. " +
                "Returns stdout, stderr, exit code, and duration. " +
                HOST_LIST_HINT +
                " The model must use host_id only; connection credentials " +
                "are resolved server-side and never returned. The model MUST " +
                "supply timeout_seconds (1-600) appropriate for the command; " +
                "the command is terminated when the timeout expires.",
            schema: {
                host_id: z.string().describe(HOST_ID_DESCRIPTION),
                command: z.string().describe("Shell command to execute on the remote host."),
                timeout_seconds: timeoutSeconds,
            },
            handler: async (raw) => {
                const args = z
                    .object({
                        host_id: z.string(),
                        command: z.string().min(1),
                        timeout_seconds: timeoutSeconds,
                    })
                    .parse(raw);
                const creds = await store.getCredsById(args.host_id);
                if (!creds) throw hostNotFoundError(args.host_id);
                if (!creds.is_enable) {
                    throw new Error(
                        `Host '${args.host_id}' is disabled; enable it with ` +
                        `host_update (is_enable=true) before running commands`,
                    );
                }
                try {
                    const r = await runCommand(creds, args.command, {
                        timeoutSeconds: args.timeout_seconds,
                        pool,
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: summarise(r),
                            },
                        ],
                    };
                } catch (err) {
                    return toolError("SSH exec failed", err);
                }
            },
        },
        {
            name: "ssh_run_interactive",
            description:
                "Run a command on a remote host that needs to consume " +
                "expect/answer prompts (e.g. sudo). Each entry in 'expects' " +
                "is an object with 'expect' (the prompt text to wait for) and " +
                "'answer' (the response to send back). " +
                HOST_LIST_HINT +
                " The model must use host_id only; credentials are resolved " +
                "server-side. The model MUST supply timeout_seconds (1-600) " +
                "appropriate for the command.",
            schema: {
                host_id: z.string().describe(HOST_ID_DESCRIPTION),
                command: z.string().describe("Command to execute on the remote host."),
                expects: z
                    .array(
                        z.object({
                            expect: z.string(),
                            answer: z.string(),
                        }),
                    )
                    .optional()
                    .describe("List of {expect, answer} pairs in order."),
                timeout_seconds: timeoutSeconds,
            },
            handler: async (raw) => {
                const args = z
                    .object({
                        host_id: z.string(),
                        command: z.string().min(1),
                        expects: z
                            .array(z.object({ expect: z.string(), answer: z.string() }))
                            .optional()
                            .default([]),
                        timeout_seconds: timeoutSeconds,
                    })
                    .parse(raw);
                const creds = await store.getCredsById(args.host_id);
                if (!creds) throw hostNotFoundError(args.host_id);
                if (!creds.is_enable) {
                    throw new Error(
                        `Host '${args.host_id}' is disabled; enable it with ` +
                        `host_update (is_enable=true) before running commands`,
                    );
                }
                try {
                    const r = await runInteractiveCommand(
                        creds,
                        args.command,
                        args.expects ?? [],
                        { timeoutSeconds: args.timeout_seconds, pool },
                    );
                    return {
                        content: [
                            {
                                type: "text",
                                text: summarise(r),
                            },
                        ],
                    };
                } catch (err) {
                    return toolError("SSH interactive failed", err);
                }
            },
        },
        {
            name: "ssh_run_playbook",
            description:
                "Execute a multi-step playbook on a remote host. The 'content' " +
                "field is a multi-line string. Supports structured format " +
                "with directives: '# @section \"Title\"' to group steps into " +
                "sections, '# @desc \"description\"' for section description, " +
                "'# @note \"text\"' for step notes, '# @danger \"text\"' for " +
                "danger warnings, and '# @on \"command\"' for interactive " +
                "commands (replaces legacy 'expect:'/'answer:' syntax). " +
                "Legacy format (one command per line with optional " +
                "'expect:'/'answer:' pairs) is also supported. Stops on the " +
                "first non-zero exit code and returns the transcript of " +
                "every step that ran. " +
                HOST_LIST_HINT +
                " The model must use host_id only; credentials are " +
                "resolved server-side. The model MUST supply timeout_seconds " +
                "(1-600) — it is the budget for the WHOLE playbook, each " +
                "step only gets the time that is left.",
            schema: {
                host_id: z.string().describe(HOST_ID_DESCRIPTION),
                content: z
                    .string()
                    .describe(
                        "Multi-line playbook body. Supports structured directives " +
                        "(# @section, # @desc, # @note, # @danger, # @on) or " +
                        "legacy expect:/answer: pairs.",
                    ),
                timeout_seconds: timeoutSeconds,
            },
            handler: async (raw) => {
                const args = z
                    .object({
                        host_id: z.string(),
                        content: z.string().min(1),
                        timeout_seconds: timeoutSeconds,
                    })
                    .parse(raw);
                const creds = await store.getCredsById(args.host_id);
                if (!creds) throw hostNotFoundError(args.host_id);
                if (!creds.is_enable) {
                    throw new Error(
                        `Host '${args.host_id}' is disabled; enable it with ` +
                        `host_update (is_enable=true) before running commands`,
                    );
                }
                try {
                    const r = await runPlaybook(creds, args.content, {
                        timeoutSeconds: args.timeout_seconds,
                        pool,
                    });
                    const lines: string[] = [];
                    for (const step of r.results) {
                        lines.push(`--- step ${step.step_index}: ${JSON.stringify(step.command)} ---`);
                        lines.push(summarise(step));
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text:
                                    lines.join("\n") ||
                                    "(no steps ran)",
                            },
                        ],
                    };
                } catch (err) {
                    return toolError("Playbook failed", err);
                }
            },
        },
    ];
}
