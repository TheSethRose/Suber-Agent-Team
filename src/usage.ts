/**
 * Token accounting: per-worker usage, the per-call usage log, and the `usage` report.
 *
 * Input is split the way the Messages API bills it: `inputTokens` is uncached input only, cache
 * writes and cache reads are reported separately (and priced differently), so the total prompt
 * size is the sum of all three.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Anthropic list prices (5-minute cache TTL). Override or extend with `pricing` in the config. */
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};

export function emptyUsage(model: string): Usage {
  return { model, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
}

/** Total prompt tokens sent, cached or not. */
export function promptTokens(u: Usage): number {
  return u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens;
}

/** Sum usage per model. */
export function byModel(usages: Usage[]): Usage[] {
  const out = new Map<string, Usage>();
  for (const u of usages) {
    const t = out.get(u.model) ?? emptyUsage(u.model);
    t.inputTokens += u.inputTokens;
    t.outputTokens += u.outputTokens;
    t.cacheWriteTokens += u.cacheWriteTokens;
    t.cacheReadTokens += u.cacheReadTokens;
    out.set(u.model, t);
  }
  return [...out.values()];
}

/** Estimated USD, or undefined when the model has no price. */
export function estimateCost(u: Usage, pricing: Record<string, ModelPrice>): number | undefined {
  const p = pricing[u.model];
  if (!p) return undefined;
  return (
    (u.inputTokens * p.input +
      u.outputTokens * p.output +
      u.cacheWriteTokens * p.cacheWrite +
      u.cacheReadTokens * p.cacheRead) /
    1_000_000
  );
}

/** Append one line per MCP tool call. Best-effort: a logging failure never fails the call. */
export function logUsage(file: string, tool: string, usages: Usage[]): void {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ ts: new Date().toISOString(), tool, models: byModel(usages) });
    appendFileSync(file, line + "\n", { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`[suber] could not write usage log: ${(e as Error).message}\n`);
  }
}

/** `suber usage [--days N]`: totals by model and by day from the usage log. */
export function runUsageReport(file: string, pricing: Record<string, ModelPrice>, argv: string[]): void {
  const i = argv.indexOf("--days");
  const days = i >= 0 ? Number(argv[i + 1]) : 0;
  const since = days > 0 ? Date.now() - days * 86_400_000 : 0;
  if (!file || !existsSync(file)) {
    process.stdout.write(`No usage log at ${file || "(disabled)"}.\n`);
    return;
  }
  const all: Usage[] = [];
  const perDay = new Map<string, Usage[]>();
  let calls = 0;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    let rec: { ts: string; models: Usage[] };
    try {
      rec = JSON.parse(raw);
    } catch {
      continue;
    }
    if (Date.parse(rec.ts) < since) continue;
    calls++;
    const day = new Date(rec.ts).toLocaleDateString("en-CA"); // local YYYY-MM-DD
    for (const u of rec.models) {
      const full = { ...emptyUsage(u.model), ...u };
      all.push(full);
      perDay.set(day, [...(perDay.get(day) ?? []), full]);
    }
  }
  const fmt = (u: Usage) => {
    const cost = estimateCost(u, pricing);
    return (
      `${u.model}: ${u.inputTokens} in, ${u.cacheWriteTokens} cache write, ${u.cacheReadTokens} cache read, ` +
      `${u.outputTokens} out` + (cost === undefined ? " (no price)" : ` ~ $${cost.toFixed(4)}`)
    );
  };
  const total = (us: Usage[]) =>
    byModel(us).reduce((n, u) => n + (estimateCost(u, pricing) ?? 0), 0);
  const lines = [`${calls} tool call(s)${days > 0 ? ` in the last ${days} day(s)` : ""}`];
  for (const u of byModel(all)) lines.push(`  ${fmt(u)}`);
  lines.push(`  estimated total ~ $${total(all).toFixed(4)}`, "", "By day:");
  for (const [day, us] of [...perDay].sort()) lines.push(`  ${day}  ~ $${total(us).toFixed(4)}`);
  process.stdout.write(lines.join("\n") + "\n");
}
