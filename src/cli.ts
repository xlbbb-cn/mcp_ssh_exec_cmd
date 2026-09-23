#!/usr/bin/env node
// CLI/TUI for managing SSH hosts
import { HostStore } from "./storage.js";
import { loadMasterKey } from "./master_key.js";
import * as fs from "fs";
import * as readline from "readline";

function printHost(host: Record<string, unknown>) {
  const { id, ip_address, system_name, ssh_username, ssh_port, ssh_auth_method } = host;
  console.log(`${id} | ${system_name ?? "(no name)"} (${ssh_username}@${ip_address}:${ssh_port}) [${ssh_auth_method}]`);
}

async function main() {
  const master = await loadMasterKey();
  const store = new HostStore(master);
  const args = process.argv.slice(2);

  if (args.length === 0) {
    // ── interactive TUI ──
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

    while (true) {
      const choice = await ask(
        `\nSSH Host Manager
1) List hosts
2) Get host
3) Create host
4) Update host
5) Delete host
0) Exit
Choose: `
      );
      switch (choice.trim()) {
        case "1": {
          const hosts = await store.listPublic();
          hosts.forEach((h) => printHost(h as unknown as Record<string, unknown>));
          break;
        }
        case "2": {
          const id = (await ask("Host id: ")).trim();
          const h = await store.getPublicById(id);
          if (h) printHost(h as unknown as Record<string, unknown>);
          else console.log("Not found");
          break;
        }
        case "3": {
          const name = await ask("Name (system_name): ");
          const ip = await ask("IP address / hostname (ip_address): ");
          const user = await ask("SSH username (ssh_username) [root]: ");
          const portStr = await ask("SSH port (ssh_port) [22]: ");
          const auth = (await ask("Auth type (ssh_auth_method) [password/pubkey]: ")).toLowerCase();

          const input: Record<string, unknown> = {};
          if (name.trim()) input.system_name = name.trim();
          if (ip.trim()) input.ip_address = ip.trim();
          if (user.trim()) input.ssh_username = user.trim();
          else input.ssh_username = "root";
          input.ssh_port = portStr.trim() ? parseInt(portStr.trim(), 10) : 22;
          input.ssh_auth_method = auth;

          if (auth === "password") {
            const pwd = await ask("Password (ssh_password): ");
            if (pwd.trim()) input.ssh_password = pwd;
          } else if (auth === "pubkey") {
            const keyPath = await ask("Private key file path: ");
            if (keyPath.trim()) {
              input.ssh_private_key = fs.readFileSync(keyPath.trim(), "utf-8");
            }
            const pp = await ask("Passphrase (optional): ");
            if (pp.trim()) input.ssh_private_key_passphrase = pp.trim();
          }

          const created = await store.create(input as any);
          console.log("Created host id:", created.id);
          break;
        }
        case "4": {
          const id = (await ask("Host id to update: ")).trim();
          const existing = await store.getPublicById(id);
          if (!existing) { console.log("Not found"); break; }
          console.log("Leave blank to keep current value.\n");

          const name = await ask(`Name [${existing.system_name}]: `);
          const ip = await ask(`IP address [${existing.ip_address}]: `);
          const user = await ask(`Username [${existing.ssh_username}]: `);
          const portStr = await ask(`Port [${existing.ssh_port}]: `);
          const auth = (await ask(`Auth method [${existing.ssh_auth_method}]: `)).toLowerCase();

          const patch: Record<string, unknown> = {};
          if (name.trim()) patch.system_name = name.trim();
          if (ip.trim()) patch.ip_address = ip.trim();
          if (user.trim()) patch.ssh_username = user.trim();
          if (portStr.trim()) patch.ssh_port = parseInt(portStr.trim(), 10);
          if (auth === "password" || auth === "pubkey") patch.ssh_auth_method = auth;

          if ((auth || existing.ssh_auth_method) === "password") {
            const pwd = await ask("New password (blank to keep): ");
            if (pwd.trim()) patch.ssh_password = pwd;
          } else if ((auth || existing.ssh_auth_method) === "pubkey") {
            const keyPath = await ask("New private key file (blank to keep): ");
            if (keyPath.trim()) {
              patch.ssh_private_key = fs.readFileSync(keyPath.trim(), "utf-8");
            }
          }

          const updated = await store.update(id, patch as any);
          if (updated) console.log("Updated.");
          else console.log("Not found.");
          break;
        }
        case "5": {
          const id = (await ask("Host id to delete: ")).trim();
          const ok = await store.delete(id);
          console.log(ok ? "Deleted." : "Not found.");
          break;
        }
        case "0":
          rl.close();
          process.exit(0);
        default:
          console.log("Invalid choice");
      }
    }
  } else {
    // ── batch CLI commands ──
    const cmd = args[0];
    switch (cmd) {
      case "list": {
        const hosts = await store.listPublic();
        console.log(JSON.stringify({ items: hosts, total: hosts.length }, null, 2));
        break;
      }
      case "get": {
        const id = args[1];
        if (!id) { console.error("usage: mcp-ssh get <host_id>"); process.exit(1); }
        const h = await store.getPublicById(id);
        if (!h) { console.error("not found"); process.exit(1); }
        console.log(JSON.stringify(h, null, 2));
        break;
      }
      case "create": {
        const file = args[1];
        if (!file) { console.error("usage: mcp-ssh create <json-file>"); process.exit(1); }
        const data = JSON.parse(fs.readFileSync(file, "utf-8"));
        const created = await store.create(data);
        console.log("created id:", created.id);
        break;
      }
      case "update": {
        const id = args[1];
        const file = args[2];
        if (!id || !file) { console.error("usage: mcp-ssh update <id> <json-file>"); process.exit(1); }
        const data = JSON.parse(fs.readFileSync(file, "utf-8"));
        const updated = await store.update(id, data);
        if (updated) console.log("updated");
        else { console.error("not found"); process.exit(1); }
        break;
      }
      case "delete": {
        const id = args[1];
        if (!id) { console.error("usage: mcp-ssh delete <id>"); process.exit(1); }
        const ok = await store.delete(id);
        console.log(ok ? "deleted" : "not found");
        break;
      }
      default:
        console.error(`unknown command: ${cmd}\nAvailable: list, get, create, update, delete`);
        process.exit(1);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
