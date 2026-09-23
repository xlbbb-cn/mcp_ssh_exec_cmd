/**
 * Symmetric encryption helpers for at-rest secrets (SSH passwords and
 * private keys).
 *
 * Algorithm: AES-256-GCM with a key derived from a master key using
 * PBKDF2-SHA-256 (200k iterations, 16-byte random salt).  The
 * ciphertext layout is:
 *
 *     [ 16 bytes salt ][ 12 bytes iv ][ N bytes ciphertext+tag ]
 *
 * Both salt and IV are regenerated for every encryption call, so the
 * same plaintext always yields a different ciphertext.
 *
 * Master key resolution (in order):
 *   1. `MCP_SSH_MASTER_KEY` env var (hex-encoded 32 raw bytes)
 *   2. A file at `<config_dir>/master.key` (auto-generated 32 bytes on
 *      first use, stored with 0o600 permissions on POSIX systems)
 *
 * The master key is *never* logged or echoed in error messages.
 */
import {
    createCipheriv,
    createDecipheriv,
    randomBytes,
    pbkdf2Sync,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;       // 256 bits
const SALT_LEN = 16;      // PBKDF2 salt
const IV_LEN = 12;        // GCM nonce
const PBKDF2_ITERS = 200_000;
const PBKDF2_DIGEST = "sha256";

/** Derive a 32-byte AES key from the master key + per-message salt. */
function deriveKey(master: Buffer, salt: Buffer): Buffer {
    return pbkdf2Sync(master, salt, PBKDF2_ITERS, KEY_LEN, PBKDF2_DIGEST);
}

export function encryptSecret(plaintext: string, master: Buffer): string {
    if (typeof plaintext !== "string") {
        throw new TypeError("plaintext must be a string");
    }
    const salt = randomBytes(SALT_LEN);
    const iv = randomBytes(IV_LEN);
    const key = deriveKey(master, salt);
    const cipher = createCipheriv(ALGO, key, iv);
    const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    // base64-encode the whole blob so it survives JSON round-trips.
    return Buffer.concat([salt, iv, tag, ciphertext]).toString("base64");
}

export function decryptSecret(token: string, master: Buffer): string {
    if (!token) return "";
    const buf = Buffer.from(token, "base64");
    if (buf.length < SALT_LEN + IV_LEN + 16) {
        throw new Error("ciphertext is too short to be valid");
    }
    const salt = buf.subarray(0, SALT_LEN);
    const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const tag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + 16);
    const ciphertext = buf.subarray(SALT_LEN + IV_LEN + 16);
    const key = deriveKey(master, salt);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]);
    return plaintext.toString("utf8");
}

/**
 * Return a UI-safe masked representation of a secret.
 * Mirrors the Python ``mask_secret`` helper in app/core/crypto.py.
 */
export function maskSecret(plaintext: string): string {
    if (!plaintext) return "";
    if (plaintext.length <= 8) return "***";
    return `${plaintext.slice(0, 3)}***${plaintext.slice(-4)}`;
}
