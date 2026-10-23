# AGENTS.md

Standalone stdio MCP server (TypeScript/ESM) for local SSH host storage and remote command execution. No backend or database; all state is local.

## Commands

- `npm run build` — `tsc`; the only typecheck. Run after editing `src/` because tests execute `dist/`, not `src/`.
- `npm test` — runs `test/smoke.mjs`, `test/features_smoke.mjs`, `test/monitor_smoke.mjs`, `test/mcp_smoke.mjs`. Plain Node scripts, no test framework. Run one with `node test/<file>.mjs`.
- `npm run dev` — `tsc --watch` only; it does not run or restart the server.
- `npm start` — stdio MCP server (`dist/index.js`). It waits for JSON-RPC on stdin, so it looks idle in a terminal.
- `npm run tui` — host-management TUI (`dist/cli.js`); batch commands are `list`, `get`, `create`, `update`, `delete`, `import <csv>`, `monitor`.
- No lint/format config exists; `npm run build` is the verification step.

## Architecture

- `src/index.ts` — MCP entrypoint. Manually composes the tool factories, converts Zod shapes to JSON Schema, and dispatches calls. Register new tools here.
- `src/tools/hosts.ts` — host CRUD tools; `src/tools/ssh_exec.ts` — command/interactive/playbook tools; `src/tools/pool_status.ts` — `pool_status` (the MCP view of the live pool); `src/tools/help.ts` — `cli_help`.
- `src/pool.ts` — `ConnectionPool`: one live SSH connection per host, reused across commands and playbook steps. It also keeps the per-host command counters (`recordCommand` / `commandStatsSnapshot`) that `pool_status` renders.
- `src/redact.ts` — masks secrets and IP addresses in command lines and error messages before they leave the server. Use it for every new field that echoes user-supplied text.
- `src/ssh.ts` — `ssh2` execution primitives (`execOnClient`, `shellOnClient`) plus the playbook parser/runner.
- `src/storage.ts` — `HostStore`: one `hosts.json`, loaded once into memory, atomic full-file rewrite (`.tmp` + rename). External edits while running are ignored; concurrent writers can overwrite each other.
- `src/csv.ts` / `src/importer.ts` — RFC 4180 CSV reader, host-row mapping, and the bulk-import orchestration.
- `src/crypto.ts`, `src/master_key.ts`, `src/paths.ts` — AES-256-GCM secrets, master-key resolution, config paths.
- `src/cli.ts` — CLI/TUI entrypoint. Package name is `@xlbbb-cn/mcp_ssh_exec_cmd`; bins are `remote-ssh-server` (`dist/index.js`) and `remote-ssh-cli` (`dist/cli.js`).
- `src/monitor.ts` — live connection-pool monitor used by `remote-ssh-cli monitor`: redraws one frame per interval (default 1 s), quits on `q` / Ctrl+C. Storage-agnostic: the caller injects the hosts and a `probe` function; `createSshProbe` is the default one (runs a command through the pool).

## Invariants and gotchas

- Node16 ESM resolution: relative imports in `src/` must use `.js` extensions (e.g. `./storage.js`).
- stdout is the MCP transport. Log only to stderr; a stray `console.log` corrupts the protocol.
- `host_list` deliberately exposes **only** `sys_name` and `uid` (the host's UUID). Do not widen it — `host_get` is intentionally **not** published to MCP, so no single-host metadata tool exists. Credentials never leave the server; `ssh_run_*` resolves them by `host_id`.
- `pool_status` follows the same rule: one row per host with `uid` + `sys_name` only — never an address, port, user name or credential. Every command line and error message it renders goes through `src/redact.ts` (secrets masked, IP addresses replaced) before it leaves the server; keep it that way when adding columns.
- The pool's command counters are per process and in memory only: they describe the commands *this* server ran and are cleared when a host is deleted.
- Host identifier wording lives in `src/tools/_types.ts` (`HOST_ID_DESCRIPTION`, `HOST_LIST_HINT`, `hostNotFoundError`). `host_list` returns the id as `uid`; every other tool takes it as `host_id` — keep both texts in sync there, not inline, or the model starts passing invented ids.
- `ssh_run_*` requires `timeout_seconds` (1-600) and rejects `is_enable=false` hosts. The timeout is a **hard cap**: a command still running when it expires is terminated (`success=false`, `exit_code=null`). For `ssh_run_playbook` it is the budget for the *whole* playbook — each step only gets the remaining time.
- The pool keys on host id **plus a credential fingerprint**; changing the password/key/address rotates the connection. `host_update` / `host_delete` also invalidate it explicitly — keep that in place when adding tools that mutate hosts. `host_delete` additionally drops the host's command counters (`pool.forget`).
- Default state dir is `~/.mcp-ssh-server`, overridden by `MCP_SSH_CONFIG_DIR`. It holds `hosts.json` (plaintext metadata + encrypted credential fields) and `master.key`. `MCP_SSH_MASTER_KEY` must be 64 hex chars (32 bytes); changing it makes existing credentials undecryptable.
- Pool knobs: `MCP_SSH_POOL_IDLE_MS` (default 60000, `0` disables pooling) and `MCP_SSH_POOL_MAX_HOSTS` (default 32).
- `dist/` and `node_modules/` are gitignored; a fresh clone must be built before running anything. `npm run build` does not clean `dist/` — delete it for a clean build if stale files appear (e.g. `dist/config.js` currently has no `src/config.ts` counterpart).
- CSV import must not abort a whole file on one bad row: every row ends up created / skipped (duplicate IP) / failed, and `npm test` asserts this.
- The CLI monitor runs in its **own** process, so it shows its **own** pool — the MCP server's connections are invisible from the terminal. It probes every enabled host once per interval, so the probe command must stay cheap (`echo` by default).
- The monitor owns the terminal while it runs: stdin is switched to raw mode and the quit key is read from it. The interactive TUI must close its readline interface before starting the monitor and re-create it afterwards. Without a terminal there is no key to read, so the monitor prints a single frame instead of looping.
- Both smoke tests isolate state with a temp `MCP_SSH_CONFIG_DIR`; preserve that isolation in new tests.
- README documents the CLI commands, the CSV column table, the pool env vars and the timeout semantics — update it in the same change whenever tool or CLI behaviour changes.
- The package is published to **GitHub Packages**, **npmjs.org** and the **official MCP Registry** as `@xlbbb-cn/mcp_ssh_exec_cmd` (scope must match the owner). `.npmrc` routes `@xlbbb-cn:` to `https://npm.pkg.github.com`; `publishConfig.registry` pins the GitHub Packages publish target. Releases are driven by `.github/workflows/publish.yml` — push a `v*` tag to publish to all three (GitHub Packages uses the built-in `GITHUB_TOKEN`, npmjs.org uses trusted publishing with the `NPM_TOKEN` secret as fallback, the MCP Registry uses GitHub OIDC via `mcp-publisher`). Never commit a token into `.npmrc`.
- MCP Registry metadata lives in `server.json` (name `io.github.xlbbb-cn/mcp-ssh-exec-cmd`): `package.json`'s `mcpName` must equal `server.json`'s `name`, and both versions must match — `test/features_smoke.mjs` asserts this, and the `publish-mcp-registry` job re-syncs the version from `package.json` at publish time. The registry only accepts descriptions up to 100 characters.
