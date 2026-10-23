/**
 * Smoke test for the newer features:
 *   - CSV parsing / host-row mapping        (src/csv.ts)
 *   - bulk import against a HostStore       (src/importer.ts)
 *   - credential fingerprinting for the pool (src/pool.ts)
 *   - playbook parser edge cases            (src/ssh.ts)
 *
 * Run with `npm test`.  State is isolated in a temp MCP_SSH_CONFIG_DIR,
 * the user's real hosts.json is never touched.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── 1. CSV parsing ────────────────────────────────────────────────────────

test("csv: quoted fields, embedded commas/newlines and CRLF", async () => {
  const { parseCsv } = await import("../dist/csv.js");

  const rows = parseCsv(
    'a,b,c\r\n"x,1","line1\nline2","say ""hi"""\r\n',
  );
  if (rows.length !== 2) throw new Error(`rows=${rows.length}, want 2`);
  if (rows[0].join("|") !== "a|b|c") {
    throw new Error(`header=${JSON.stringify(rows[0])}`);
  }
  if (rows[1][0] !== "x,1") throw new Error(`cell0=${rows[1][0]}`);
  if (rows[1][1] !== "line1\nline2") throw new Error(`cell1=${JSON.stringify(rows[1][1])}`);
  if (rows[1][2] !== 'say "hi"') throw new Error(`cell2=${JSON.stringify(rows[1][2])}`);
});

test("csv: host rows are mapped with defaults and per-row errors", async () => {
  const { parseHostCsv } = await import("../dist/csv.js");

  const csv = [
    "ip_address,system_name,ssh_port,ssh_username,ssh_auth_method,ssh_password",
    "10.0.0.1,web-01,2222,deploy,password,s3cret",
    "10.0.0.2,db-01,,root,password,",
    "10.0.0.3,bad-port,notaport,root,password,x",
    "10.0.0.4,bad-auth,,root,telnet,x",
    "10.0.0.5,pub,,root,pubkey,",
  ].join("\n");

  const { rows, errors } = parseHostCsv(csv);
  if (rows.length !== 1) throw new Error(`rows=${rows.length}, want 1`);
  const input = rows[0].input;
  if (input.ip_address !== "10.0.0.1") throw new Error("wrong ip");
  if (input.ssh_port !== 2222) throw new Error(`port=${input.ssh_port}`);
  if (input.ssh_username !== "deploy") throw new Error("wrong user");
  if (input.ssh_auth_method !== "password") throw new Error("wrong auth");
  if (input.is_enable !== undefined) throw new Error("is_enable should stay unset");

  if (errors.length !== 4) {
    throw new Error(`errors=${errors.length}, want 4 -> ${JSON.stringify(errors)}`);
  }
  // Missing password, bad port, bad auth method, missing private key.
  const reasons = errors.map((e) => e.reason).join(" | ");
  if (!reasons.includes("ssh_password is required")) throw new Error(reasons);
  if (!reasons.includes("ssh_port")) throw new Error(reasons);
  if (!reasons.includes("ssh_auth_method")) throw new Error(reasons);
  if (!reasons.includes("ssh_private_key")) throw new Error(reasons);
  // Line numbers point at the offending row.
  if (errors[0].line !== 3) throw new Error(`line=${errors[0].line}, want 3`);
});

test("csv: aliases and a key file path are accepted", async () => {
  const { parseHostCsv } = await import("../dist/csv.js");
  const dir = mkdtempSync(join(tmpdir(), "mcp-ssh-csv-"));
  const keyPath = join(dir, "id_ed25519");
  writeFileSync(keyPath, "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----\n");

  const csv = [
    "ip,user,auth,private_key_path",
    `10.0.0.9,admin,pubkey,${keyPath}`,
  ].join("\n");
  const { rows, errors } = parseHostCsv(csv);
  if (errors.length) throw new Error(JSON.stringify(errors));
  if (rows.length !== 1) throw new Error(`rows=${rows.length}`);
  if (!rows[0].input.ssh_private_key?.includes("BEGIN OPENSSH")) {
    throw new Error("private key was not read from the path");
  }
  rmSync(dir, { recursive: true, force: true });
});

// ── 2. bulk import ────────────────────────────────────────────────────────

test("import: dry run creates nothing, real import creates hosts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-ssh-import-"));
  process.env.MCP_SSH_CONFIG_DIR = dir;
  const { HostStore } = await import("../dist/storage.js");
  const { importHostCsv } = await import("../dist/importer.js");
  const store = new HostStore(randomBytes(32));

  const csv = [
    "ip_address,system_name,ssh_auth_method,ssh_password",
    "10.1.0.1,a,password,pw1",
    "10.1.0.2,b,password,pw2",
    "10.1.0.3,bad,,", // missing password -> failed
  ].join("\n");

  const dry = await importHostCsv(store, csv, { dryRun: true });
  if (dry.created.length !== 2) throw new Error(`dry created=${dry.created.length}`);
  if (dry.failed.length !== 1) throw new Error(`dry failed=${dry.failed.length}`);
  if ((await store.listPublic()).length !== 0) {
    throw new Error("dry run must not persist anything");
  }

  const real = await importHostCsv(store, csv);
  if (real.created.length !== 2) throw new Error(`created=${real.created.length}`);
  if (real.failed.length !== 1) throw new Error(`failed=${real.failed.length}`);
  const stored = await store.listPublic();
  if (stored.length !== 2) throw new Error(`stored=${stored.length}`);

  // Importing the same file again skips every row as a duplicate.
  const again = await importHostCsv(store, csv);
  if (again.created.length !== 0) throw new Error("duplicate import created hosts");
  if (again.skipped.length !== 2) throw new Error(`skipped=${again.skipped.length}`);

  // Duplicates inside one file are skipped too.
  const dupCsv = [
    "ip_address,ssh_auth_method,ssh_password",
    "10.2.0.1,password,pw",
    "10.2.0.1,password,pw",
  ].join("\n");
  const dup = await importHostCsv(store, dupCsv);
  if (dup.created.length !== 1) throw new Error(`dup created=${dup.created.length}`);
  if (dup.skipped.length !== 1) throw new Error(`dup skipped=${dup.skipped.length}`);

  rmSync(dir, { recursive: true, force: true });
});

// ── 3. pool fingerprint ───────────────────────────────────────────────────

test("pool: credential fingerprint changes with the credentials", async () => {
  const { credentialFingerprint } = await import("../dist/pool.js");
  const base = {
    id: "h1",
    ip_address: "10.0.0.1",
    system_name: "s",
    ssh_port: 22,
    ssh_username: "root",
    ssh_auth_method: "password",
    ssh_password: "pw",
    ssh_private_key: "",
    ssh_private_key_passphrase: "",
    is_enable: true,
  };
  const fp = credentialFingerprint(base);
  if (fp !== credentialFingerprint({ ...base })) {
    throw new Error("fingerprint is not stable");
  }
  if (fp === credentialFingerprint({ ...base, ssh_password: "other" })) {
    throw new Error("fingerprint ignored the password");
  }
  if (fp === credentialFingerprint({ ...base, ssh_port: 2222 })) {
    throw new Error("fingerprint ignored the port");
  }
});

// ── 4. connection pool ────────────────────────────────────────────────────

test("pool: connections are reused, rotated on credential change, dropped on invalidate", async () => {
  const { ConnectionPool } = await import("../dist/pool.js");
  const { EventEmitter } = await import("node:events");

  const opened = [];
  const fakeConnect = async (creds) => {
    const client = new EventEmitter();
    client.ended = false;
    client.end = () => { client.ended = true; };
    opened.push({ creds, client });
    return client;
  };

  const creds = {
    id: "h1",
    ip_address: "10.0.0.1",
    system_name: "s",
    ssh_port: 22,
    ssh_username: "root",
    ssh_auth_method: "password",
    ssh_password: "pw",
    ssh_private_key: "",
    ssh_private_key_passphrase: "",
    is_enable: true,
  };

  const pool = new ConnectionPool({ idleMs: 60_000, maxHosts: 4, connect: fakeConnect });

  const lease1 = await pool.acquire(creds, 5);
  lease1.release();
  const lease2 = await pool.acquire(creds, 5);
  lease2.release();
  if (lease1.client !== lease2.client) {
    throw new Error("the second acquire did not reuse the pooled connection");
  }
  if (opened.length !== 1) throw new Error(`opened=${opened.length}, want 1`);
  if (pool.size !== 1) throw new Error(`pool size=${pool.size}, want 1`);

  // Changed credentials must not reuse the old connection.
  const lease3 = await pool.acquire({ ...creds, ssh_password: "new-pw" }, 5);
  lease3.release();
  if (opened.length !== 2) throw new Error(`opened=${opened.length}, want 2`);
  if (!opened[0].client.ended) throw new Error("the stale connection was not closed");
  if (lease3.client === lease1.client) throw new Error("stale connection was reused");

  // invalidate() drops the connection.
  pool.invalidate(creds.id);
  if (pool.size !== 0) throw new Error(`pool size=${pool.size}, want 0`);
  if (!opened[1].client.ended) throw new Error("invalidated connection was not closed");

  pool.closeAll();
});

test("pool: idle connections are closed after the idle window", async () => {
  const { ConnectionPool } = await import("../dist/pool.js");
  const { EventEmitter } = await import("node:events");

  let client;
  const fakeConnect = async () => {
    client = new EventEmitter();
    client.ended = false;
    client.end = () => { client.ended = true; };
    return client;
  };

  const pool = new ConnectionPool({ idleMs: 40, maxHosts: 4, connect: fakeConnect });
  const lease = await pool.acquire(
    {
      id: "h1",
      ip_address: "10.0.0.1",
      system_name: "s",
      ssh_port: 22,
      ssh_username: "root",
      ssh_auth_method: "password",
      ssh_password: "pw",
      ssh_private_key: "",
      ssh_private_key_passphrase: "",
      is_enable: true,
    },
    5,
  );
  lease.release();
  // The connection stays open after release — it is pooled for reuse.
  if (client.ended) throw new Error("connection closed while it should be idle-pooled");
  await new Promise((r) => setTimeout(r, 120));
  if (!client.ended) throw new Error("idle connection was not closed");
  if (pool.size !== 0) throw new Error(`pool size=${pool.size}, want 0`);
});

// ── 5. playbook parser edge cases ─────────────────────────────────────────

test("ssh: stray expect lines are not executed, blank lines are tolerated", async () => {
  const { parsePlaybook } = await import("../dist/ssh.js");

  const stray = parsePlaybook(`
sudo apt update
expect: [sudo] password
echo done
  `);
  // The expect line has no matching answer -> it must be dropped, not
  // executed as a command.
  if (stray.length !== 2) throw new Error(`stray length=${stray.length}, want 2`);
  if (stray[1].command !== "echo done") {
    throw new Error(`stray[1]=${JSON.stringify(stray[1])}`);
  }
  if (stray[0].expects.length !== 0) {
    throw new Error("unpaired expect must not become an expect pair");
  }

  const blank = parsePlaybook(`
sudo apt update

expect: [sudo] password
answer: hunter2
echo done
  `);
  if (blank.length !== 2) throw new Error(`blank length=${blank.length}, want 2`);
  if (blank[0].expects.length !== 1 || blank[0].expects[0].answer !== "hunter2") {
    throw new Error("blank line between command and expect broke the pairing");
  }
  if (blank[1].command !== "echo done") {
    throw new Error(`blank[1]=${JSON.stringify(blank[1])}`);
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
