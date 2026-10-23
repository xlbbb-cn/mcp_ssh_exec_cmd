# mcp-ssh-server

> A standalone **stdio MCP server** that turns *SSH host management* and *remote command execution* into MCP tools.
> It also ships an interactive / batch CLI (`remote-ssh-cli`) for managing SSH hosts on the local machine.
>
> 简体中文文档见 [README.zh-CN.md](./README.zh-CN.md)。

This is a Node.js re-implementation of the SSH-host half of a FastAPI project
(`app/services/llm_tools.py` + `app/utils/ssh_helper.py` + `app/models/host.py`) —
without the backend, without the database, without a network service. Any MCP
client (Claude Desktop, Continue, a custom agent, …) can start it with `npx`
and talk to it over JSON-RPC.

## Highlights

- **Fully standalone** — its own encrypted JSON store (`~/.mcp-ssh-server/hosts.json`); no FastAPI backend, no database.
- **No native dependencies** — Node's built-in `crypto` for AES-256-GCM, pure-JS [`ssh2`](https://github.com/mscdex/ssh2) for SSH; runs on Windows / macOS / Linux.
- **Standards-compliant stdio MCP** — speaks the [Model Context Protocol](https://modelcontextprotocol.io/) stdio transport and can be launched with `npx`.
- **Credentials never leave the server** — host tool responses never contain a password or a private key; the SSH tools decrypt them internally to open a connection and never echo them back.
- **Connection pooling** — one live SSH session per host, reused across commands and playbook steps.
- **CLI companion** — `remote-ssh-cli` manages the very same store (interactive TUI, batch commands, CSV bulk import).

## MCP tools

Eight tools are published:

| Tool | Description |
|---|---|
| `cli_help` | Installation / usage / troubleshooting notes for `remote-ssh-cli`, optionally narrowed down with `topic` |
| `host_list` | List the known hosts — **only `sys_name` and `uid`** (no address, user name or credential); `uid` is the `host_id` every other tool expects |
| `host_create` | Add a host (password / private key / passphrase are encrypted at rest) |
| `host_update` | Patch host fields (omitted credential fields keep their current value) |
| `host_delete` | Delete a host |
| `ssh_run_command` | Run a single non-interactive command on a host |
| `ssh_run_interactive` | Run a command that answers prompts (`sudo`, …) through `expect`/`answer` pairs |
| `ssh_run_playbook` | Run a multi-step playbook (structured `# @…` directives *or* legacy `expect:`/`answer:` lines) |

### The host identifier contract

- `host_list` is the entry point: every host comes back as exactly two fields — `sys_name` (the name) and `uid` (the unique identifier).
- Every other tool takes **that same value** under the name `host_id`. Pass it back unchanged; never assemble or guess one.
- When an id does not resolve, the tool answers with an actionable error:
  `Host '<id>' not found. host_id must be the exact 'uid' value returned by host_list — call host_list to obtain the valid identifiers.`
  Call `host_list` again and retry with the value it returns.
- `host_get` is deliberately **not published to MCP clients**: the model only ever sees `sys_name` + `uid`, never one host's address, user name or credential. The CLI keeps its own `get` subcommand for human operators.

### Arguments at a glance

| Tool | Arguments |
|---|---|
| `cli_help` | `topic?` — one of `install`, `list`, `get`, `create`, `update`, `delete`, `import`, `tui`, `windows` |
| `host_list` | `enabled_only?` (bool) |
| `host_create` | `ip_address` (required), `system_name?`, `ssh_port?` (1-65535, default `22`), `ssh_username?` (default `root`), `ssh_auth_method?` (`password` \| `pubkey`), `ssh_password?`, `ssh_private_key?`, `ssh_private_key_passphrase?`, `is_enable?` (default `true`) |
| `host_update` | `host_id` (required) plus any of the fields above — an omitted field keeps its current value |
| `host_delete` | `host_id` |
| `ssh_run_command` | `host_id`, `command`, `timeout_seconds` (1-600, **required**) |
| `ssh_run_interactive` | `host_id`, `command`, `expects?` (`[{ expect, answer }]`), `timeout_seconds` |
| `ssh_run_playbook` | `host_id`, `content` (the multi-line playbook body), `timeout_seconds` |

`ip_address` is unique across the store — creating a duplicate fails.

Command results come back as a plain text block:

```text
[stdout]
hello
[stderr]
[exit_code=0 success=true duration_ms=42]
```

## Quick start

```bash
git clone https://github.com/xlbbb-cn/mcp_ssh_exec_cmd.git
cd mcp_ssh_exec_cmd
npm install
npm run build
```

The build output lands in `dist/` and provides two binaries:

| Binary | Entry point | Purpose |
|---|---|---|
| `remote-ssh-server` | `dist/index.js` | the stdio MCP server (started by your MCP client) |
| `remote-ssh-cli` | `dist/cli.js` | interactive / batch host-management CLI |

### Install from GitHub Packages

The package is published to the **GitHub Packages** npm registry as
`@xlbbb-cn/mcp_ssh_exec_cmd`:

```bash
npm install -g @xlbbb-cn/mcp_ssh_exec_cmd --registry=https://npm.pkg.github.com
```

GitHub Packages requires authentication for installs as well — even for public
packages — so give npm a personal access token (classic) with the
`read:packages` scope first:

```bash
npm login --scope=@xlbbb-cn --auth-type=legacy --registry=https://npm.pkg.github.com
# Username: <your GitHub username>
# Password: <your PAT>
```

The same thing can be written into `~/.npmrc`:

```ini
//npm.pkg.github.com/:_authToken=<PAT>
@xlbbb-cn:registry=https://npm.pkg.github.com
```

### Global install (CLI)

From a local checkout:

```bash
npm run build
npm install -g --allow-scripts=ssh2,cpu-features .
```

Or straight from GitHub Packages:

```bash
npm install -g @xlbbb-cn/mcp_ssh_exec_cmd --registry=https://npm.pkg.github.com
```

Afterwards `remote-ssh-cli` is on your `PATH`:

```bash
remote-ssh-cli                        # interactive TUI
remote-ssh-cli list                   # JSON list of every host
remote-ssh-cli get <host_id>
remote-ssh-cli create <json-file>
remote-ssh-cli update <host_id> <json-file>
remote-ssh-cli delete <host_id>
remote-ssh-cli import <csv-file> [--dry-run]
```

`create` / `update` take a JSON file, e.g.:

```json
{
  "ip_address": "192.168.1.100",
  "system_name": "web-01",
  "ssh_port": 22,
  "ssh_username": "root",
  "ssh_auth_method": "password",
  "ssh_password": "your-password"
}
```

### CSV bulk import

`remote-ssh-cli import hosts.csv` turns every row of the file into one host.
The first line must be a header row containing at least an `ip_address` column:

```csv
ip_address,system_name,ssh_port,ssh_username,ssh_auth_method,ssh_password
192.168.1.100,web-01,22,root,password,secret
192.168.1.101,db-01,2222,deploy,password,secret
```

| Column | Description | Default |
|---|---|---|
| `ip_address` | required, host address, unique across the table | — |
| `system_name` | display name | empty |
| `ssh_port` | SSH port | `22` |
| `ssh_username` | SSH user name | `root` |
| `ssh_auth_method` | `password` / `pubkey` | `password` |
| `ssh_password` | plain-text password (encrypted before it hits the disk) | — |
| `ssh_private_key` | plain-text private key (encrypted before it hits the disk) | — |
| `ssh_private_key_path` | path to a key file (alternative to `ssh_private_key`) | — |
| `ssh_private_key_passphrase` | passphrase protecting the key (encrypted before it hits the disk) | — |
| `is_enable` | `true`/`false`/`1`/`0`/`yes`/`no` | `true` |

- Column names are case-insensitive and accept aliases (`ip`, `host`, `name`, `port`, `user`, `password`, …).
- Quoted commas, embedded newlines and `""` escapes are parsed per RFC 4180, so private key material is never mangled.
- **A bad row never aborts the batch**: every row ends up reported as created / skipped (duplicate IP) / failed (invalid data). The command prints a summary and exits with code `1` when at least one row failed.
- `--dry-run` only validates and reports — nothing is written.
- The CSV template (header + example row) is printed in the `remote-ssh-cli` banner, and `remote-ssh-cli import` without a file argument prints the same thing.

> **Windows note:** if you hit `JScript runtime error (800A03EA)`, make sure npm is >= 10.8.0 or run the command from **cmd.exe** instead of PowerShell — the `.ps1` wrapper npm generates may not invoke `node` explicitly on older npm versions. Both entry points ship a `#!/usr/bin/env node` shebang.

### Register it with an MCP client

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": [
        "--registry=https://npm.pkg.github.com",
        "-y",
        "-p",
        "@xlbbb-cn/mcp_ssh_exec_cmd",
        "remote-ssh-server"
      ]
    }
  }
}
```

The `file:` form points `npx` straight at your local checkout — handy while
developing, and it needs no registry at all:

```json
"args": ["-y", "-p", "file:./mcp_ssh_exec_cmd", "remote-ssh-server"]
```

## Configuration

Everything is configured through environment variables:

| Variable | Description | Default |
|---|---|---|
| `MCP_SSH_MASTER_KEY` | 32-byte key as a hex string (64 hex characters). **Back this up**: changing it — or moving to another machine — makes every credential in `hosts.json` undecryptable | generated on first start and stored in `<config_dir>/master.key` |
| `MCP_SSH_CONFIG_DIR` | override the configuration directory | `~/.mcp-ssh-server` |
| `MCP_SSH_POOL_IDLE_MS` | how long an idle pooled connection is kept (ms). `0` disables pooling entirely, so every command opens a fresh connection | `60000` |
| `MCP_SSH_POOL_MAX_HOSTS` | how many hosts the pool keeps alive (the least recently used idle connection is evicted beyond this) | `32` |

### SSH connection pool

- Every host keeps **one** SSH connection; consecutive commands and the steps of a playbook reuse it instead of reconnecting.
- The pool is keyed on the host id **plus a fingerprint of the credentials**. Changing the address, port, user name, auth method, password or key invalidates the cached connection right away; `host_update` and `host_delete` drop it explicitly.
- Idle connections are closed after `MCP_SSH_POOL_IDLE_MS`. A connection the peer dropped in the meantime is transparently re-established on the next use (one retry).
- All pooled connections are closed when the process exits (i.e. when the MCP client disconnects).

### Timeout semantics

`timeout_seconds` is a **hard cap**: when it expires the command is terminated
and the result reports `success=false`, `exit_code=null` plus a note in
`stderr`. For `ssh_run_playbook` the value is the budget for the **whole**
playbook — every step only gets the time that is left.

## Playbook format

`ssh_run_playbook` accepts a multi-line body. Two formats are supported.

**Structured** — directives start with `# @`:

```text
# @section "Restart nginx"
# @desc "Reload the reverse proxy after the config change"
systemctl stop nginx
# @on "systemctl start nginx"
expect: [sudo] password for deploy:
answer: secret
# @note "the site is back up"
# @danger "this drops active connections"
```

| Directive | Meaning |
|---|---|
| `# @section "Title"` | group the following steps under a section |
| `# @desc "…"` | description of the current section |
| `# @note "…"` | note attached to the current step |
| `# @danger "…"` | danger warning attached to the current step |
| `# @on "command"` | run this command interactively (answers the `expect:`/`answer:` pairs that follow) |

**Legacy** — one command per line, optionally followed by `expect:` / `answer:` pairs:

```text
sudo systemctl restart nginx
expect: [sudo] password for deploy:
answer: secret
```

Ordinary `#` comments are ignored. A playbook stops at the first non-zero exit
code and returns the transcript of every step that ran.

## Storage & security

- `hosts.json` — all host records as plain JSON. The metadata fields are stored
  in clear text; **`ssh_password`, `ssh_private_key` and
  `ssh_private_key_passphrase` hold base64 ciphertext**.
- `master.key` — the 32-byte master key (mode `0o600` on POSIX).
- Writes go through a `.tmp` file plus a rename, so a crash never leaves a half-written file behind.

Secrets are encrypted with **AES-256-GCM** using a key derived from the master
key with **PBKDF2-SHA-256** (200k iterations, 16-byte random salt). The layout
is `[16-byte salt][12-byte IV][16-byte tag][ciphertext]`; salt and IV are
fresh for every encryption, so the same plaintext never produces the same
ciphertext twice.

Keep the whole directory out of version control:

```gitignore
# mcp-ssh-server state
.mcp-ssh-server/
```

## Project layout

```text
src/
  index.ts        MCP entry point — stdio transport, tool registration, dispatch
  cli.ts          remote-ssh-cli — interactive TUI + batch subcommands
  pool.ts         ConnectionPool — one live SSH connection per host
  ssh.ts          ssh2 execution primitives + playbook parser/runner
  storage.ts      HostStore — hosts.json load/save with an atomic full-file rewrite
  csv.ts          RFC 4180 CSV reader + host-row mapping
  importer.ts     bulk-import orchestration
  crypto.ts       AES-256-GCM encryption of secrets at rest
  master_key.ts   master-key resolution (env var or key file)
  paths.ts        configuration-directory paths
  tools/
    _types.ts     shared MCP tool shape + the host-identifier wording
    hosts.ts      host_list / host_create / host_update / host_delete
    ssh_exec.ts   ssh_run_command / ssh_run_interactive / ssh_run_playbook
    help.ts       cli_help
test/
  smoke.mjs         encryption round-trip, HostStore CRUD, playbook parsing
  features_smoke.mjs  CSV parsing/import, connection pool behaviour
  mcp_smoke.mjs     end-to-end JSON-RPC handshake against a spawned server
```

## Development

```bash
npm run dev    # tsc --watch
npm run build  # tsc  (the only typecheck)
npm test       # all three smoke tests
```

`npm run build` is the verification step — there is no separate lint or format
configuration. The tests execute `dist/`, so build before testing.

### Smoke tests

`npm test` runs three plain Node scripts; none of them needs a real SSH server:

- `test/smoke.mjs` — encrypt/decrypt round-trip, the full HostStore CRUD path (encrypt on write, read back, list, update, delete) and playbook parsing for both formats.
- `test/features_smoke.mjs` — CSV parsing and host-row mapping, bulk import (including `--dry-run` and duplicate-IP skipping), connection-pool reuse / credential-change invalidation / idle eviction, and playbook parsing edge cases.
- `test/mcp_smoke.mjs` — spawns the MCP server as a child process, performs the JSON-RPC handshake and asserts that all 8 tools are registered, that `host_list` exposes only `sys_name` + `uid`, that `host_get` is *not* advertised, and that no password ever appears in a response.

Run a single file with `node test/<file>.mjs`. Every test isolates its state in
a temporary `MCP_SSH_CONFIG_DIR`, so your real `hosts.json` is never touched.

## Releasing

Releases are published to **GitHub Packages** by a GitHub Actions workflow
(`.github/workflows/publish.yml`). It builds, runs the smoke tests and
publishes with the built-in `GITHUB_TOKEN` — no long-lived secret is stored in
the repository — and npm provenance is attached to the tarball.

```bash
# 1. bump the version in package.json, commit
git commit -am "chore: release v0.1.1" && git push github master

# 2. tag it — the tag triggers the publish workflow
git tag v0.1.1
git push github v0.1.1
```

The workflow can also be started by hand from the **Actions** tab
(`workflow_dispatch`); tick `dry_run` to verify the tarball without publishing.

The resulting package shows up under
<https://github.com/xlbbb-cn/mcp_ssh_exec_cmd/packages>.

## Relation to the FastAPI backend

| Aspect | Python backend | This MCP server |
|---|---|---|
| Storage | PostgreSQL / SQLite (`app.models.host`) | local JSON file (`~/.mcp-ssh-server/hosts.json`) |
| Encryption | Fernet (AES-128-CBC + HMAC) | AES-256-GCM + PBKDF2 |
| SSH client | paramiko | ssh2 |
| Protocol | HTTP REST (`/api/v1/hosts`, …) | MCP (JSON-RPC over stdio) |
| AuthN/AuthZ | RBAC (`host:*` permission codes) | single-user local process, protected by file-system permissions |

> Sharing one storage backend is deliberately avoided: as soon as a database or
> an API is involved, this server can no longer run standalone — and pointing
> both the MCP server and the backend at the same JSON file would create
> consistency problems.
>
> To migrate hosts from the FastAPI backend, write a one-off script: list
> `/api/v1/hosts` (requires `host:secure:read`) and feed the same field shape
> into this server's `host_create`.

## Known limitations

- The host data lives in a single JSON file that is rewritten in full on every
  change — fine for hundreds of hosts, not for thousands.
- There is no concurrent-write protection: do not run two instances against the same `MCP_SSH_CONFIG_DIR` at the same time.
- There is no audit log or operation trail. If you need one, capture the SSH output in the calling agent's transcript.
- The MCP surface intentionally exposes no per-host metadata, so a model cannot look up a host's address or user name — it has to go through `host_list` / `host_create`.
