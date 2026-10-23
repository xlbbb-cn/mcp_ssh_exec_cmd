/**
 * MCP tool definitions for SSH host CRUD.
 *
 * These mirror the host-side of the Python ``llm_tools`` registry
 * (``host_list``, ``host_get_login``) and add the missing management
 * half (``host_create`` / ``host_update`` / ``host_delete``) so the
 * MCP server can be used as the single source of truth for host
 * credentials when running outside the FastAPI app.
 *
 * Security: every response strips credentials.  Credentials are only
 * ever decrypted inside :mod:`../ssh` when an SSH tool actually needs
 * them, and the SSH tool responses never include the password or
 * private key either.
 */
import { z } from "zod";
import type { McpTool } from "./_types.js";
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
    host_id: z.string().describe("ID of the host to update."),
    ip_address: z.string().optional(),
    system_name: z.string().optional(),
    ssh_port: z.number().int().min(1).max(65535).optional(),
    ssh_username: z.string().optional(),
    ssh_auth_method: AuthMethod.optional(),
    ssh_password: z.string().optional().describe("New plaintext password. Omit to keep current value."),
    ssh_private_key: z.string().optional().describe("New plaintext private key. Omit to keep current value."),
    ssh_private_key_passphrase: z.string().optional().describe("New passphrase for the private key. Omit to keep current value."),
    is_enable: z.boolean().optional(),
};

const hostDeleteSchema = {
    host_id: z.string().describe("ID of the host to delete."),
};

const hostListSchema = {
    enabled_only: z.boolean().optional().describe("Only return enabled hosts."),
};

const hostGetSchema = {
    host_id: z.string().describe("ID of the host to fetch."),
};

// ── tool factory ──────────────────────────────────────────────────────────

/**
 * Build the host CRUD tools.
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
                "List SSH hosts known to the server. Only the host id and IP " +
                "address are returned — no credentials, user names or ports. " +
                "Use this to discover the host_id values accepted by the SSH " +
                "execution tools.",
            schema: hostListSchema,
            handler: async (raw) => {
                const args = z.object(hostListSchema).parse(raw ?? {});
                const all = await store.listPublic();
                const items = (args.enabled_only
                    ? all.filter((h) => h.is_enable)
                    : all
                ).map((h) => ({ id: h.id, ip_address: h.ip_address }));
                return {
                    content: [
                        { type: "text", text: JSON.stringify({ items, total: items.length }) },
                    ],
                };
            },
        },
        {
            name: "host_get",
            description:
                "Get the public metadata for a single host by id. " +
                "Returns the address, port, user name, auth method and " +
                "enable flag — never the password or private key. " +
                "Use host_id-based SSH tools; credentials are resolved server-side.",
            schema: hostGetSchema,
            handler: async (raw) => {
                const args = z.object(hostGetSchema).parse(raw);
                const host = await store.getPublicById(args.host_id);
                if (!host) {
                    throw new Error(`Host ${args.host_id} not found`);
                }
                return {
                    content: [
                        { type: "text", text: JSON.stringify(host) },
                    ],
                };
            },
        },
        {
            name: "host_create",
            description:
                "Create a new SSH host entry. The supplied password or " +
                "private key is encrypted at rest and never returned by " +
                "any tool. The response only contains the new host's public " +
                "metadata plus its generated id.",
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
                "Update fields on an existing host. Omit a credential " +
                "field to keep the current value. Supply an empty string " +
                "to clear it (only valid if you also flip the auth method).",
            schema: hostUpdateSchema,
            handler: async (raw) => {
                const args = z.object(hostUpdateSchema).parse(raw);
                const { host_id, ...patch } = args;
                const host = await store.update(host_id, patch);
                if (!host) {
                    throw new Error(`Host ${host_id} not found`);
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
            description: "Permanently delete a host entry.",
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
