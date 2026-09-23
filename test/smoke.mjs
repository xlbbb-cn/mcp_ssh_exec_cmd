/**
 * Smoke test for mcp-ssh-server.
 *
 * Runs without a real SSH server.  Verifies that the three layers we
 * care about work end-to-end:
 *
 *   1. crypto.ts        — encrypt/decrypt round-trip
 *   2. storage.ts       — HostStore CRUD (uses an isolated
 *                          MCP_SSH_CONFIG_DIR so it never touches the
 *                          user's real data)
 *   3. ssh.ts parser    — parsePlaybook on both formats
 *
 * Run with `npm test`.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// Each test case has:
//   { name, fn }
// `fn` is async; a thrown error fails the test.
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── 1. crypto round-trip ──────────────────────────────────────────────────

test("crypto: encrypt → decrypt returns the original plaintext", async () => {
    const { encryptSecret, decryptSecret } = await import("../dist/crypto.js");
    const master = randomBytes(32);
    for (const plaintext of ["hunter2", "", "你好，世界 🌍", "x".repeat(2000)]) {
        const token = encryptSecret(plaintext, master);
        if (!token) throw new Error("encrypt produced empty token");
        const recovered = decryptSecret(token, master);
        if (recovered !== plaintext) {
            throw new Error(
                `round-trip failed: got ${JSON.stringify(recovered)}, want ${JSON.stringify(plaintext)}`,
            );
        }
    }
    // Tampering must fail.
    const token = encryptSecret("secret", master);
    const tampered = token.slice(0, -4) + "AAAA";
    let threw = false;
    try {
        decryptSecret(tampered, master);
    } catch {
        threw = true;
    }
    if (!threw) throw new Error("tampered ciphertext should have failed to decrypt");
});

// ── 2. storage CRUD ───────────────────────────────────────────────────────

test("storage: create / list / get / update / delete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-ssh-smoke-"));
    process.env.MCP_SSH_CONFIG_DIR = dir;
    // Re-import after env change so paths pick it up.
    const { HostStore } = await import("../dist/storage.js");
    const master = randomBytes(32);
    const store = new HostStore(master);

    if ((await store.listPublic()).length !== 0) {
        throw new Error("store should be empty on first run");
    }

    const created = await store.create({
        ip_address: "10.0.0.1",
        system_name: "smoke-1",
        ssh_port: 22,
        ssh_username: "root",
        ssh_auth_method: "password",
        ssh_password: "hunter2",
    });
    if (!created.id) throw new Error("create returned no id");
    if (created.id === "created") throw new Error("id should be a uuid, not 'created'");

    // The public view MUST NOT contain the password.
    const asText = JSON.stringify(created);
    if (asText.includes("hunter2")) {
        throw new Error("public host leaked the password!");
    }

    // On-disk file must be encrypted (no plaintext password).
    const onDisk = readFileSync(join(dir, "hosts.json"), "utf8");
    if (onDisk.includes("hunter2")) {
        throw new Error("on-disk hosts.json contains plaintext password!");
    }

    // getCredsById must be able to recover the plaintext.
    const creds = await store.getCredsById(created.id);
    if (!creds) throw new Error("getCredsById returned null");
    if (creds.ssh_password !== "hunter2") {
        throw new Error("getCredsById did not recover the original password");
    }

    // Update without supplying the password should keep the old one.
    const updated = await store.update(created.id, { system_name: "smoke-1-renamed" });
    if (!updated || updated.system_name !== "smoke-1-renamed") {
        throw new Error("update did not change system_name");
    }
    const credsAfter = await store.getCredsById(created.id);
    if (credsAfter.ssh_password !== "hunter2") {
        throw new Error("password was wiped by an update that did not touch it");
    }

    // Update with a new password should round-trip.
    const updated2 = await store.update(created.id, { ssh_password: "new-pw" });
    const credsAfter2 = await store.getCredsById(created.id);
    if (credsAfter2.ssh_password !== "new-pw") {
        throw new Error("password was not updated");
    }

    // listPublic returns the same id.
    const list = await store.listPublic();
    if (list.length !== 1 || list[0].id !== created.id) {
        throw new Error(`listPublic length=${list.length}, want 1`);
    }

    // Duplicate IP must be rejected.
    let dupThrew = false;
    try {
        await store.create({
            ip_address: "10.0.0.1",
            ssh_auth_method: "password",
            ssh_password: "x",
        });
    } catch {
        dupThrew = true;
    }
    if (!dupThrew) throw new Error("duplicate IP should have been rejected");

    // pubkey auth flow
    const pkHost = await store.create({
        ip_address: "10.0.0.2",
        ssh_auth_method: "pubkey",
        ssh_private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n",
    });
    const pkCreds = await store.getCredsById(pkHost.id);
    if (!pkCreds.ssh_private_key.includes("BEGIN OPENSSH")) {
        throw new Error("pubkey was not round-tripped");
    }

    // Delete.
    const delOk = await store.delete(created.id);
    if (!delOk) throw new Error("delete returned false for an existing id");
    if ((await store.listPublic()).length !== 1) {
        throw new Error("after delete, listPublic should have 1 item");
    }

    // Cleanup
    rmSync(dir, { recursive: true, force: true });
});

// ── 3. playbook parser ────────────────────────────────────────────────────

test("ssh: parsePlaybook handles structured and legacy formats", async () => {
    const { parsePlaybook } = await import("../dist/ssh.js");

    // Legacy format with expect/answer pair
    const legacy = parsePlaybook(`
sudo apt update
expect: [sudo] password
answer: hunter2
echo done
  `);
    if (legacy.length !== 2) {
        throw new Error(`legacy length=${legacy.length}, want 2`);
    }
    if (legacy[0].command !== "sudo apt update") {
        throw new Error(`legacy[0] command=${legacy[0].command}`);
    }
    if (legacy[0].expects.length !== 1 || legacy[0].expects[0].answer !== "hunter2") {
        throw new Error("legacy[0] expects missing");
    }
    if (legacy[1].command !== "echo done" || legacy[1].expects.length !== 0) {
        throw new Error("legacy[1] unexpected shape");
    }

    // Structured format
    const structured = parsePlaybook(`
# @section "install"
# @desc "install packages"
# @note "this is a note"
# @on "sudo apt install -y nginx"
# @danger "do not run in production"
apt list --installed
  `);
    if (structured.length !== 2) {
        throw new Error(`structured length=${structured.length}, want 2`);
    }
    if (structured[0].command !== "sudo apt install -y nginx") {
        throw new Error("structured[0] should be the @on command");
    }
    if (structured[1].command !== "apt list --installed") {
        throw new Error("structured[1] should be the plain command");
    }
});

// ── runner ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const t of tests) {
    try {
        await t.fn();
        console.log(`  ✓ ${t.name}`);
        passed += 1;
    } catch (err) {
        console.error(`  ✗ ${t.name}`);
        console.error(`    ${err.stack ?? err}`);
        failed += 1;
    }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
