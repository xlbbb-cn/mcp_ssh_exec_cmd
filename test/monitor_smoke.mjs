/**
 * Smoke test for the connection-pool monitor:
 *   - frame rendering (statuses, latency, problems section)
 *   - the monitor loop (one frame per interval, `q` stops it)
 *   - the default SSH probe (no credentials -> reported as a failure)
 *   - the pool snapshot used by the monitor
 *
 * Run with `npm test`.  No real SSH server is needed — the probe is
 * injected, so the test never opens a socket.
 */
import { EventEmitter } from "node:events";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const HOSTS = [
    {
        id: "h1",
        system_name: "web-01",
        ip_address: "192.168.1.100",
        ssh_port: 22,
        ssh_username: "root",
        is_enable: true,
    },
    {
        id: "h2",
        system_name: "db-01",
        ip_address: "10.0.0.5",
        ssh_port: 2222,
        ssh_username: "deploy",
        is_enable: true,
    },
    {
        id: "h3",
        system_name: "off-01",
        ip_address: "10.0.0.9",
        ssh_port: 22,
        ssh_username: "root",
        is_enable: false,
    },
];

// ── 1. frame rendering ─────────────────────────────────────────────────────

test("monitor: the frame lists every host with its status", async () => {
    const { formatMonitorFrame } = await import("../dist/monitor.js");

    const frame = {
        tick: 3,
        updatedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
        intervalMs: 1000,
        tickMs: 42,
        probeTimeoutSeconds: 5,
        poolSize: 2,
        poolMaxHosts: 32,
        poolIdleMs: 60000,
        hosts: [
            {
                host: HOSTS[0],
                status: "up",
                latencyMs: 12,
                lastCheckedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
                lastOkAt: Date.UTC(2026, 0, 2, 3, 4, 5),
                error: null,
                checks: 3,
                failures: 0,
                pooledForMs: 65000,
                activeOps: 0,
            },
            {
                host: HOSTS[1],
                status: "down",
                latencyMs: 8,
                lastCheckedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
                lastOkAt: null,
                error: "connect ECONNREFUSED 10.0.0.5:2222",
                checks: 3,
                failures: 3,
                pooledForMs: null,
                activeOps: 0,
            },
            {
                host: HOSTS[2],
                status: "disabled",
                latencyMs: null,
                lastCheckedAt: null,
                lastOkAt: null,
                error: null,
                checks: 0,
                failures: 0,
                pooledForMs: null,
                activeOps: 0,
            },
        ],
    };

    const text = formatMonitorFrame(frame, 120);
    if (!text.includes("tick 3")) throw new Error("tick missing");
    if (!text.includes("pool 2/32 connections")) {
        throw new Error(`pool summary missing:\n${text}`);
    }
    if (!text.includes("web-01")) throw new Error("host name missing");
    if (!text.includes("192.168.1.100:22")) throw new Error("address missing");
    if (!text.includes("up")) throw new Error("status missing");
    if (!text.includes("12ms")) throw new Error("latency missing");
    if (!text.includes("1m05s")) throw new Error(`pool age missing:\n${text}`);
    if (!text.includes("disabled")) throw new Error("disabled status missing");
    if (!text.includes("problems (1)")) throw new Error("problems section missing");
    if (!text.includes("ECONNREFUSED")) throw new Error("error message missing");
    if (!text.includes("press q to quit")) throw new Error("quit hint missing");
});

test("monitor: the frame is truncated to the terminal width", async () => {
    const { formatMonitorFrame } = await import("../dist/monitor.js");

    const frame = {
        tick: 1,
        updatedAt: Date.now(),
        intervalMs: 1000,
        tickMs: 1,
        probeTimeoutSeconds: 5,
        poolSize: 0,
        poolMaxHosts: 32,
        poolIdleMs: 60000,
        hosts: [
            {
                host: { ...HOSTS[0], system_name: "a-very-long-host-name" },
                status: "up",
                latencyMs: 1,
                lastCheckedAt: Date.now(),
                lastOkAt: Date.now(),
                error: null,
                checks: 1,
                failures: 0,
                pooledForMs: 1000,
                activeOps: 0,
            },
        ],
    };

    const text = formatMonitorFrame(frame, 60);
    for (const line of text.split("\n")) {
        if (line.length > 60) {
            throw new Error(`line too long (${line.length}): ${line}`);
        }
    }
});

// ── 2. the monitor loop ────────────────────────────────────────────────────

test("monitor: one frame per interval and 'q' stops the loop", async () => {
    const { runPoolMonitor } = await import("../dist/monitor.js");

    class FakeInput extends EventEmitter {
        constructor() {
            super();
            this.isTTY = true;
            this.rawMode = null;
        }
        setRawMode(mode) {
            this.rawMode = mode;
        }
        resume() {}
        pause() {}
    }

    const input = new FakeInput();
    const frames = [];
    const probed = [];

    const running = runPoolMonitor({
        hosts: HOSTS,
        probe: async (host) => {
            probed.push(host.id);
            return { ok: true, latencyMs: 7 };
        },
        intervalMs: 40,
        clearScreen: false,
        write: (chunk) => frames.push(chunk),
        input,
    });

    await new Promise((r) => setTimeout(r, 150));
    const before = frames.length;
    if (before < 2) throw new Error(`frames=${before}, want at least 2`);

    // The disabled host is displayed but never probed.
    if (probed.includes("h3")) throw new Error("a disabled host was probed");
    if (!probed.includes("h1")) throw new Error("an enabled host was not probed");

    input.emit("data", Buffer.from("q"));
    const code = await running;
    if (code !== 0) throw new Error(`exit code=${code}`);
    if (input.rawMode !== false) {
        throw new Error("the terminal was not restored");
    }

    const last = frames[frames.length - 1];
    if (!last.includes("Monitor stopped.")) {
        throw new Error(`the monitor did not report the stop:\n${last}`);
    }
});

test("monitor: without a terminal only one frame is printed", async () => {
    const { runPoolMonitor } = await import("../dist/monitor.js");

    class FakeInput extends EventEmitter {
        constructor() {
            super();
            this.isTTY = false;
        }
        resume() {}
        pause() {}
    }

    const frames = [];
    const code = await runPoolMonitor({
        hosts: HOSTS,
        probe: async () => ({ ok: true, latencyMs: 1 }),
        intervalMs: 20,
        clearScreen: false,
        write: (chunk) => frames.push(chunk),
        input: new FakeInput(),
    });

    if (code !== 0) throw new Error(`exit code=${code}`);
    const rendered = frames.filter((f) => f.includes("SSH connection pool monitor"));
    if (rendered.length !== 1) {
        throw new Error(`frames=${rendered.length}, want 1`);
    }
    if (!rendered[0].includes("press q to quit")) {
        throw new Error(`the frame is missing the quit hint:\n${rendered[0]}`);
    }
});

// ── 3. the default probe ───────────────────────────────────────────────────

test("monitor: the ssh probe reports a missing host instead of throwing", async () => {
    const { createSshProbe } = await import("../dist/monitor.js");

    const probe = createSshProbe({
        getCreds: async () => null,
        pool: undefined,
        timeoutSeconds: 1,
        command: "echo",
    });

    const outcome = await probe(HOSTS[0]);
    if (outcome.ok) throw new Error("a missing host must not be 'up'");
    if (!outcome.error || !outcome.error.includes("not found")) {
        throw new Error(`error=${outcome.error}`);
    }
});

test("monitor: the ssh probe runs the command through the pool", async () => {
    const { createSshProbe } = await import("../dist/monitor.js");
    const { ConnectionPool } = await import("../dist/pool.js");

    // A fake ssh2 client: `exec` answers with an empty stream that
    // closes with the given exit code.
    const makeClient = (exitCode, stderr = "") => {
        const client = new EventEmitter();
        client.end = () => {};
        client.exec = (_cmd, _opts, cb) => {
            const stream = new EventEmitter();
            stream.stderr = new EventEmitter();
            stream.close = () => {};
            cb(null, stream);
            setImmediate(() => {
                if (stderr) stream.stderr.emit("data", Buffer.from(stderr));
                stream.emit("close", exitCode);
            });
        };
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

    let created = 0;
    const pool = new ConnectionPool({
        idleMs: 60_000,
        maxHosts: 4,
        connect: async () => {
            created += 1;
            return makeClient(0);
        },
    });

    const probe = createSshProbe({
        getCreds: async () => creds,
        pool,
        timeoutSeconds: 5,
        command: "echo",
    });

    const ok = await probe(HOSTS[0]);
    if (!ok.ok) throw new Error(`probe failed: ${ok.error}`);
    if (typeof ok.latencyMs !== "number" || ok.latencyMs < 0) {
        throw new Error(`latency=${ok.latencyMs}`);
    }
    if (created !== 1) throw new Error(`connections=${created}, want 1`);

    // The second probe reuses the pooled connection.
    await probe(HOSTS[0]);
    if (created !== 1) throw new Error(`connections=${created}, want 1`);
    if (pool.size !== 1) throw new Error(`pool size=${pool.size}, want 1`);

    pool.closeAll();

    // A failing command is reported as a problem, not as an exception.
    const failing = new ConnectionPool({
        idleMs: 60_000,
        maxHosts: 4,
        connect: async () => makeClient(1, "boom\n"),
    });
    const failProbe = createSshProbe({
        getCreds: async () => creds,
        pool: failing,
        timeoutSeconds: 5,
        command: "false",
    });
    const bad = await failProbe(HOSTS[0]);
    if (bad.ok) throw new Error("a failing command must not be 'up'");
    if (!bad.error || !bad.error.includes("boom")) {
        throw new Error(`error=${bad.error}`);
    }
    failing.closeAll();
});

// ── 4. the pool snapshot ───────────────────────────────────────────────────

test("monitor: the pool snapshot reports the live connections", async () => {
    const { ConnectionPool } = await import("../dist/pool.js");

    const fakeConnect = async () => {
        const client = new EventEmitter();
        client.end = () => {};
        return client;
    };

    const pool = new ConnectionPool({ idleMs: 60_000, maxHosts: 4, connect: fakeConnect });
    if (pool.snapshot().length !== 0) throw new Error("a fresh pool is not empty");
    if (pool.limits.idleMs !== 60_000 || pool.limits.maxHosts !== 4) {
        throw new Error(`limits=${JSON.stringify(pool.limits)}`);
    }

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

    const lease = await pool.acquire(creds, 5);
    const snap = pool.snapshot();
    if (snap.length !== 1) throw new Error(`snapshot=${snap.length}, want 1`);
    if (snap[0].hostId !== "h1") throw new Error(`hostId=${snap[0].hostId}`);
    if (snap[0].active !== 1) throw new Error(`active=${snap[0].active}`);
    if (snap[0].createdAt > Date.now()) throw new Error("createdAt is in the future");

    lease.release();
    pool.closeAll();
    if (pool.snapshot().length !== 0) throw new Error("closeAll left entries");
});

// ── runner ──────────────────────────────────────────────────────────────────

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
