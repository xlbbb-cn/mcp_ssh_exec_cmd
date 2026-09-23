/**
 * Path resolution for the MCP server's on-disk state.
 *
 * Configuration directory (in order of preference):
 *   1. `MCP_SSH_CONFIG_DIR` env var (explicit override)
 *   2. `<user_home>/.mcp-ssh-server`
 *
 * Storage file: `<config_dir>/hosts.json`
 * Master key:   `<config_dir>/master.key` (see master_key.ts)
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const HOSTS_FILE = "hosts.json";

export function getConfigDir(): string {
    const override = process.env.MCP_SSH_CONFIG_DIR?.trim();
    if (override) return override;
    return join(homedir(), ".mcp-ssh-server");
}

export function getHostsFilePath(): string {
    return join(getConfigDir(), HOSTS_FILE);
}
