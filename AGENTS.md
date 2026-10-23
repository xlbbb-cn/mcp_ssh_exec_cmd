# AGENTS.md

Standalone stdio MCP server (TypeScript/ESM) for local SSH host storage and remote command execution. No backend or database; all state is local.

## Commands

- `npm run build` — `tsc`; the only typecheck. Run after editing `src/` because tests execute `dist/`, not `src/`.
- `npm test` — runs `test/smoke.mjs`, `test/features_smoke.mjs`, `test/mcp_smoke.mjs`. Plain Node scripts, no test framework. Run one with `node test/<file>.mjs`.
- `npm run dev` — `tsc --watch` only; it does not run or restart the server.
- `npm start` — stdio MCP server (`dist/index.js`). It waits for JSON-RPC on stdin, so it looks idle in a terminal.
- `npm run tui` — host-management TUI (`dist/cli.js`); batch commands are `list`, `get`, `create`, `update`, `delete`, `import <csv>`.
- No lint/format config exists; `npm run build` is the verification step.

## Architecture

- `src/index.ts` — MCP entrypoint. Manually composes the tool factories, converts Zod shapes to JSON Schema, and dispatches calls. Register new tools here.
- `src/tools/hosts.ts` — host CRUD tools; `src/tools/ssh_exec.ts` — command/interactive/playbook tools; `src/tools/help.ts` — `cli_help`.
- `src/pool.ts` — `ConnectionPool`: one live SSH connection per host, reused across commands and playbook steps.
- `src/ssh.ts` — `ssh2` execution primitives (`execOnClient`, `shellOnClient`) plus the playbook parser/runner.
- `src/storage.ts` — `HostStore`: one `hosts.json`, loaded once into memory, atomic full-file rewrite (`.tmp` + rename). External edits while running are ignored; concurrent writers can overwrite each other.
- `src/csv.ts` / `src/importer.ts` — RFC 4180 CSV reader, host-row mapping, and the bulk-import orchestration.
- `src/crypto.ts`, `src/master_key.ts`, `src/paths.ts` — AES-256-GCM secrets, master-key resolution, config paths.
- `src/cli.ts` — CLI/TUI entrypoint. Package name is `remote-ssh-cmd`; bins are `remote-ssh-server` (`dist/index.js`) and `remote-ssh-cli` (`dist/cli.js`).

## Invariants and gotchas

- Node16 ESM resolution: relative imports in `src/` must use `.js` extensions (e.g. `./storage.js`).
- stdout is the MCP transport. Log only to stderr; a stray `console.log` corrupts the protocol.
- `host_list` deliberately exposes **only** `id` and `ip_address`. Do not widen it — `host_get` is the tool for full public metadata. Credentials never leave the server; `ssh_run_*` resolves them by `host_id`.
- `ssh_run_*` requires `timeout_seconds` (1-600) and rejects `is_enable=false` hosts. The timeout is a **hard cap**: a command still running when it expires is terminated (`success=false`, `exit_code=null`). For `ssh_run_playbook` it is the budget for the *whole* playbook — each step only gets the remaining time.
- The pool keys on host id **plus a credential fingerprint**; changing the password/key/address rotates the connection. `host_update` / `host_delete` also invalidate it explicitly — keep that in place when adding tools that mutate hosts.
- Default state dir is `~/.mcp-ssh-server`, overridden by `MCP_SSH_CONFIG_DIR`. It holds `hosts.json` (plaintext metadata + encrypted credential fields) and `master.key`. `MCP_SSH_MASTER_KEY` must be 64 hex chars (32 bytes); changing it makes existing credentials undecryptable.
- Pool knobs: `MCP_SSH_POOL_IDLE_MS` (default 60000, `0` disables pooling) and `MCP_SSH_POOL_MAX_HOSTS` (default 32).
- `dist/` and `node_modules/` are gitignored; a fresh clone must be built before running anything. `npm run build` does not clean `dist/` — delete it for a clean build if stale files appear (e.g. `dist/config.js` currently has no `src/config.ts` counterpart).
- CSV import must not abort a whole file on one bad row: every row ends up created / skipped (duplicate IP) / failed, and `npm test` asserts this.
- Both smoke tests isolate state with a temp `MCP_SSH_CONFIG_DIR`; preserve that isolation in new tests.
- README documents the CLI commands, the CSV column table, the pool env vars and the timeout semantics — update it in the same change whenever tool or CLI behaviour changes.
