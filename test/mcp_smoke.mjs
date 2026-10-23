/**
 * End-to-end smoke test that spawns the MCP server as a child
 * process, performs the JSON-RPC handshake over stdio, and
 * verifies that all 9 tools are advertised correctly.
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
    "cli_help",
    "host_list",
    "host_create",
    "host_update",
    "host_delete",
    "ssh_run_command",
    "ssh_run_interactive",
    "ssh_run_playbook",
    "pool_status",
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

// The handshake can be slow on a cold Windows start (AV scanning the
// freshly spawned node process, master-key generation, ...), so the
// response timeout is generous — a healthy server answers in ~100ms.
const RESPONSE_TIMEOUT_MS = 20000;

const ok = (id) =>
    new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            responses.delete(id);
            reject(new Error(`timed out waiting for id=${id}`));
        }, RESPONSE_TIMEOUT_MS);
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

    // 6) call host_list again — should now be 1, and only expose
    //    the host name (sys_name) and the unique id (uid).
    const listId2 = send("tools/call", { name: "host_list", arguments: {} });
    const list2 = await ok(listId2);
    const items2 = JSON.parse(list2.content[0].text).items;
    if (items2.length !== 1) {
        throw new Error(`expected 1 host, got ${items2.length}`);
    }
    const keys = Object.keys(items2[0]).sort();
    if (keys.length !== 2 || keys[0] !== "sys_name" || keys[1] !== "uid") {
        throw new Error(`host_list exposed unexpected fields: ${keys.join(",")}`);
    }
    if (items2[0].uid !== created.host.id) {
        throw new Error(`host_list uid=${items2[0].uid} != created id`);
    }
    if (items2[0].sys_name !== "smoke") {
        throw new Error(`host_list sys_name=${items2[0].sys_name}`);
    }
    console.log(`  ✓ host_list: 1 host persisted, only sys_name + uid exposed`);

    // 7) host_get must NOT be exposed to MCP clients
    if (names.has("host_get")) {
        throw new Error("host_get is exposed but must not be published to MCP");
    }
    console.log(`  ✓ host_get: not advertised to MCP`);

    // 8) an unknown host_id must produce an actionable error that
    //    points the model back at host_list
    const badId = send("tools/call", {
        name: "ssh_run_command",
        arguments: {
            host_id: "not-a-real-uid",
            command: "echo hello",
            timeout_seconds: 3,
        },
    });
    const badRes = await ok(badId);
    if (!badRes.isError) {
        throw new Error("ssh_run_command with an unknown host_id should fail");
    }
    const badText = badRes.content[0].text;
    if (!badText.includes("host_list")) {
        throw new Error(`error should mention host_list: ${badText}`);
    }
    console.log(`  ✓ ssh_run_command: unknown host_id error points at host_list`);

    // 9) call ssh_run_command against 127.0.0.1:22 — this will
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

    // 10) the pool monitor answers with a desensitized table
    const poolId = send("tools/call", {
        name: "pool_status",
        arguments: { include_idle_hosts: true },
    });
    const poolRes = await ok(poolId);
    if (poolRes.isError) {
        throw new Error(`pool_status failed: ${JSON.stringify(poolRes)}`);
    }
    const poolText = poolRes.content[0].text;
    if (!poolText.includes("UID") || !poolText.includes("SYS_NAME")) {
        throw new Error(`pool_status did not render a table:\n${poolText}`);
    }
    if (!poolText.includes(created.host.id)) {
        throw new Error(`pool_status did not list the host:\n${poolText}`);
    }
    if (poolText.includes("sup3r-secret")) {
        throw new Error("pool_status leaked the password!");
    }
    if (poolText.includes("127.0.0.1")) {
        throw new Error("pool_status leaked the address!");
    }
    console.log("  ✓ pool_status: desensitized pool table");

    // 11) clean up
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
