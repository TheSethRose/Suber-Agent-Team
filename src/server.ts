/**
 * MCP server. Exposes a SMALL tool surface (delegate / fanout / map_reduce / research)
 * so it adds minimal schema overhead to the orchestrator's context. Each tool runs the
 * fleet on the cheap provider and returns concise text + a "tokens offloaded" footer.
 *
 * Model tiers: delegate -> scout, fanout -> scout, map_reduce -> scout map + synth reduce,
 * research -> synth lead + scout workers + synth synthesis. An explicit `model` (or `tier`)
 * always overrides the default.
 */
import path from "node:path";
import fs from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { FleetConfig, Tier } from "./config.js";
import {
  runFleet,
  runSingle,
  runMapReduce,
  runResearch,
  summarize,
  type FleetAgentResult,
} from "./agent.js";
import { emit, progressOn, type ProgressContext } from "./progress.js";
import { logUsage } from "./usage.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(t: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: t }], isError };
}

/** Monotonic run id for live-progress grouping (no-op cost when telemetry is off). */
let runSeq = 0;
function newRunId(): string {
  return `r${Date.now().toString(36)}${(runSeq++).toString(36)}`;
}

/** Build a progress context for a single-phase fleet call, or undefined when telemetry is off. */
function ctx(runId: string, phase: string, labels?: string[]): ProgressContext | undefined {
  return progressOn() ? { runId, phase, labels } : undefined;
}

/** Resolve the effective model + per-call limits for a tier (explicit model wins). */
function resolveTier(config: FleetConfig, tier: Tier, explicit?: string) {
  const model = explicit || config.models[tier];
  const isSynth = tier === "synth";
  return {
    model,
    maxTokens: isSynth ? config.synthMaxTokens : config.maxTokens,
    // thinking only on the reasoning tiers, and only if a budget was configured
    thinkingBudget: tier === "scout" ? 0 : config.thinkingBudget,
  };
}

/**
 * Resolve a per-call workspace override to an absolute path. Relative paths resolve
 * against the default workspaceRoot (so `../sibling-repo` works). Returns undefined
 * when no override was given (workers stay jailed to the default root). Throws a
 * friendly error if the target does not exist or is not a directory.
 */
function resolveRoot(config: FleetConfig, wr?: string): string | undefined {
  if (!wr) {
    assertRootAllowed(config, config.workspaceRoot);
    return undefined;
  }
  const abs = path.isAbsolute(wr) ? wr : path.resolve(config.workspaceRoot, wr);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`workspaceRoot '${wr}' does not exist (resolved: ${abs}).`);
  }
  if (!st.isDirectory()) throw new Error(`workspaceRoot '${wr}' is not a directory (resolved: ${abs}).`);
  assertRootAllowed(config, abs);
  return fs.realpathSync(abs);
}

/** Reject a root that is, contains, or sits inside a denied folder (by real path). */
export function assertRootAllowed(config: FleetConfig, root: string): void {
  let real: string;
  try {
    real = fs.realpathSync(root);
  } catch {
    real = path.resolve(root);
  }
  for (const denied of config.deniedRoots) {
    let d: string;
    try {
      d = fs.realpathSync(denied);
    } catch {
      d = denied;
    }
    const inside = path.relative(d, real);
    const contains = path.relative(real, d);
    const isUnder = (rel: string) => rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    if (isUnder(inside) || isUnder(contains)) {
      throw new Error(`workspaceRoot '${root}' is blocked by deniedRoots (${denied}).`);
    }
  }
}

const rootSchema = z
  .string()
  .optional()
  .describe(
    "Directory the workers may read/grep for THIS call (absolute, or relative to the default root). " +
      "Use it to research a DIFFERENT repo than the one this session opened in. Default: the launch directory. " +
      "Folders in the configured deniedRoots (and any folder above one) are refused.",
  );

/** Usage footer for a finished tool call. Also appends the call to the usage log. */
function footer(config: FleetConfig, tool: string, results: FleetAgentResult[]): string {
  logUsage(config.usageLog, tool, results.map((r) => r.usage));
  const s = summarize(results);
  const fallback = s.textToolFallback ? " · text-tool fallback (no native tool_use on this endpoint)" : "";
  const cached = s.cacheReadTokens || s.cacheWriteTokens
    ? ` (+${s.cacheReadTokens} cache read, ${s.cacheWriteTokens} cache write)`
    : "";
  return (
    `\n\n---\n[Suber] ${s.count} worker(s) on ${s.models.map((m) => `'${m}'`).join(", ")} (${config.provider}) · ` +
    `${s.ok} ok / ${s.failed} failed · ${s.toolCalls} tool calls · ` +
    `~${s.inputTokens} in${cached} / ${s.outputTokens} out tokens billed to your FLEET provider, ` +
    `not your main account${fallback}.`
  );
}

function renderResults(results: FleetAgentResult[]): string {
  return results
    .map((r) => {
      const head = `### Task ${r.index + 1}${r.ok ? "" : " — FAILED"}`;
      const tail = r.ok ? r.text || "[empty result]" : `ERROR: ${r.error}`;
      return `${head}\n${tail}`;
    })
    .join("\n\n");
}

const tierSchema = z
  .enum(["scout", "worker", "synth"])
  .optional()
  .describe("Model tier: 'scout' (cheapest, breadth), 'worker' (mid reasoning), 'synth' (smartest).");

export function createServer(config: FleetConfig): McpServer {
  const server = new McpServer({ name: "suber-agent-team", version: "0.5.0" });
  // Per-user usage rules from config, appended to every tool description so the orchestrator
  // sees them each time it weighs a call (e.g. when to offload, which folders are off-limits).
  const guidance = config.guidance ? ` ${config.guidance}` : "";

  server.registerTool(
    "delegate",
    {
      title: "Delegate one task to a cheap-model worker",
      description:
        "Delegate ONE task to a single autonomous worker running on a CHEAP model (default tier: scout; pass tier 'worker' for harder reasoning). " +
        "The worker uses tools (read/grep/glob/web) to gather evidence itself, so context-heavy grunt " +
        "work never touches your main account quota. Returns a concise result." + guidance,
      inputSchema: {
        task: z.string().describe("The task for the worker. Be specific and self-contained."),
        context: z.string().optional().describe("Optional shared background to prepend to the task."),
        tier: tierSchema,
        model: z.string().optional().describe("Explicit model override (wins over tier)."),
        workspaceRoot: rootSchema,
      },
    },
    async ({ task, context, tier, model, workspaceRoot }) => {
      const runId = newRunId();
      emit({ kind: "run_start", runId, runKind: "delegate", title: task.slice(0, 100) });
      let runOk = false;
      try {
        const p = resolveTier(config, tier ?? "scout", model);
        const r = await runSingle(config, task, {
          model: p.model,
          sharedContext: context,
          maxTokens: p.maxTokens,
          thinkingBudget: p.thinkingBudget,
          root: resolveRoot(config, workspaceRoot),
          progress: ctx(runId, "worker"),
        });
        runOk = r.ok;
        const body = r.ok ? r.text || "[empty result]" : `ERROR: ${r.error}`;
        return text(body + footer(config, "delegate", [r]), !r.ok);
      } catch (e) {
        return text(`Suber error: ${(e as Error).message}`, true);
      } finally {
        emit({ kind: "run_end", runId, ok: runOk });
      }
    },
  );

  server.registerTool(
    "fanout",
    {
      title: "Run many tasks in parallel on cheap-model workers",
      description:
        "Run MANY tasks in parallel, each on its own autonomous cheap-model worker (default tier: scout, " +
        "bounded by maxConcurrency). Each worker uses tools itself. Returns one labeled result per task. " +
        "Ideal for parallel research/scans/audits at scale without burning your main quota." + guidance,
      inputSchema: {
        tasks: z.array(z.string()).min(1).describe("List of independent tasks to run in parallel."),
        context: z.string().optional().describe("Optional shared background prepended to every task."),
        tier: tierSchema,
        model: z.string().optional().describe("Explicit model override (wins over tier)."),
        workspaceRoot: rootSchema,
      },
    },
    async ({ tasks, context, tier, model, workspaceRoot }) => {
      const runId = newRunId();
      emit({ kind: "run_start", runId, runKind: "fanout", title: `${tasks.length} parallel task(s)` });
      let runOk = false;
      try {
        const p = resolveTier(config, tier ?? "scout", model);
        const results = await runFleet(config, tasks, {
          model: p.model,
          sharedContext: context,
          maxTokens: p.maxTokens,
          thinkingBudget: p.thinkingBudget,
          root: resolveRoot(config, workspaceRoot),
          progress: ctx(runId, "scout"),
        });
        runOk = results.some((r) => r.ok);
        return text(renderResults(results) + footer(config, "fanout", results));
      } catch (e) {
        return text(`Suber error: ${(e as Error).message}`, true);
      } finally {
        emit({ kind: "run_end", runId, ok: runOk });
      }
    },
  );

  server.registerTool(
    "map_reduce",
    {
      title: "Map a prompt over items, then reduce to one synthesis",
      description:
        "Map a prompt over many items in parallel on scout-tier workers, then a single SYNTH-tier worker " +
        "reduces all per-item results into one synthesis. Returns the reduced output. Use when you want a " +
        "single combined answer over a large list without the orchestrator reading every item." + guidance,
      inputSchema: {
        items: z.array(z.string()).min(1).describe("Items to map over (e.g. file paths, URLs, chunks)."),
        mapPrompt: z.string().describe("Instruction applied to EACH item."),
        reducePrompt: z.string().describe("Instruction to combine all per-item results into one answer."),
        mapModel: z.string().optional().describe("Override the map (scout) model."),
        reduceModel: z.string().optional().describe("Override the reduce (synth) model."),
      },
    },
    async ({ items, mapPrompt, reducePrompt, mapModel, reduceModel }) => {
      const runId = newRunId();
      emit({ kind: "run_start", runId, runKind: "map_reduce", title: `map ${items.length} → reduce` });
      let runOk = false;
      try {
        resolveRoot(config); // map workers read the default root, so it must pass deniedRoots too
        const { mapped, reduced } = await runMapReduce(config, items, mapPrompt, reducePrompt, {
          model: mapModel ?? config.models.scout,
          reduceModel: reduceModel ?? config.models.synth,
          runId: progressOn() ? runId : undefined,
        });
        runOk = reduced.ok;
        const body = reduced.ok ? reduced.text || "[empty result]" : `ERROR: ${reduced.error}`;
        return text(body + footer(config, "map_reduce", [...mapped, reduced]), !reduced.ok);
      } catch (e) {
        return text(`Suber error: ${(e as Error).message}`, true);
      } finally {
        emit({ kind: "run_end", runId, ok: runOk });
      }
    },
  );

  server.registerTool(
    "research",
    {
      title: "Orchestrate a full research pass (lead decomposes, scouts gather, synth synthesizes)",
      description:
        "Give ONE objective; Suber runs the orchestrator-worker pattern itself: a SYNTH-tier lead decomposes " +
        "it into independent subtasks, SCOUT-tier workers run them in parallel, then a SYNTH-tier worker " +
        "synthesizes (optionally verifying evidence) into one cited answer. Use this instead of hand-writing " +
        "N fanout tasks. All work is billed to your fleet provider, not your main account." + guidance,
      inputSchema: {
        objective: z.string().describe("The research/audit objective in one self-contained sentence or paragraph."),
        context: z.string().optional().describe("Optional shared background (constraints, where to look)."),
        maxSubagents: z
          .number()
          .int()
          .min(1)
          .max(32)
          .optional()
          .describe("Cap on subtasks the lead may spawn (default 8). Scale to complexity."),
        verify: z
          .boolean()
          .optional()
          .describe("If true, a skeptic worker adversarially re-greps the whole workspace to refute every non-existence/broken claim, and the synthesis drops what it refutes (anti-hallucination)."),
        scoutModel: z.string().optional().describe("Override the scout (worker) model."),
        synthModel: z.string().optional().describe("Override the synth (lead + synthesis) model."),
        workspaceRoot: rootSchema,
      },
    },
    async ({ objective, context, maxSubagents, verify, scoutModel, synthModel, workspaceRoot }) => {
      const runId = newRunId();
      emit({ kind: "run_start", runId, runKind: "research", title: objective.slice(0, 120) });
      let runOk = false;
      try {
        const r = await runResearch(config, objective, {
          context,
          maxSubagents,
          verify,
          scoutModel,
          synthModel,
          root: resolveRoot(config, workspaceRoot),
          runId: progressOn() ? runId : undefined,
        });
        runOk = r.synthesis.ok;
        const all = [r.lead, ...r.mapped, ...(r.skeptic ? [r.skeptic] : []), r.synthesis];
        const planLines = r.plan
          .map((t, i) => `  ${i + 1}. ${t.task}${t.tools?.length ? `  [tools: ${t.tools.join(", ")}]` : ""}`)
          .join("\n");
        const header =
          `## Research synthesis\n` +
          `Objective: ${r.objective}\n\n` +
          `Plan (${r.plan.length} subtasks${r.lead.ok ? "" : "; lead decomposition FAILED, ran objective directly"}):\n${planLines}\n\n---\n`;
        const body = r.synthesis.ok ? r.synthesis.text || "[empty synthesis]" : `ERROR: ${r.synthesis.error}`;
        return text(header + body + footer(config, "research", all), !r.synthesis.ok);
      } catch (e) {
        return text(`Suber error: ${(e as Error).message}`, true);
      } finally {
        emit({ kind: "run_end", runId, ok: runOk });
      }
    },
  );

  return server;
}
