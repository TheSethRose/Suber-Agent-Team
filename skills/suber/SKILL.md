---
name: suber
description: Offload big read-only jobs (codebase sweeps, multi-file audits, reading many files or known URLs) to the suber MCP tools, which bill a Console API key instead of the Claude plan. Use before any delegate, fanout, map_reduce or research call, and to check suber spend. Not for work that edits, runs commands, searches the web or needs the conversation.
---

# Suber

`suber` is a local MCP server whose workers run on a Console API key. Every token a worker spends is a token the main session doesn't.

## Offload or not

Offload only when the job passes all five:

- **Read-only:** workers can read, grep, glob, list and fetch known URLs. They can't edit, run commands or search the web.
- **Self-contained:** the brief fits in a paragraph. Workers can't see the conversation.
- **One allowed folder:** see Roots.
- **Checkable:** you can verify the load-bearing claims with a few targeted reads.
- **Big:** lots of reading, or several files or pages. A grep or two is cheaper done here.

Never offload anything that needs the user's logins, browser or private accounts.

## Pick the tool

- `delegate`: one job, one worker.
- `fanout`: independent pieces in parallel, one worker each.
- `map_reduce`: the same question over a list of files or URLs, then one combined answer. Good for multi-page web reading once you have the URLs.
- `research`: an open question that suber should break into subtasks itself. It costs the most; prefer `fanout` when you can split the job yourself.

`delegate` and `fanout` default to the cheapest tier, `scout`. Pass `tier: "worker"` only when the job needs judgment, such as weighing a design or tracing a subtle bug.

## Brief it

- Pass `workspaceRoot` as an absolute path on every call.
- Name the files, folders or URLs, the done condition and a length cap. Ask for file paths with line numbers, or source URLs.
- Each worker has a fixed number of tool rounds (`maxIterationsPerAgent`). A broad sweep runs out and comes back half-verified, so split it into narrow pieces with `fanout`.

## Roots

Suber refuses any folder listed in `deniedRoots` in the user's suber config, anything inside one, and any folder above one. A refusal is final: do the job in the main session or with a subagent instead. Never point workers at a parent folder to get around it.

## After the call

- Verify the claims you'll rely on before you report them.
- Tell the user in one line what you offloaded.
- On "credit balance too low", stop using suber until the user says the key has credit again.

## Spend

The footer on each result shows tokens by model, including cache reads and writes. For totals by model and day, run this from the suber checkout:

```bash
bun run src/index.ts usage --days 7
```

Report token counts, not dollar estimates, unless the user asks.

## Your own rules

Put rules specific to you (credit deadlines, which folders to prefer) in your `CLAUDE.md` and in the `guidance` field of your suber config, which is appended to every suber tool description. Keep both short and point them at this skill.
