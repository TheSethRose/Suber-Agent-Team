<!--
Paste the block below into your global CLAUDE.md (~/.claude/CLAUDE.md). Put a short version of
the same rules in the `guidance` field of ~/.suber/config.json, so they also show on the tools.
-->

## Offloading to `suber`

- `suber` (MCP tools `delegate`, `fanout`, `map_reduce`, `research`) runs helpers on a Console API
  key instead of my Claude plan. Prefer it over a subagent whenever a job passes all five checks:
  read-only, self-contained (the brief fits in a paragraph), inside one allowed folder,
  checkable, and big (lots of reading, or several files or pages).
- Never offload work that needs our conversation, my logins, or anything that edits, sends or
  runs commands. Helpers can read, grep, list and fetch known URLs; they can't search the web.
- Always pass `workspaceRoot` as an absolute path. Folders in `deniedRoots` are refused.
- Pick the tool by shape: `delegate` for one job, `fanout` for independent pieces, `map_reduce`
  for one question over a list of files or URLs, `research` for an open question. Brief it like a
  subagent (paths, done condition, length cap), keep each brief narrow enough to finish in its
  tool-round limit, and verify its load-bearing claims.
- Say in one line what you offloaded. Stop on "credit balance too low".
