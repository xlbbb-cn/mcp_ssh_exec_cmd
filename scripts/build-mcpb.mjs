/**
 * Build the MCPB bundle (.mcpb) for this server.
 *
 * The bundle is what Smithery distributes for local stdio servers
 * (`smithery mcp publish <bundle>`); the same file installs into any
 * MCPB-capable host (e.g. Claude Desktop).
 *
 * Usage:  npm run build:mcpb        (requires `npm run build` first)
 *
 * Output: mcp-ssh-exec-cmd-<version>.mcpb in the repo root
 * Stage:   .mcpb-bundle/ (gitignored, recreated on every run)
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const stage = join(root, ".mcpb-bundle");
const out = join(root, `mcp-ssh-exec-cmd-${pkg.version}.mcpb`);

if (!existsSync(join(root, "dist", "index.js"))) {
    console.error("dist/index.js not found - run `npm run build` first.");
    process.exit(1);
}

// Fresh staging directory: dist/ + package.json + manifest, then prod deps.
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
cpSync(join(root, "package.json"), join(stage, "package.json"));

const manifest = {
    $schema: "https://raw.githubusercontent.com/anthropics/mcpb/main/schemas/mcpb-manifest-v0.4.schema.json",
    manifest_version: "0.4",
    name: "mcp-ssh-exec-cmd",
    display_name: "SSH Host Storage & Remote Exec",
    version: pkg.version,
    description:
        "Stdio MCP server for SSH host storage and remote command execution with a connection-pool monitor.",
    author: { name: "xlbbb-cn", url: "https://github.com/xlbbb-cn" },
    repository: { type: "git", url: pkg.repository.url },
    homepage: pkg.homepage,
    support: pkg.bugs.url,
    license: pkg.license,
    keywords: pkg.keywords,
    server: {
        type: "node",
        entry_point: "dist/index.js",
        mcp_config: {
            command: "node",
            args: ["${__dirname}/dist/index.js"],
        },
    },
    tools: [
        { name: "cli_help", description: "Built-in help for the companion CLI" },
        { name: "host_list", description: "List stored SSH hosts (sys_name + uid only)" },
        { name: "host_create", description: "Create an SSH host entry" },
        { name: "host_update", description: "Update an SSH host entry" },
        { name: "host_delete", description: "Delete an SSH host entry" },
        { name: "ssh_run_command", description: "Run one command on a host through the connection pool" },
        { name: "ssh_run_interactive", description: "Open an interactive shell session on a host" },
        { name: "ssh_run_playbook", description: "Run a scripted sequence of commands on a host" },
        { name: "pool_status", description: "Desensitized live view of the SSH connection pool" },
    ],
    compatibility: {
        platforms: ["darwin", "win32", "linux"],
        runtimes: { node: pkg.engines.node.replace(">=", "") },
    },
};
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// Bundle only production dependencies; ignore lifecycle scripts so the
// optional ssh2 native build can never break the bundle (pure-JS fallback).
execSync("npm install --omit=dev --ignore-scripts --no-audit --no-fund", {
    cwd: stage,
    stdio: "inherit",
});

execSync(`npx --yes @anthropic-ai/mcpb validate "${join(stage, "manifest.json")}"`, {
    cwd: root,
    stdio: "inherit",
});
rmSync(out, { force: true });
execSync(`npx --yes @anthropic-ai/mcpb pack "${stage}" "${out}"`, { cwd: root, stdio: "inherit" });
console.log(`packed ${out}`);
