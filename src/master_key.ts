/**
 * Resolve the master key used to encrypt at-rest host secrets.
 *
 * Resolution order:
 *   1. `MCP_SSH_MASTER_KEY` env var — must be hex-encoded 32 bytes.
 *   2. The file `<config_dir>/master.key` — created on first use with
 *      32 random bytes (mode 0o600 on POSIX).
 *
 * The master key never leaves the process; we only use it to derive
 * per-message AES-256-GCM keys via PBKDF2.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { getConfigDir } from "./paths.js";

const MASTER_KEY_FILE = "master.key";
const MASTER_KEY_BYTES = 32;

export async function loadMasterKey(): Promise<Buffer> {
    const envKey = process.env.MCP_SSH_MASTER_KEY?.trim();
    if (envKey) {
        const buf = Buffer.from(envKey, "hex");
        if (buf.length !== MASTER_KEY_BYTES) {
            throw new Error(
                `MCP_SSH_MASTER_KEY must be ${MASTER_KEY_BYTES} bytes hex ` +
                `(got ${buf.length} bytes)`,
            );
        }
        return buf;
    }

    const dir = getConfigDir();
    const filePath = join(dir, MASTER_KEY_FILE);
    if (existsSync(filePath)) {
        const raw = await readFile(filePath);
        if (raw.length !== MASTER_KEY_BYTES) {
            throw new Error(
                `${filePath} is not a valid master key ` +
                `(expected ${MASTER_KEY_BYTES} bytes, got ${raw.length})`,
            );
        }
        return raw;
    }

    // First-run: generate and persist.
    const key = randomBytes(MASTER_KEY_BYTES);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, key, { mode: 0o600 });
    // Best-effort chmod for the case where writeFile didn't honour mode.
    if (process.platform !== "win32") {
        try {
            await chmod(filePath, 0o600);
        } catch {
            // ignore — non-fatal
        }
    }
    return key;
}
