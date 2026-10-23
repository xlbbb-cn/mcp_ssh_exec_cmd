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

// `npm run` exports npm_config_* into this process; npm >= 11.9 treats an
// inherited npm_config_allow_scripts as a CLI-layer policy and refuses
// project installs with EALLOWSCRIPTS. Strip the inherited config so the
// inner npm falls back to its own npmrc/package.json layers.
const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^npm_config_/i.test(k)),
);

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
    // No `tools` array: the MCPB schema forbids inputSchema
    // (additionalProperties: false) while Smithery validates manifest tools
    // with the strict MCP Tool schema which requires it. Clients discover
    // the 9 tools through tools/list at runtime anyway.
    server: {
        type: "node",
        entry_point: "dist/index.js",
        mcp_config: {
            command: "node",
            args: ["${__dirname}/dist/index.js"],
        },
    },
    compatibility: {
        platforms: ["darwin", "win32", "linux"],
        runtimes: { node: pkg.engines.node.replace(">=", "") },
    },
};
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// Bundle only production dependencies. Lifecycle scripts are governed by
// the local allowScripts config; the ssh2 native build stays optional
// (pure-JS fallback) so it can never break the bundle.
execSync("npm install --omit=dev --no-audit --no-fund", {
    cwd: stage,
    stdio: "inherit",
    env: cleanEnv,
});

execSync(`npx --yes @anthropic-ai/mcpb validate "${join(stage, "manifest.json")}"`, {
    cwd: root,
    stdio: "inherit",
    env: cleanEnv,
});
rmSync(out, { force: true });
execSync(`npx --yes @anthropic-ai/mcpb pack "${stage}" "${out}"`, {
    cwd: root,
    stdio: "inherit",
    env: cleanEnv,
});
console.log(`packed ${out}`);
