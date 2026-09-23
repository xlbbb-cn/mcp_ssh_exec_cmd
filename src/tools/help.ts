/**
 * MCP tool that tells LLM clients how to manage SSH hosts via the
 * standalone CLI (\`remote-ssh-cli\`).  Useful when a user wants to
 * work outside the MCP protocol — e.g. in a local terminal, a CI
 * pipeline, or an automation script.
 */
import { z } from "zod";
import type { McpTool } from "./_types.js";

// ── Help text built without template literals to avoid backtick clashes ───

const CLI_HELP_TEXT = [
    "# remote-ssh-cli \u2014 SSH Host Manager CLI",
    "",
    "## \u5168\u5c40\u5b89\u88c5",
    "",
    "\`\`\`bash",
    "cd mcp-ssh-server",
    "npm install",
    "npm run build",
    "npm install -g --allow-scripts=ssh2,cpu-features .",
    "\`\`\`",
    "",
    "\u5b89\u88c5\u540e\u53ef\u76f4\u63a5\u4f7f\u7528 `remote-ssh-cli` \u547d\u4ee4\u3002",
    "",
    "## \u4ea4\u4e92\u5f0f TUI",
    "",
    "\u76f4\u63a5\u8fd0\u884c `remote-ssh-cli` \u8fdb\u5165\u4ea4\u4e92\u83dc\u5355\uff0c\u652f\u6301\uff1a\u5217\u51fa\u3001\u67e5\u770b\u3001\u521b\u5efa\u3001\u66f4\u65b0\u3001\u5220\u9664\u4e3b\u673a\u3002",
    "",
    "## \u547d\u4ee4\u884c\u6a21\u5f0f",
    "",
    "### \u5217\u51fa\u6240\u6709\u4e3b\u673a",
    "\`\`\`bash",
    "remote-ssh-cli list",
    "\`\`\`",
    "",
    "### \u67e5\u770b\u5355\u4e2a\u4e3b\u673a",
    "\`\`\`bash",
    "remote-ssh-cli get <host_id>",
    "\`\`\`",
    "",
    "### \u521b\u5efa\u4e3b\u673a",
    "\u51c6\u5907\u4e00\u4e2a JSON \u6587\u4ef6\uff08\u5982 `host.json`\uff09\uff1a",
    "\`\`\`json",
    '{',
    '  "ip_address": "192.168.1.100",',
    '  "system_name": "web-01",',
    '  "ssh_port": 22,',
    '  "ssh_username": "root",',
    '  "ssh_auth_method": "password",',
    '  "ssh_password": "your-password"',
    '}',
    "\`\`\`",
    "\u7136\u540e\u6267\u884c\uff1a",
    "\`\`\`bash",
    "remote-ssh-cli create host.json",
    "\`\`\`",
    "",
    "### \u66f4\u65b0\u4e3b\u673a",
    "\`\`\`bash",
    "remote-ssh-cli update <host_id> patch.json",
    "\`\`\`",
    "",
    "patch.json \u4e2d\u53ea\u5305\u542b\u8981\u4fee\u6539\u7684\u5b57\u6bb5\u5373\u53ef\u3002",
    "",
    "### \u5220\u9664\u4e3b\u673a",
    "\`\`\`bash",
    "remote-ssh-cli delete <host_id>",
    "\`\`\`",
    "",
    "## Windows \u6545\u969c\u6392\u9664",
    "",
    "\u5982\u679c\u9047\u5230 `JScript \u7f16\u8bd1\u9519\u8bef (800A03EA)`\uff0c\u8bf7\u4f7f\u7528 **cmd.exe** \u8fd0\u884c `remote-ssh-cli` \u547d\u4ee4\uff0c",
    "\u6216\u5728 PowerShell \u4e2d\u663e\u5f0f\u8c03\u7528 `node`\uff1a",
    "\`\`\`powershell",
    'node "C:\\Users\\<user>\\AppData\\Roaming\\npm\\node_modules\\remote-ssh-cmd\\dist\\cli.js" <subcommand>',
    "\`\`\`",
].join("\n");

const helpSchema = {
    topic: z
        .string()
        .optional()
        .describe(
            "Optional topic to filter help: 'install', 'list', 'get', 'create', " +
            "'update', 'delete', 'tui', or 'windows' for troubleshooting. " +
            "Omit to get the full help text.",
        ),
};

function buildTopicText(topic: string): string {
    const lines: Record<string, string[]> = {
        install: [
            "## \u5168\u5c40\u5b89\u88c5",
            "",
            "\`\`\`bash",
            "cd mcp-ssh-server",
            "npm install",
            "npm run build",
            "npm install -g --allow-scripts=ssh2,cpu-features .",
            "\`\`\`",
        ],
        list: [
            "### \u5217\u51fa\u6240\u6709\u4e3b\u673a",
            "",
            "\`\`\`bash",
            "remote-ssh-cli list",
            "\`\`\`",
            "",
            "\u8fd4\u56de JSON \u683c\u5f0f\uff1a`{ items: [...], total: N }`",
        ],
        get: [
            "### \u67e5\u770b\u5355\u4e2a\u4e3b\u673a",
            "",
            "\`\`\`bash",
            "remote-ssh-cli get <host_id>",
            "\`\`\`",
        ],
        create: [
            "### \u521b\u5efa\u4e3b\u673a",
            "",
            "\u51c6\u5907\u4e00\u4e2a JSON \u6587\u4ef6\uff08\u5982 `host.json`\uff09\uff1a",
            "\`\`\`json",
            "{",
            '  "ip_address": "192.168.1.100",',
            '  "system_name": "web-01",',
            '  "ssh_port": 22,',
            '  "ssh_username": "root",',
            '  "ssh_auth_method": "password",',
            '  "ssh_password": "your-password"',
            "}",
            "\`\`\`",
            "\u7136\u540e\u6267\u884c\uff1a",
            "\`\`\`bash",
            "remote-ssh-cli create host.json",
            "\`\`\`",
        ],
        update: [
            "### \u66f4\u65b0\u4e3b\u673a",
            "",
            "\`\`\`bash",
            "remote-ssh-cli update <host_id> patch.json",
            "\`\`\`",
            "",
            "patch.json \u4e2d\u53ea\u5305\u542b\u8981\u4fee\u6539\u7684\u5b57\u6bb5\u5373\u53ef\u3002",
        ],
        delete: [
            "### \u5220\u9664\u4e3b\u673a",
            "",
            "\`\`\`bash",
            "remote-ssh-cli delete <host_id>",
            "\`\`\`",
        ],
        tui: [
            "### \u4ea4\u4e92\u5f0f TUI",
            "",
            "\u76f4\u63a5\u8fd0\u884c `remote-ssh-cli` \u4e0d\u5e26\u53c2\u6570\u8fdb\u5165\u4ea4\u4e92\u83dc\u5355\uff0c",
            "\u652f\u6301\uff1a\u5217\u51fa\u3001\u67e5\u770b\u3001\u521b\u5efa\u3001\u66f4\u65b0\u3001\u5220\u9664\u4e3b\u673a\u3002",
        ],
        windows: [
            "### Windows \u6545\u969c\u6392\u9664",
            "",
            "\u5982\u679c\u9047\u5230 `JScript \u7f16\u8bd1\u9519\u8bef (800A03EA)`\uff0c\u8bf7\u4f7f\u7528 **cmd.exe** \u8fd0\u884c `remote-ssh-cli` \u547d\u4ee4\uff0c",
            "\u6216\u5728 PowerShell \u4e2d\u663e\u5f0f\u8c03\u7528 `node`\uff1a",
            "\`\`\`powershell",
            'node "C:\\Users\\<user>\\AppData\\Roaming\\npm\\node_modules\\remote-ssh-cmd\\dist\\cli.js" <subcommand>',
            "\`\`\`",
        ],
    };
    return (lines[topic] ?? ["Unknown topic"]).join("\n");
}

const TOPIC_KEYS = ["install", "list", "get", "create", "update", "delete", "tui", "windows"];

export function buildHelpTool(): McpTool[] {
    return [
        {
            name: "cli_help",
            description:
                "Get help on using the remote-ssh-cli command-line tool to manage " +
                "SSH hosts outside the MCP protocol. Returns installation, usage, " +
                "and troubleshooting instructions for the standalone CLI.",
            schema: helpSchema,
            handler: async (raw) => {
                const args = z.object(helpSchema).parse(raw ?? {});
                if (args.topic) {
                    const topic = args.topic.toLowerCase();
                    if (!TOPIC_KEYS.includes(topic)) {
                        throw new Error(
                            `Unknown topic "${args.topic}". ` +
                            `Available topics: ${TOPIC_KEYS.join(", ")}`,
                        );
                    }
                    return {
                        content: [{ type: "text", text: buildTopicText(topic) }],
                    };
                }
                return {
                    content: [{ type: "text", text: CLI_HELP_TEXT }],
                };
            },
        },
    ];
}
