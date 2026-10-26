# AGENTS.md

## Project Overview

- Hardened personal fork of [Suber Agent Team](https://github.com/stephenpham68/Suber-Agent-Team): a stdio MCP server that runs read-only helper models on an Anthropic Console API key, so Claude Code can offload bulk reading without spending plan usage.
- Scope is narrow on purpose: macOS, Anthropic's Messages API, read-only workers, run from source with Bun. Don't add features for other platforms, gateways or publishing unless asked.
- The README explains setup and the hardening; read it before changing behavior.

## Setup Commands

- Install: `bun install --frozen-lockfile`
- Run the server from source: `bun run dev` (stdio; it waits for an MCP client)
- Print the resolved config without starting the server: `SUBER_API_KEY=fake SUBER_CONFIG=suber.config.example.json bun run src/index.ts --check`
- Poke the tools by hand: `bun run inspector`

## Test and Validation Commands

- After any change: `bun run check` (typecheck, then `scripts/hardening-check.ts`). It needs no API key and makes no API calls; it fetches `https://example.com` once.
- After a dependency change: `osv-scanner scan source --lockfile bun.lock` should report nothing new.
- Never run real `delegate`/`fanout`/`map_reduce`/`research` calls just to test: they spend API credit. If a live call is needed, use one `delegate` on the `scout` tier with a narrow task.

## Architecture Notes

- `src/index.ts`: stdio entry and CLI flags (`--check`, `--version`, `watch`, `usage`).
- `src/server.ts`: the four MCP tools, the per-call `workspaceRoot` resolution and the `deniedRoots` guard (`assertRootAllowed`).
- `src/agent.ts`: fleet orchestration and prompts.
- `src/providers.ts`: per-worker tool loop for the `anthropic` and `openai` wire formats, prompt caching, retries, and the text-tool fallback (`src/tool-call-parse.ts`).
- `src/usage.ts`: token accounting, the usage log and the `usage` report. Prices in `DEFAULT_PRICING` are list prices; update them when Anthropic's change.
- `src/tools.ts`: worker tools and the jail (`resolveInRoot`, `assertSafePattern`, `assertPublicUrl`).
- `src/config.ts`: config loading (defaults < file < `SUBER_*` env).
- `src/serena.ts`, `src/progress.ts`, `src/watch.ts`: optional Serena tools and live view, both off by default.

## Safety and Data Rules

These invariants are the point of the fork. Don't weaken them, and add a case to `scripts/hardening-check.ts` when you touch one:

- Config is read only from `$SUBER_CONFIG` or `~/.suber/`, never from the working directory.
- Serena stays off by default, and nothing spawns a process on its own.
- Every file path is checked against the root before and after resolving symlinks; glob patterns can't contain `..` or be absolute; globbing doesn't follow symlinks.
- `web_fetch` refuses private, loopback, link-local, CGNAT and metadata addresses on every redirect hop.
- Every tool call, including `map_reduce` and calls with no `workspaceRoot`, passes `assertRootAllowed`.
- Write and bash stay off unless both `capabilities` and `acknowledgeDangerous` are set.
- The API key comes from `SUBER_API_KEY` set by the user's launcher. Never put a key in this repo, the example config, logs or test fixtures.

Other rules:

- Prompt caching needs a byte-identical prefix: never edit messages already sent (that's why `compactHistory` is skipped when caching is on), and put cache breakpoints only on the request copy.
- stdout carries the MCP protocol. Write human-readable output to stderr only.
- Keep `bun.lock` committed and in sync. The user's Bun config enforces a minimum release age; don't bypass it.
- Upstream is a single-maintainer project. Read every upstream diff before merging (`git fetch upstream && git log --oneline main..upstream/main`); never merge it blind.

## Code Style

- TypeScript ESM (NodeNext): import local files with explicit `.js` extensions, even from `.ts`.
- Comments explain why, not what, at the density already in `src/`.
- Keep the MCP tool surface small; new behavior goes behind config, not new tools.

## PR / Commit Notes

- Conventional Commits (`fix:`, `feat:`, `docs:`, `chore:`, optional scope), as in the existing history.
