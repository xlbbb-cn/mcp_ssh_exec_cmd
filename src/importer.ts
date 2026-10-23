/**
 * Bulk import of hosts from CSV.
 *
 * The importer is deliberately forgiving: one malformed row must not
 * abort the whole file.  Every row is reported as created, skipped
 * (duplicate IP) or failed (invalid data), so the CLI can print a
 * summary the operator can act on.
 */
import { parseHostCsv } from "./csv.js";
import type { HostStore } from "./storage.js";
import type { HostPublic } from "./types.js";

export interface ImportSkipped {
    line: number;
    ip_address: string;
    reason: string;
}

export interface ImportFailed {
    line: number;
    reason: string;
}

export interface ImportOutcome {
    /** Hosts created (or that would be created in dry-run mode). */
    created: HostPublic[];
    /** Rows whose IP already exists (in the store or earlier in the file). */
    skipped: ImportSkipped[];
    /** Rows that could not be imported. */
    failed: ImportFailed[];
}

export async function importHostCsv(
    store: HostStore,
    text: string,
    options: { dryRun?: boolean } = {},
): Promise<ImportOutcome> {
    const parsed = parseHostCsv(text);
    const outcome: ImportOutcome = {
        created: [],
        skipped: [],
        failed: [...parsed.errors],
    };

    const seen = new Set<string>();

    for (const row of parsed.rows) {
        const ip = row.input.ip_address;
        if (seen.has(ip)) {
            outcome.skipped.push({
                line: row.line,
                ip_address: ip,
                reason: "duplicate ip_address in the same file",
            });
            continue;
        }
        seen.add(ip);

        try {
            const host = await store.create(row.input, {
                dryRun: options.dryRun ?? false,
            });
            outcome.created.push(host);
        } catch (err) {
            const reason = (err as Error).message ?? String(err);
            if (/already exists/i.test(reason)) {
                outcome.skipped.push({
                    line: row.line,
                    ip_address: ip,
                    reason,
                });
            } else {
                outcome.failed.push({ line: row.line, reason });
            }
        }
    }

    return outcome;
}
