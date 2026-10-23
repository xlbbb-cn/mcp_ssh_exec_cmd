/**
 * Common shape for an MCP tool registration.  The official
 * ``@modelcontextprotocol/sdk`` uses a per-tool builder, but the
 * concrete shape we care about is just (name, description, schema,
 * handler) so we keep our own internal representation and bridge to
 * the SDK at registration time.
 */
import type { ZodRawShape } from "zod";

/**
 * Canonical description of the host identifier accepted by every tool
 * that targets an existing host.
 *
 * `host_list` returns the identifier under the key `uid`; the other
 * tools take the very same value under the name `host_id`.  The wording
 * lives here so it cannot drift between tools — when the descriptions
 * disagree the model ends up passing the wrong identifier.
 */
export const HOST_ID_DESCRIPTION =
    "Identifier of an existing host: the exact `uid` value returned by " +
    "`host_list`. Call `host_list` first and pass that value unchanged.";

/**
 * Reminder used in tool descriptions: the only way to obtain a valid
 * host identifier is `host_list`.
 */
export const HOST_LIST_HINT =
    "Call `host_list` first — it returns the `uid` of every host, and " +
    "that value is what `host_id` expects.";

/**
 * Error raised when a host identifier does not resolve.
 *
 * The message spells out the recovery step, because an unknown id is
 * almost always a value the model invented instead of one it read from
 * `host_list`.
 */
export function hostNotFoundError(hostId: string): Error {
    return new Error(
        `Host '${hostId}' not found. host_id must be the exact 'uid' value ` +
        `returned by host_list — call host_list to obtain the valid ` +
        `identifiers.`,
    );
}

export interface McpTool {
    name: string;
    description: string;
    /** Zod raw shape — passed to the SDK's ``zodToJsonSchema`` helper. */
    schema: ZodRawShape;
    /** Async handler that receives already-decoded arguments. */
    handler: (args: unknown) => Promise<{
        content: Array<{ type: "text"; text: string }>;
    }>;
}
