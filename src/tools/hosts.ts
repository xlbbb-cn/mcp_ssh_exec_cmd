/**
 * MCP tool definitions for SSH host management.
 *
 * These mirror the host-side of the Python ``llm_tools`` registry and
 * add the management half (``host_create`` / ``host_update`` /
 * ``host_delete``) so the MCP server can be used as the single source
 * of truth for host credentials when running outside the FastAPI app.
 *
 * Exposure policy: the model only ever sees ``sys_name`` + ``uid`` per
 * host (``host_list``).  Single-host metadata lookups are deliberately
 * NOT exposed as an MCP tool, and no response contains credentials.
 * Credentials are only ever decrypted inside :mod:`../ssh` when an SSH
 * tool actually needs them, and the SSH tool responses never include
 * the password or private key either.
 */
import { z } from "zod";
import {
    HOST_ID_DESCRIPTION,
    HOST_LIST_HINT,
    hostNotFoundError,
    type McpTool,
} from "./_types.js";
import type { HostStore } from "../storage.js";
import type { ConnectionPool } from "../pool.js";

// ── schemas ───────────────────────────────────────────────────────────────

const AuthMethod = z.enum(["password", "pubkey"]);

const hostCreateSchema = {
    ip_address: z.string().describe("Unique IP address or hostname of the host."),
    system_name: z.string().optional().describe("Human-readable name (e.g. 'web-01')."),
    ssh_port: z.number().int().min(1).max(65535).optional().describe("SSH port, default 22."),
    ssh_username: z.string().optional().describe("SSH username, default 'root'."),
    ssh_auth_method: AuthMethod.optional().describe("'password' (default) or 'pubkey'."),
    ssh_password: z.string().optional().describe("Plaintext password (encrypted at rest). Required when auth_method=password."),
    ssh_private_key: z.string().optional().describe("Plaintext private key (encrypted at rest). Required when auth_method=pubkey."),
    ssh_private_key_passphrase: z.string().optional().describe("Passphrase protecting the private key (encrypted at rest). Only used with auth_method=pubkey."),
    is_enable: z.boolean().optional().describe("Whether SSH tools can target this host. Default true."),
};

const hostUpdateSchema = {
    host_id: z.string().describe(HOST_ID_DESCRIPTION),
    ip_address: z.string().optional().describe("New IP address or hostname. Omit to keep the current value."),
    system_name: z.string().optional().describe("New human-readable name. Omit to keep the current value."),
    ssh_port: z.number().int().min(1).max(65535).optional().describe("New SSH port (1-65535). Omit to keep the current value."),
    ssh_username: z.string().optional().describe("New SSH username. Omit to keep the current value."),
    ssh_auth_method: AuthMethod.optional().describe("New auth method ('password' or 'pubkey'). Omit to keep the current value."),
    ssh_password: z.string().optional().describe("New plaintext password. Omit to keep current value."),
    ssh_private_key: z.string().optional().describe("New plaintext private key. Omit to keep current value."),
    ssh_private_key_passphrase: z.string().optional().describe("New passphrase for the private key. Omit to keep current value."),
    is_enable: z.boolean().optional().describe("Enable or disable the host. Omit to keep the current value."),
};

const hostDeleteSchema = {
    host_id: z.string().describe(HOST_ID_DESCRIPTION),
};

const hostListSchema = {
    enabled_only: z.boolean().optional().describe("Only return enabled hosts."),
};

// ── tool factory ──────────────────────────────────────────────────────────

/**
 * Build the host management tools.
 *
 * `pool` is optional; when supplied, host updates and deletions also
 * drop the cached SSH connection for that host so the next command
 * reconnects with the new credentials.
 */
export function buildHostTools(store: HostStore, pool?: ConnectionPool): McpTool[] {
    return [
        {
            name: "host_list",
            description:
                "List the SSH hosts known to the server. Each entry contains " +
                "exactly two fields: 'sys_name' (the host name) and 'uid' " +
                "(its unique identifier). Start here: pass a 'uid' value to " +
                "the other tools as their host_id argument. No address, " +
                "port, user name or credential is returned.",
            schema: hostListSchema,
            handler: async (raw) => {
                const args = z.object(hostListSchema).parse(raw ?? {});
                const all = await store.listPublic();
                const items = (args.enabled_only
                    ? all.filter((h) => h.is_enable)
                    : all
                ).map((h) => ({ sys_name: h.system_name, uid: h.id }));
                return {
                    content: [
                        { type: "text", text: JSON.stringify({ items, total: items.length }) },
                    ],
                };
            },
        },
        {
            name: "host_create",
            description:
                "Create a new SSH host entry. The supplied password or " +
                "private key is encrypted at rest and never returned by " +
                "any tool. The response contains the new host's public " +
                "metadata, including the uid that identifies it in " +
                "`host_list`.",
            schema: hostCreateSchema,
            handler: async (raw) => {
                const args = z.object(hostCreateSchema).parse(raw);
                const host = await store.create(args);
                return {
                    content: [
                        { type: "text", text: JSON.stringify({ operation: "created", host }) },
                    ],
                };
            },
        },
        {
            name: "host_update",
            description:
                "Update fields on an existing host. " +
                HOST_LIST_HINT +
                " Omit a credential field to keep the current value. " +
                "Supply an empty string to clear it (only valid if you " +
                "also flip the auth method).",
            schema: hostUpdateSchema,
            handler: async (raw) => {
                const args = z.object(hostUpdateSchema).parse(raw);
                const { host_id, ...patch } = args;
                const host = await store.update(host_id, patch);
                if (!host) {
                    throw hostNotFoundError(host_id);
                }
                // A cached SSH connection for this host may have been
                // opened with the previous credentials — drop it.
                if (pool && touchesConnection(patch)) {
                    pool.invalidate(host_id);
                }
                return {
                    content: [
                        { type: "text", text: JSON.stringify({ operation: "updated", host }) },
                    ],
                };
            },
        },
        {
            name: "host_delete",
            description:
                "Permanently delete a host entry. " + HOST_LIST_HINT,
            schema: hostDeleteSchema,
            handler: async (raw) => {
                const args = z.object(hostDeleteSchema).parse(raw);
                const ok = await store.delete(args.host_id);
                pool?.invalidate(args.host_id);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ operation: "deleted", host_id: args.host_id, ok }),
                        },
                    ],
                };
            },
        },
    ];
}

/** Fields that change how (or whether) a host can be reached over SSH. */
function touchesConnection(patch: Record<string, unknown>): boolean {
    return (
        "ip_address" in patch ||
        "ssh_port" in patch ||
        "ssh_username" in patch ||
        "ssh_auth_method" in patch ||
        "ssh_password" in patch ||
        "ssh_private_key" in patch ||
        "ssh_private_key_passphrase" in patch
    );
}
