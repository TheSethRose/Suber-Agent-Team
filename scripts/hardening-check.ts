/**
 * Hardening regression check. Builds a throwaway workspace with a symlink pointing outside it,
 * then asserts the worker tools refuse every escape and the root guard refuses denied folders.
 * Needs no API key and makes no API calls; it fetches https://example.com once to prove public
 * URLs still work. Run: bun run scripts/hardening-check.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FleetConfig } from "../src/config.js";
import { assertRootAllowed } from "../src/server.js";
import { buildToolset } from "../src/tools.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "suber-check-"));
const root = path.join(base, "root");
const denied = path.join(base, "denied");
fs.mkdirSync(root);
fs.mkdirSync(path.join(denied, "inner"), { recursive: true });
fs.writeFileSync(path.join(root, "a.txt"), "hello\n");
fs.writeFileSync(path.join(base, "outside.txt"), "secret\n");
fs.symlinkSync(path.join(base, "outside.txt"), path.join(root, "link.txt"));

const config = {
  tools: ["read_file", "glob", "list_dir", "grep", "web_fetch"],
  capabilities: { write: false, bash: false },
  workspaceRoot: root,
  deniedRoots: [denied],
} as unknown as FleetConfig;
const tools = Object.fromEntries(buildToolset(config).map((t) => [t.name, t]));

let failures = 0;
async function expect(label: string, allowed: boolean, run: () => unknown): Promise<void> {
  let ok: boolean;
  try {
    await run();
    ok = allowed;
  } catch {
    ok = !allowed;
  }
  if (!ok) failures++;
  console.log(`${ok ? "pass" : "FAIL"}  ${allowed ? "allow" : "block"}  ${label}`);
}

await expect("read_file inside root", true, () => tools.read_file!.run({ path: "a.txt" }));
await expect("read_file through symlink", false, () => tools.read_file!.run({ path: "link.txt" }));
await expect("read_file ../", false, () => tools.read_file!.run({ path: "../outside.txt" }));
await expect("glob ../*", false, () => tools.glob!.run({ pattern: "../*" }));
await expect("grep glob ../**", false, () => tools.grep!.run({ pattern: "secret", glob: "../**" }));
await expect("web_fetch 127.0.0.1", false, () => tools.web_fetch!.run({ url: "http://127.0.0.1:1/" }));
await expect("web_fetch localhost", false, () => tools.web_fetch!.run({ url: "http://localhost/" }));
await expect("web_fetch metadata", false, () => tools.web_fetch!.run({ url: "http://169.254.169.254/" }));
await expect("web_fetch public URL", true, () => tools.web_fetch!.run({ url: "https://example.com/", maxChars: 50 }));
await expect("root outside denied", true, () => assertRootAllowed(config, root));
await expect("root = denied", false, () => assertRootAllowed(config, denied));
await expect("root inside denied", false, () => assertRootAllowed(config, path.join(denied, "inner")));
await expect("root above denied", false, () => assertRootAllowed(config, base));

fs.rmSync(base, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
