/**
 * End-to-end smoke test that spawns the MCP server as a child
 * process, performs the JSON-RPC handshake over stdio, and
 * verifies that all 8 tools are advertised correctly.
 *
 * Run with:  node test/mcp_smoke.mjs
 *
 * The test never touches the user's real ``hosts.json`` — it
 * points the server at a fresh temp directory.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const configDir = mkdtempSync(join(tmpdir(), "mcp-ssh-e2e-"));
const serverPath = join(process.cwd(), "dist", "index.js");

const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, MCP_SSH_CONFIG_DIR: configDir },
    stdio: ["pipe", "pipe", "pipe"],
});

const expected = new Set([
    "host_list",
    "host_get",
    "host_create",
    "host_update",
    "host_delete",
    "ssh_run_command",
    "ssh_run_interactive",
    "ssh_run_playbook",
]);

const stderrLines = [];
child.stderr.on("data", (b) => {
    for (const line of b.toString().split("\n")) {
        if (line.trim()) stderrLines.push(line);
    }
});

const rl = createInterface({ input: child.stdout });
const responses = new Map();
let nextId = 1;

function send(method, params = {}) {
    const id = nextId++;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    child.stdin.write(frame + "\n");
    return id;
}

const ok = (id) =>
    new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            responses.delete(id);
            reject(new Error(`timed out waiting for id=${id}`));
        }, 5000);
        responses.set(id, {
            resolve: (v) => {
                clearTimeout(t);
                resolve(v);
            },
            reject: (e) => {
                clearTimeout(t);
                reject(e);
            },
        });
    });

rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
        msg = JSON.parse(line);
    } catch {
        return;
    }
    if (msg.id != null && responses.has(msg.id)) {
        const { resolve, reject } = responses.get(msg.id);
        responses.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
    }
});

try {
    // 1) initialize
    const initId = send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-smoke", version: "0.0.0" },
    });
    const initResult = await ok(initId);
    if (!initResult.serverInfo?.name) {
        throw new Error("initialize response missing serverInfo.name");
    }
    console.log(`  ✓ initialize: server=${initResult.serverInfo.name} v${initResult.serverInfo.version}`);

    // 2) initialized notification (no response expected)
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    // 3) tools/list
    const listId = send("tools/list");
    const listResult = await ok(listId);
    const names = new Set(listResult.tools.map((t) => t.name));
    for (const t of expected) {
        if (!names.has(t)) {
            throw new Error(`tools/list missing: ${t}`);
        }
    }
    if (listResult.tools.length !== expected.size) {
        throw new Error(
            `tools/list returned ${listResult.tools.length} tools, want ${expected.size}`,
        );
    }
    console.log(`  ✓ tools/list: ${listResult.tools.length} tools`);

    // 4) call host_list (should work without any hosts)
    const callId = send("tools/call", {
        name: "host_list",
        arguments: {},
    });
    const callResult = await ok(callId);
    const payload = JSON.parse(callResult.content[0].text);
    if (!Array.isArray(payload.items) || payload.items.length !== 0) {
        throw new Error(`host_list returned non-empty: ${JSON.stringify(payload)}`);
    }
    console.log(`  ✓ host_list: empty store ok`);

    // 5) create a host
    const createId = send("tools/call", {
        name: "host_create",
        arguments: {
            ip_address: "127.0.0.1",
            system_name: "smoke",
            ssh_username: "tester",
            ssh_auth_method: "password",
            ssh_password: "sup3r-secret",
        },
    });
    const createResult = await ok(createId);
    const created = JSON.parse(createResult.content[0].text);
    if (created.operation !== "created" || !created.host?.id) {
        throw new Error(`host_create failed: ${JSON.stringify(createResult)}`);
    }
    if (JSON.stringify(created.host).includes("sup3r-secret")) {
        throw new Error("host_create leaked the password in the response!");
    }
    console.log(`  ✓ host_create: id=${created.host.id.slice(0, 8)}…`);

    // 6) call host_list again — should now have 1
    const listId2 = send("tools/call", { name: "host_list", arguments: {} });
    const list2 = await ok(listId2);
    const items2 = JSON.parse(list2.content[0].text).items;
    if (items2.length !== 1) {
        throw new Error(`expected 1 host, got ${items2.length}`);
    }
    console.log(`  ✓ host_list: 1 host persisted across calls`);

    // 7) call host_get — should not contain password
    const getId = send("tools/call", {
        name: "host_get",
        arguments: { host_id: created.host.id },
    });
    const getRes = await ok(getId);
    const getPayload = JSON.parse(getRes.content[0].text);
    if (JSON.stringify(getPayload).includes("sup3r-secret")) {
        throw new Error("host_get leaked the password!");
    }
    console.log(`  ✓ host_get: password not leaked`);

    // 8) call ssh_run_command against 127.0.0.1:22 — this will
    //    (correctly) fail to connect, but the error should be a
    //    structured tool error, not a crash.
    const sshId = send("tools/call", {
        name: "ssh_run_command",
        arguments: {
            host_id: created.host.id,
            command: "echo hello",
            timeout_seconds: 3,
        },
    });
    const sshRes = await ok(sshId);
    // Note: 127.0.0.1:22 might or might not have sshd running, so we
    // only check that the response shape is sensible (isError=true with
    // a Tool error message, OR a successful command result).
    if (sshRes.isError) {
        if (!sshRes.content[0].text.startsWith("Tool error:")) {
            throw new Error("ssh_run_command should return a Tool error string");
        }
        console.log(`  ✓ ssh_run_command: structured error returned (no live SSH on 127.0.0.1:22)`);
    } else {
        console.log(`  ✓ ssh_run_command: connected & ran (live sshd on 127.0.0.1:22)`);
    }

    // 9) clean up
    const delId = send("tools/call", {
        name: "host_delete",
        arguments: { host_id: created.host.id },
    });
    await ok(delId);
    console.log(`  ✓ host_delete: cleaned up`);

    console.log(`\nMCP smoke test passed.`);
    child.kill();
    rmSync(configDir, { recursive: true, force: true });
    process.exit(0);
} catch (err) {
    console.error("MCP smoke test failed:", err.message);
    console.error("\nstderr from server:");
    for (const l of stderrLines) console.error("  " + l);
    child.kill();
    rmSync(configDir, { recursive: true, force: true });
    process.exit(1);
}
