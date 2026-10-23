# mcp-ssh-server

> 独立的 stdio MCP 服务器，把项目里的「SSH 主机管理」与「SSH 远程命令执行」打包成 MCP 工具。
> 同时提供交互式 / 命令行 TUI (`remote-ssh-cli`) 用于本地管理 SSH 主机。
>
> 源代码对应 `app/services/llm_tools.py`（LLM 工具调度器） + `app/utils/ssh_helper.py`（paramiko SSH 客户端） + `app/models/host.py`（主机模型）的等价 Node.js 实现，可被任何支持 MCP 协议的客户端（Claude Desktop、Continue、自研 Agent 等）通过 `npx` 启动调用。

## 特性

- **完全独立**：自带加密 JSON 存储（`~/.mcp-ssh-server/hosts.json`），不依赖 FastAPI 后端 / 数据库。
- **零外部依赖**：Node.js 原生 `crypto` 做 AES-256-GCM 加密；纯 JS 的 [`ssh2`](https://github.com/mscdex/ssh2) 做 SSH 客户端，Windows / macOS / Linux 通吃。
- **stdio MCP**：完全符合 [Model Context Protocol](https://modelcontextprotocol.io/) 的 stdio 传输规范，可被 `npx` 直接拉起。
- **凭据零外泄**：host 工具的响应永远不返回密码 / 私钥；SSH 工具内部解密后只用于建立连接，响应里也不回显。

## 工具一览

| 工具 | 说明 |
|---|---|
| `cli_help` | 返回 `remote-ssh-cli` 的安装 / 用法 / 排障说明（按 topic 分节） |
| `host_list` | 列出所有主机（**只返回 `id` 与 `ip_address`**，不含任何凭据） |
| `host_get` | 获取单个主机的公开信息（不含凭据） |
| `host_create` | 新增一台主机（密码 / 私钥 / 私钥口令会被加密落盘） |
| `host_update` | 更新主机字段（未提供的凭据字段保持原值） |
| `host_delete` | 删除主机 |
| `ssh_run_command` | 在指定主机上执行单条非交互命令 |
| `ssh_run_interactive` | 在指定主机上执行需要 expect/answer 提示的命令（sudo 等） |
| `ssh_run_playbook` | 在指定主机上跑多步骤 playbook（结构化 `# @on` / 旧式 `expect:`/`answer:` 都支持） |

`host_get_login`（Python 端的安全包装）等价于 `host_get` —— 本服务从设计上就不向 LLM 暴露凭据。

## 快速开始

```bash
cd mcp-ssh-server
npm install
npm run build
```

构建产物在 `dist/`，提供两个 bin 入口：

| 命令 | 入口 | 用途 |
|---|---|---|
| `remote-ssh-server` | `dist/index.js` | stdio MCP 服务器（被 MCP 客户端启动） |
| `remote-ssh-cli` | `dist/cli.js` | 交互式 / 命令行主机管理 TUI |

### 全局安装（CLI 管理工具）

```bash
npm run build
npm install -g --allow-scripts=ssh2,cpu-features .
```

之后可直接使用 `remote-ssh-cli` 命令管理 SSH 主机：

```bash
remote-ssh-cli          # 交互式 TUI
remote-ssh-cli list     # JSON 列表
remote-ssh-cli get <id>
remote-ssh-cli create <json-file>
remote-ssh-cli update <id> <json-file>
remote-ssh-cli delete <id>
remote-ssh-cli import <csv-file> [--dry-run]   # 批量导入主机
```

### CSV 批量导入

`remote-ssh-cli import hosts.csv` 会把 CSV 里的每一行导入成一台主机。
首行必须是表头，且至少包含 `ip_address` 列：

```csv
ip_address,system_name,ssh_port,ssh_username,ssh_auth_method,ssh_password
192.168.1.100,web-01,22,root,password,secret
192.168.1.101,db-01,2222,deploy,password,secret
```

| 列 | 说明 | 默认值 |
|---|---|---|
| `ip_address` | 必填，主机地址，全表唯一 | — |
| `system_name` | 备注名 | 空 |
| `ssh_port` | SSH 端口 | `22` |
| `ssh_username` | SSH 用户名 | `root` |
| `ssh_auth_method` | `password` / `pubkey` | `password` |
| `ssh_password` | 明文密码（落盘前加密） | — |
| `ssh_private_key` | 明文私钥内容（落盘前加密） | — |
| `ssh_private_key_path` | 私钥文件路径（与 `ssh_private_key` 二选一） | — |
| `ssh_private_key_passphrase` | 私钥口令（落盘前加密） | — |
| `is_enable` | `true/false/1/0/yes/no` | `true` |

- 字段名大小写不敏感，支持 `ip` / `host` / `name` / `port` / `user` 等别名。
- 引号内的逗号、换行、`""` 转义都按 RFC 4180 解析，私钥内容不会被拆坏。
- **单行错误不会中断整批导入**：每行最终会被归类为 created / skipped（IP 重复）/ failed（数据非法），命令以摘要形式打印，失败行数 > 0 时退出码为 1。
- `--dry-run` 只做校验与报告，不写盘。

> **Windows 注意**：如果遇到 `JScript 编译错误 (800A03EA)`，请确保 npm 版本 >= 10.8.0，或直接在 **cmd.exe** 中运行（而非 PowerShell），因为 npm 生成的 `.ps1` 包装脚本在旧版本中可能不会显式调用 `node`。本包已为入口文件添加 `#!/usr/bin/env node` shebang。

### 在 Claude Desktop 中注册

`~/Library/Application Support/Claude/claude_desktop_config.json`（macOS）或 `%APPDATA%\Claude\claude_desktop_config.json`（Windows）：

```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["-y", "-p", "file:./mcp-ssh-server", "remote-ssh-server"]
    }
  }
}
```

> 仓库内首次使用推荐用 `file:./mcp-ssh-server` 让 npx 直接走本地源码；发布到 npm 后可省略路径：
> ```json
> "args": ["-y", "remote-ssh-cmd"]
> ```

## 配置

通过环境变量：

| 变量 | 说明 | 默认值 |
|---|---|---|
| `MCP_SSH_MASTER_KEY` | 32 字节的十六进制字符串（64 个 hex 字符）。**设置后必须妥善备份**：换机器 / 换值都会导致现有 `hosts.json` 里的凭据全部无法解密 | 首次启动时自动生成，存到 `<config_dir>/master.key` |
| `MCP_SSH_CONFIG_DIR` | 配置目录覆盖 | `~/.mcp-ssh-server` |
| `MCP_SSH_POOL_IDLE_MS` | SSH 连接池中空闲连接的存活时间（毫秒）。`0` 表示完全关闭连接池，每次命令都新建连接 | `60000` |
| `MCP_SSH_POOL_MAX_HOSTS` | 连接池最多缓存多少台主机（超出时回收最久未用的空闲连接） | `32` |

### SSH 连接池

- 每台主机只保留 **一条** SSH 连接，同一台主机上的连续命令、playbook 的多个步骤都会复用它。
- 连接池按「主机 id + 凭据指纹」管理：密码 / 私钥 / 地址 / 端口 / 用户名任一项变化，缓存的连接立刻作废，下次命令重新建连；`host_update` / `host_delete` 也会主动丢弃对应连接。
- 空闲连接在 `MCP_SSH_POOL_IDLE_MS` 之后关闭；被对端断开的连接会在下次使用时自动重连（最多重试一次）。
- 进程退出（MCP 客户端断开）时会关闭全部池化连接。

### 超时语义

`ssh_run_command` / `ssh_run_interactive` 的 `timeout_seconds` 是**硬上限**：超时后命令会被终止，结果里 `success=false`、`exit_code=null`，并在 `stderr` 里写明超时。`ssh_run_playbook` 的 `timeout_seconds` 是**整个 playbook 的总预算**，每个步骤只能用剩余时间。

## 存储

- `hosts.json`：所有主机记录的明文 JSON，明文字段不加密，**`ssh_password` / `ssh_private_key` / `ssh_private_key_passphrase` 字段是加密后的 base64 字符串**。
- `master.key`：32 字节主密钥（POSIX 上 `0o600` 权限）。
- 写文件用「先写 `.tmp` 再 rename」的方式，崩溃不会留半文件。

整个目录应该被加入 `gitignore`：

```gitignore
# mcp-ssh-server state
.mcp-ssh-server/
```

## 开发

```bash
npm run dev   # tsc -w
npm test      # smoke tests
```

### Smoke 测试

`npm test` 依次跑三个脚本（都不依赖真实 SSH 服务器）：

- `test/smoke.mjs`：加密 + 解密往返（crypto.ts）、HostStore CRUD 完整路径（含加密落盘 / 读取 / 列表 / 更新 / 删除）、parsePlaybook 对结构化与旧式两种格式的解析。
- `test/features_smoke.mjs`：CSV 解析与主机行映射、批量导入（含 dry-run 与重复 IP 跳过）、连接池的复用 / 凭据变更作废 / 空闲回收、playbook 解析的边界情况。
- `test/mcp_smoke.mjs`：以子进程拉起 MCP 服务器，走一遍 JSON-RPC 握手，校验 9 个工具都被正确注册、`host_list` 只暴露 `id` 与 `ip_address`、密码不会出现在任何响应里。

运行单个文件：

```bash
node test/smoke.mjs
node test/features_smoke.mjs
node test/mcp_smoke.mjs
```

## 与 FastAPI 后端的关系

| 维度 | Python 后端 | 本 MCP |
|---|---|---|
| 数据存储 | PostgreSQL / SQLite（`app.models.host`） | 本地 JSON 文件（`~/.mcp-ssh-server/hosts.json`） |
| 加密 | Fernet (AES-128-CBC + HMAC) | AES-256-GCM + PBKDF2 |
| SSH 客户端 | paramiko | ssh2 |
| 协议 | HTTP REST（`/api/v1/hosts` 等） | MCP (JSON-RPC over stdio) |
| 鉴权 | RBAC (`host:*` 权限码) | 单用户本地进程（靠文件系统权限保护密钥） |

> 设计上故意不复用同一份存储 —— 一旦绑了数据库或 API，本 MCP 就不能脱离后端独立运行；反之，复用同一份 JSON 让 MCP 端和后端在数据一致性上会出问题。
>
> 如需从 FastAPI 后端迁移主机数据，可自行写一个一次性脚本：调用 `/api/v1/hosts` 列表（需要 `host:secure:read`），用同样的字段 shape 调本 MCP 的 `host_create` 即可。

## 已知限制

- 主机数据是单文件 JSON，不适合几千条以上的主机规模（读写都全量重写）。
- 没有并发写保护 —— 同一时刻不要在两个进程里启动本 MCP。
- 没有审计日志 / 操作回溯；如需审计请把 SSH 输出落到外层 Agent 的对话记录里。
