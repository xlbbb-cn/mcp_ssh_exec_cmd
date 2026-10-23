/**
 * Minimal CSV reader plus host-row mapping.
 *
 * The CLI can bulk-import hosts from a CSV file.  A hand-rolled reader
 * is used on purpose: SSH private keys routinely contain commas, quotes
 * and newlines, so a naive ``line.split(",")`` corrupts them.  This
 * parser understands RFC 4180 quoting (``"a,b"`` and ``""`` escapes)
 * and keeps embedded newlines inside quoted fields.
 *
 * Expected columns (header row, case-insensitive):
 *
 *   ip_address               (required)
 *   system_name
 *   ssh_port                 (default 22)
 *   ssh_username             (default root)
 *   ssh_auth_method          (password | pubkey, default password)
 *   ssh_password
 *   ssh_private_key          (inline key material)
 *   ssh_private_key_path     (path to a key file, alternative to the above)
 *   ssh_private_key_passphrase
 *   is_enable                (true/false/1/0/yes/no, default true)
 */
import { readFileSync } from "node:fs";
import type { HostInput } from "./types.js";

export interface CsvParseError {
    /** 1-based line number of the offending row. */
    line: number;
    reason: string;
}

export interface CsvHostRow {
    /** 1-based line number of the row in the source file. */
    line: number;
    input: HostInput;
}

export interface CsvHostParseResult {
    rows: CsvHostRow[];
    errors: CsvParseError[];
}

const COLUMN_ALIASES: Record<string, string> = {
    ip: "ip_address",
    ip_address: "ip_address",
    host: "ip_address",
    name: "system_name",
    system_name: "system_name",
    port: "ssh_port",
    ssh_port: "ssh_port",
    user: "ssh_username",
    username: "ssh_username",
    ssh_username: "ssh_username",
    auth: "ssh_auth_method",
    ssh_auth_method: "ssh_auth_method",
    password: "ssh_password",
    ssh_password: "ssh_password",
    private_key: "ssh_private_key",
    ssh_private_key: "ssh_private_key",
    private_key_path: "ssh_private_key_path",
    ssh_private_key_path: "ssh_private_key_path",
    key_passphrase: "ssh_private_key_passphrase",
    ssh_private_key_passphrase: "ssh_private_key_passphrase",
    passphrase: "ssh_private_key_passphrase",
    enabled: "is_enable",
    is_enable: "is_enable",
    disable: "is_enable",
};

/**
 * Parse CSV text into rows of raw cells.
 *
 * Handles quoted fields, doubled quotes, embedded newlines and both
 * LF and CRLF line endings.  A trailing newline does not produce an
 * extra empty row.
 */
export function parseCsv(text: string): string[][] {
    const source = text.replace(/\r\n/g, "\n");
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    let i = 0;

    const endField = (): void => {
        row.push(field);
        field = "";
    };
    const endRow = (): void => {
        endField();
        rows.push(row);
        row = [];
    };

    while (i < source.length) {
        const ch = source[i];
        if (inQuotes) {
            if (ch === '"') {
                if (source[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                inQuotes = false;
                i += 1;
                continue;
            }
            field += ch;
            i += 1;
            continue;
        }
        if (ch === '"') {
            inQuotes = true;
            i += 1;
            continue;
        }
        if (ch === ",") {
            endField();
            i += 1;
            continue;
        }
        if (ch === "\n") {
            endRow();
            i += 1;
            continue;
        }
        field += ch;
        i += 1;
    }

    if (field.length > 0 || row.length > 0) {
        endRow();
    }
    return rows;
}

function normalizeHeader(name: string): string {
    const key = name.trim().toLowerCase().replace(/[\s-]+/g, "_");
    return COLUMN_ALIASES[key] ?? key;
}

function parseBool(value: string): boolean | undefined {
    const v = value.trim().toLowerCase();
    if (!v) return undefined;
    if (["true", "1", "yes", "y", "on"].includes(v)) return true;
    if (["false", "0", "no", "n", "off"].includes(v)) return false;
    return undefined;
}

/**
 * Parse CSV text into host inputs.  Rows that cannot be understood are
 * reported in ``errors`` instead of aborting the whole file.
 */
export function parseHostCsv(text: string): CsvHostParseResult {
    const rows = parseCsv(text);
    const result: CsvHostParseResult = { rows: [], errors: [] };
    if (rows.length === 0) {
        result.errors.push({ line: 1, reason: "file is empty" });
        return result;
    }

    const header = rows[0].map(normalizeHeader);
    const ipIndex = header.indexOf("ip_address");
    if (ipIndex === -1) {
        result.errors.push({
            line: 1,
            reason: "header must contain an 'ip_address' column",
        });
        return result;
    }

    const indexOf = (name: string): number => header.indexOf(name);
    const colIp = ipIndex;
    const colName = indexOf("system_name");
    const colPort = indexOf("ssh_port");
    const colUser = indexOf("ssh_username");
    const colAuth = indexOf("ssh_auth_method");
    const colPassword = indexOf("ssh_password");
    const colKey = indexOf("ssh_private_key");
    const colKeyPath = indexOf("ssh_private_key_path");
    const colPassphrase = indexOf("ssh_private_key_passphrase");
    const colEnabled = indexOf("is_enable");

    const cell = (cells: string[], index: number): string =>
        index >= 0 && index < cells.length ? cells[index].trim() : "";

    for (let r = 1; r < rows.length; r += 1) {
        const cells = rows[r];
        const line = r + 1;
        // Skip blank lines.
        if (cells.length === 1 && cells[0].trim() === "") continue;

        const ip = cell(cells, colIp);
        if (!ip) {
            result.errors.push({ line, reason: "ip_address is empty" });
            continue;
        }

        const input: HostInput = { ip_address: ip };

        const name = cell(cells, colName);
        if (name) input.system_name = name;

        const user = cell(cells, colUser);
        if (user) input.ssh_username = user;

        const portRaw = cell(cells, colPort);
        if (portRaw) {
            const port = Number(portRaw);
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                result.errors.push({
                    line,
                    reason: `ssh_port must be an integer between 1 and 65535 (got '${portRaw}')`,
                });
                continue;
            }
            input.ssh_port = port;
        }

        const authRaw = cell(cells, colAuth).toLowerCase();
        const authMethod = authRaw || "password";
        if (authMethod !== "password" && authMethod !== "pubkey") {
            result.errors.push({
                line,
                reason: `ssh_auth_method must be 'password' or 'pubkey' (got '${authRaw}')`,
            });
            continue;
        }
        input.ssh_auth_method = authMethod;

        const password = cell(cells, colPassword);
        if (password) input.ssh_password = password;

        const keyInline = cell(cells, colKey);
        const keyPath = cell(cells, colKeyPath);
        if (keyInline) {
            input.ssh_private_key = keyInline;
        } else if (keyPath) {
            try {
                input.ssh_private_key = readFileSync(keyPath, "utf-8");
            } catch (err) {
                result.errors.push({
                    line,
                    reason: `cannot read ssh_private_key_path '${keyPath}': ${(err as Error).message}`,
                });
                continue;
            }
        }

        const passphrase = cell(cells, colPassphrase);
        if (passphrase) input.ssh_private_key_passphrase = passphrase;

        const enabledRaw = cell(cells, colEnabled);
        if (enabledRaw) {
            const enabled = parseBool(enabledRaw);
            if (enabled === undefined) {
                result.errors.push({
                    line,
                    reason: `is_enable must be a boolean (got '${enabledRaw}')`,
                });
                continue;
            }
            input.is_enable = enabled;
        }

        if (authMethod === "password" && !input.ssh_password) {
            result.errors.push({
                line,
                reason: "ssh_password is required for auth_method=password",
            });
            continue;
        }
        if (authMethod === "pubkey" && !input.ssh_private_key) {
            result.errors.push({
                line,
                reason:
                    "ssh_private_key (or ssh_private_key_path) is required for auth_method=pubkey",
            });
            continue;
        }

        result.rows.push({ line, input });
    }

    return result;
}
