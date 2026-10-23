#!/usr/bin/env node
// CLI/TUI for managing SSH hosts
import { HostStore } from "./storage.js";
import { loadMasterKey } from "./master_key.js";
import { importHostCsv } from "./importer.js";
import * as fs from "fs";
import * as readline from "readline";

const USAGE = "usage: remote-ssh-cli <command> [args]";

function printHost(host: Record<string, unknown>) {
  const { id, ip_address, system_name, ssh_username, ssh_port, ssh_auth_method } = host;
  console.log(`${id} | ${system_name ?? "(no name)"} (${ssh_username}@${ip_address}:${ssh_port}) [${ssh_auth_method}]`);
}

/** Parse a port from user input; returns undefined for blank input. */
function parsePort(raw: string): number | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`ssh_port must be an integer between 1 and 65535 (got '${text}')`);
  }
  return port;
}

/** Read a private key file; returns undefined when the path is blank. */
function readKeyFile(raw: string): string | undefined {
  const path = raw.trim();
  if (!path) return undefined;
  try {
    return fs.readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`cannot read private key file '${path}': ${(err as Error).message}`);
  }
}

/**
 * Import hosts from a CSV file.
 *
 * Returns the process exit code to use (1 when rows failed) so the
 * interactive TUI can report the problem and return to the menu
 * instead of terminating the whole session.
 */
async function runImport(store: HostStore, file: string, dryRun: boolean): Promise<number> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    console.error(`cannot read '${file}': ${(err as Error).message}`);
    return 1;
  }

  const outcome = await importHostCsv(store, text, { dryRun });

  if (outcome.created.length > 0) {
    console.log(`${dryRun ? "would create" : "created"} ${outcome.created.length} host(s)`);
    for (const host of outcome.created) {
      printHost(host as unknown as Record<string, unknown>);
    }
  }
  if (outcome.skipped.length > 0) {
    console.log(`skipped ${outcome.skipped.length} row(s):`);
    for (const s of outcome.skipped) {
      console.log(`  line ${s.line} (${s.ip_address}): ${s.reason}`);
    }
  }
  if (outcome.failed.length > 0) {
    console.error(`failed ${outcome.failed.length} row(s):`);
    for (const f of outcome.failed) {
      console.error(`  line ${f.line}: ${f.reason}`);
    }
    return 1;
  }
  if (outcome.created.length === 0 && outcome.skipped.length === 0) {
    console.log("nothing to import");
  }
  return 0;
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
6) Import hosts from CSV
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
          const user = (await ask("SSH username (ssh_username) [root]: ")).trim();
          const portStr = await ask("SSH port (ssh_port) [22]: ");
          const auth = (await ask("Auth type (ssh_auth_method) [password/pubkey]: ")).trim().toLowerCase();

          const input: Record<string, unknown> = {};
          if (name.trim()) input.system_name = name.trim();
          if (ip.trim()) input.ip_address = ip.trim();
          input.ssh_username = user || "root";
          input.ssh_auth_method = auth || "password";

          try {
            input.ssh_port = portStr.trim() ? parsePort(portStr) : 22;
            if (input.ssh_auth_method === "password") {
              const pwd = await ask("Password (ssh_password): ");
              if (pwd.trim()) input.ssh_password = pwd;
            } else if (input.ssh_auth_method === "pubkey") {
              const key = readKeyFile(await ask("Private key file path: "));
              if (key !== undefined) input.ssh_private_key = key;
              const pp = await ask("Passphrase (optional): ");
              if (pp.trim()) input.ssh_private_key_passphrase = pp.trim();
            }

            const created = await store.create(input as any);
            console.log("Created host id:", created.id);
          } catch (err) {
            console.log("Error:", (err as Error).message);
          }
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
          const auth = (await ask(`Auth method [${existing.ssh_auth_method}]: `)).trim().toLowerCase();

          const patch: Record<string, unknown> = {};
          if (name.trim()) patch.system_name = name.trim();
          if (ip.trim()) patch.ip_address = ip.trim();
          if (user.trim()) patch.ssh_username = user.trim();
          if (auth === "password" || auth === "pubkey") patch.ssh_auth_method = auth;

          try {
            if (portStr.trim()) patch.ssh_port = parsePort(portStr);
            const effectiveAuth = auth || existing.ssh_auth_method;
            if (effectiveAuth === "password") {
              const pwd = await ask("New password (blank to keep): ");
              if (pwd.trim()) patch.ssh_password = pwd;
            } else if (effectiveAuth === "pubkey") {
              const key = readKeyFile(await ask("New private key file (blank to keep): "));
              if (key !== undefined) patch.ssh_private_key = key;
              const pp = await ask("New key passphrase (blank to keep): ");
              if (pp.trim()) patch.ssh_private_key_passphrase = pp.trim();
            }

            const updated = await store.update(id, patch as any);
            console.log(updated ? "Updated." : "Not found.");
          } catch (err) {
            console.log("Error:", (err as Error).message);
          }
          break;
        }
        case "5": {
          const id = (await ask("Host id to delete: ")).trim();
          const ok = await store.delete(id);
          console.log(ok ? "Deleted." : "Not found.");
          break;
        }
        case "6": {
          const file = (await ask("CSV file path: ")).trim();
          if (!file) { console.log("No file given."); break; }
          const dryRun = (await ask("Dry run (y/N): ")).trim().toLowerCase() === "y";
          try {
            const code = await runImport(store, file, dryRun);
            if (code !== 0) console.log("Import finished with errors (see above).");
          } catch (err) {
            console.log("Error:", (err as Error).message);
          }
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
        if (!id) { console.error(`${USAGE} get <host_id>`); process.exit(1); }
        const h = await store.getPublicById(id);
        if (!h) { console.error("not found"); process.exit(1); }
        console.log(JSON.stringify(h, null, 2));
        break;
      }
      case "create": {
        const file = args[1];
        if (!file) { console.error(`${USAGE} create <json-file>`); process.exit(1); }
        const data = JSON.parse(fs.readFileSync(file, "utf-8"));
        const created = await store.create(data);
        console.log("created id:", created.id);
        break;
      }
      case "update": {
        const id = args[1];
        const file = args[2];
        if (!id || !file) { console.error(`${USAGE} update <host_id> <json-file>`); process.exit(1); }
        const data = JSON.parse(fs.readFileSync(file, "utf-8"));
        const updated = await store.update(id, data);
        if (updated) console.log("updated");
        else { console.error("not found"); process.exit(1); }
        break;
      }
      case "delete": {
        const id = args[1];
        if (!id) { console.error(`${USAGE} delete <host_id>`); process.exit(1); }
        const ok = await store.delete(id);
        console.log(ok ? "deleted" : "not found");
        break;
      }
      case "import": {
        const file = args[1];
        if (!file) { console.error(`${USAGE} import <csv-file> [--dry-run]`); process.exit(1); }
        const code = await runImport(store, file, args.includes("--dry-run"));
        if (code !== 0) process.exit(code);
        break;
      }
      default:
        console.error(`unknown command: ${cmd}\nAvailable: list, get, create, update, delete, import`);
        process.exit(1);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
