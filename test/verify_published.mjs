/**
 * Verify the package as it is published on GitHub Packages.
 *
 * Unlike the other smoke tests this one does NOT use the local
 * checkout — it exercises the tarball that npm actually serves:
 *
 *   npm install @xlbbb-cn/mcp_ssh_exec_cmd --no-save
 *   node test/verify_published.mjs
 *
 * It resolves the installed package, spawns its MCP server and checks
 * that the JSON-RPC handshake works and that all 9 tools are advertised.
 *
 * Run with:  node test/verify_published.mjs
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

const PACKAGE_NAME = "@xlbbb-cn/mcp_ssh_exec_cmd";
const EXPECTED_TOOLS = [
    "cli_help",
    "host_list",
    "host_create",
    "host_update",
    "host_delete",
    "ssh_run_command",
    "ssh_run_interactive",
    "ssh_run_playbook",
    "pool_status",
];

let mainPath;
let manifest;
try {
    mainPath = require.resolve(PACKAGE_NAME);
    manifest = require(`${PACKAGE_NAME}/package.json`);
} catch (err) {
    console.error(
        `${PACKAGE_NAME} is not installed — run:\n` +
            `  npm install ${PACKAGE_NAME} --no-save --registry=https://npm.pkg.github.com`,
    );
    console.error(String(err.message));
    process.exit(1);
}

console.log(`  ✓ installed: ${manifest.name}@${manifest.version}`);

const configDir = mkdtempSync(join(tmpdir(), "mcp-ssh-verify-"));
const child = spawn(process.execPath, [mainPath], {
    env: { ...process.env, MCP_SSH_CONFIG_DIR: configDir },
    stdio: ["pipe", "pipe", "pipe"],
});

const stderrLines = [];
child.stderr.on("data", (b) => {
    for (const line of b.toString().split("\n")) {
        if (line.trim()) stderrLines.push(line);
    }
});

const responses = new Map();
let nextId = 1;

function send(method, params = {}) {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return id;
}

function ok(id) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            responses.delete(id);
            reject(new Error(`timed out waiting for id=${id}`));
        }, 20000);
        responses.set(id, {
            resolve: (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            reject: (e) => {
                clearTimeout(timer);
                reject(e);
            },
        });
    });
}

let buffer = "";
child.stdout.on("data", (b) => {
    buffer += b.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            continue;
        }
        if (msg.id != null && responses.has(msg.id)) {
            const { resolve, reject } = responses.get(msg.id);
            responses.delete(msg.id);
            if (msg.error) reject(new Error(JSON.stringify(msg.error)));
            else resolve(msg.result);
        }
    }
});

try {
    const init = await ok(
        send("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "verify-published", version: "0.0.0" },
        }),
    );
    if (!init.serverInfo?.name) {
        throw new Error("initialize response missing serverInfo.name");
    }
    console.log(`  ✓ initialize: server=${init.serverInfo.name} v${init.serverInfo.version}`);

    child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );

    const list = await ok(send("tools/list"));
    const names = list.tools.map((t) => t.name);
    const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
    if (missing.length > 0) {
        throw new Error(`tools/list missing: ${missing.join(", ")}`);
    }
    if (names.length !== EXPECTED_TOOLS.length) {
        throw new Error(`tools/list returned ${names.length} tools, want ${EXPECTED_TOOLS.length}`);
    }
    console.log(`  ✓ tools/list: ${names.length} tools (${names.join(", ")})`);

    const call = await ok(send("tools/call", { name: "host_list", arguments: {} }));
    const payload = JSON.parse(call.content[0].text);
    if (!Array.isArray(payload.items)) {
        throw new Error(`host_list returned an unexpected payload: ${JSON.stringify(payload)}`);
    }
    console.log("  ✓ host_list: responds from the published build");

    console.log("\nPublished package verified.");
    child.kill();
    rmSync(configDir, { recursive: true, force: true });
    process.exit(0);
} catch (err) {
    console.error("Published package verification failed:", err.message);
    for (const l of stderrLines) console.error("  " + l);
    child.kill();
    rmSync(configDir, { recursive: true, force: true });
    process.exit(1);
}
