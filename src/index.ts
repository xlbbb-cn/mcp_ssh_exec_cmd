#!/usr/bin/env node
/**
 * MCP server entry point — stdio transport.
 *
 * Configuration (env vars):
 *   - ``MCP_SSH_MASTER_KEY``  hex-encoded 32-byte master key used to
 *     encrypt host credentials at rest.  If unset, a key is auto-
 *     generated and persisted to ``<config_dir>/master.key``.
 *   - ``MCP_SSH_CONFIG_DIR``  override the directory used for
 *     ``hosts.json`` and ``master.key``.  Defaults to
 *     ``~/.mcp-ssh-server``.
 *
 * Startup:
 *   1. Resolve the master key (env-var or on-disk).
 *   2. Build a :class:`HostStore` backed by the on-disk JSON file.
 *   3. Register MCP tools for host CRUD and SSH execution.
 *   4. Connect to the stdio transport and serve.
 *
 * The server runs as a long-lived process.  Stdout is reserved for
 * JSON-RPC frames; all human-readable logging is sent to stderr.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { HostStore } from "./storage.js";
import { loadMasterKey } from "./master_key.js";
import { getConfigDir, getHostsFilePath } from "./paths.js";
import { ConnectionPool } from "./pool.js";
import { buildHelpTool } from "./tools/help.js";
import { buildHostTools } from "./tools/hosts.js";
import { buildSshTools } from "./tools/ssh_exec.js";
import type { McpTool } from "./tools/_types.js";

const SERVER_NAME = "server-manage-mcp-ssh";
const SERVER_VERSION = "0.1.0";

/** Build the MCP server with all tools registered. */
async function buildServer(): Promise<{ server: Server; pool: ConnectionPool }> {
    const master = await loadMasterKey();
    const store = new HostStore(master);
    // One pooled SSH connection per host — commands and playbook steps
    // reuse the same session instead of reconnecting every time.
    const pool = new ConnectionPool();
    const tools: McpTool[] = [
        ...buildHelpTool(),
        ...buildHostTools(store, pool),
        ...buildSshTools(store, pool),
    ];

    const server = new Server(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                // The SDK requires a JSON Schema for the input; we use the
                // official ``zod-to-json-schema`` helper to convert the
                // ZodRawShape.  ``$refStrategy: "none"`` inlines the
                // definitions so older MCP clients that don't support
                // ``$ref``-walking still work.
                inputSchema: zodToJsonSchema(z.object(t.schema), {
                    $refStrategy: "none",
                }) as Record<string, unknown>,
            })),
        };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const tool = tools.find((t) => t.name === name);
        if (!tool) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Unknown tool: ${name}. Available: ${tools.map((t) => t.name).join(", ")}`,
                    },
                ],
            };
        }
        try {
            const result = await tool.handler(args);
            return result;
        } catch (err) {
            const msg =
                err instanceof z.ZodError
                    ? `Invalid arguments: ${err.issues
                        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
                        .join("; ")}`
                    : (err as Error).message ?? String(err);
            return {
                isError: true,
                content: [{ type: "text", text: `Tool error: ${msg}` }],
            };
        }
    });

    return { server, pool };
}

async function main(): Promise<void> {
    // Log to stderr — stdout is the MCP transport channel.
    const log = (msg: string, ...rest: unknown[]) => {
        process.stderr.write(`[mcp-ssh] ${msg} ${rest.map((r) => JSON.stringify(r)).join(" ")}\n`);
    };

    log(`starting; config_dir=${getConfigDir()}`);
    log(`hosts file: ${getHostsFilePath()}`);

    const { server, pool } = await buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log("connected to stdio transport");

    // Graceful shutdown: when the parent process closes our stdin
    // (typical when the MCP client disconnects) we exit cleanly.
    const cleanup = async (code = 0) => {
        try {
            await server.close();
        } catch {
            // ignore
        }
        try {
            // Close pooled SSH connections so sockets are not left open.
            pool.closeAll();
        } catch {
            // ignore
        }
        process.exit(code);
    };
    process.stdin.on("close", () => cleanup(0));
    process.on("SIGINT", () => cleanup(0));
    process.on("SIGTERM", () => cleanup(0));
}

main().catch((err) => {
    process.stderr.write(`[mcp-ssh] fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
});
