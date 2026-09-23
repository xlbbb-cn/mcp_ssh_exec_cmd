/**
 * Common shape for an MCP tool registration.  The official
 * ``@modelcontextprotocol/sdk`` uses a per-tool builder, but the
 * concrete shape we care about is just (name, description, schema,
 * handler) so we keep our own internal representation and bridge to
 * the SDK at registration time.
 */
import type { ZodRawShape } from "zod";

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
