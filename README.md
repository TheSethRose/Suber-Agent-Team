# Suber (hardened fork)

An MCP server that lets Claude Code hand read-only research to helper models billed to an
**Anthropic Console API key** instead of your Claude subscription. Your main session plans,
briefs and checks; the helpers do the bulk reading.

Forked from [stephenpham68/Suber-Agent-Team](https://github.com/stephenpham68/Suber-Agent-Team)
and cut down for one use: a Mac, Anthropic's API, read-only workers, and a key that never
touches a project folder.

## Why

Claude Code on a Max or Pro plan spends plan usage on every subagent. Some API credit, such as
promotional credit, covers the API and Agent SDK but not Claude Code itself. Suber calls the
Messages API directly, so that credit pays for the heavy reading while your plan stays free for
the main conversation.

## Tools

Each worker gets `read_file`, `glob`, `list_dir`, `grep` and `web_fetch`, jailed to one folder.

- **`delegate(task)`**: one job, one worker (default tier `scout`; pass `tier: "worker"` for harder reasoning).
- **`fanout(tasks[])`**: independent jobs in parallel (default tier `scout`).
- **`map_reduce(items[], mapPrompt, reducePrompt)`**: one question over many files or URLs, then
  one `synth` worker combines the answers.
- **`research(objective)`**: a `synth` lead splits the question, scouts gather, `synth` writes a
  cited answer.

Every result ends with a footer showing the models, tool calls and tokens billed to the key,
including cache reads and writes.

Workers can't see your conversation, edit files, run commands or search the web. Brief them
with paths or URLs, a done condition and a length cap. Each worker gets a fixed number of tool
rounds (`maxIterationsPerAgent`), so split a big audit into narrow pieces rather than one sweep.

## Hardening (what differs from upstream)

- **Config only from `~/.suber/` or `SUBER_CONFIG`.** Upstream read `suber.*.json` from the
  working directory first, so any opened project could redirect the API key, enable bash, or
  change the command Suber spawns.
- **Serena off by default**, and no installer, so Suber never starts another program unless you
  turn it on.
- **Real-path jail.** File paths are re-checked after resolving symlinks; glob patterns can't
  use `..` or absolute paths, and globbing doesn't follow symlinks.
- **No private addresses.** `web_fetch` refuses loopback, private, link-local, CGNAT and
  metadata addresses, and checks every redirect hop.
- **`deniedRoots`.** Folders a worker may never be pointed at, inside, or above, checked by
  real path on every call, including the default root.
- **`guidance`.** Your own usage rules, appended to every tool description, so the model sees
  them each time it decides whether to offload.
- **Prompt caching.** Each worker's system prompt and history are cached between its turns, so
  a later turn pays about a tenth of the input price for everything it has already seen.
- **Usage log.** Every tool call appends its token usage to `~/.suber/usage.jsonl`;
  `bun run src/index.ts usage [--days N]` totals it by model and day, with a spend estimate.
- **Trimmed.** Orbit presets, standalone binary builds and MCP registry metadata are gone.

Write and bash tools still exist but stay off unless you set both `capabilities` and
`acknowledgeDangerous`. This fork is meant to run without them.

## Setup (macOS)

Requires [Bun](https://bun.sh) and Claude Code.

1. Clone and install:

   ```bash
   git clone https://github.com/TheSethRose/Suber-Agent-Team ~/Developer/active/suber
   cd ~/Developer/active/suber && bun install --frozen-lockfile
   ```

2. Create a Console API key and store it in the Keychain (it prompts for the key):

   ```bash
   security add-generic-password -a "$USER" -s suber-anthropic -w
   ```

3. Copy [`suber.config.example.json`](suber.config.example.json) to `~/.suber/config.json`
   (file mode 600, folder 700), then set `guidance` and `deniedRoots` for your machine.

4. Create `~/.suber/launch.sh` (mode 700). It reads the key at start-up, so the key never sits
   in `~/.claude.json`, a shell profile or this repo:

   ```bash
   #!/bin/zsh
   key=$(security find-generic-password -s suber-anthropic -w 2>/dev/null)
   [[ -z "$key" ]] && { echo "[suber] No API key in Keychain (service suber-anthropic)." >&2; exit 1; }
   export SUBER_API_KEY="$key" SUBER_CONFIG="$HOME/.suber/config.json"
   unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY
   exec "$HOME/.bun/bin/bun" run "$HOME/Developer/active/suber/src/index.ts" "$@"
   ```

5. Register it for every project, then start a new Claude Code session:

   ```bash
   claude mcp add --scope user suber -- ~/.suber/launch.sh
   ```

6. Check it: `claude mcp get suber` should say Connected.
   `SUBER_API_KEY=fake SUBER_CONFIG=~/.suber/config.json bun run src/index.ts --check` prints the
   resolved config without starting the server.

## Telling Claude when to use it

Put the rules in two places: your `CLAUDE.md`, so they apply in every session, and the
`guidance` field, so they show up on the tools themselves. A good rule set offloads only jobs
that are read-only, self-contained, inside one folder, checkable and big, and always passes an
absolute `workspaceRoot`. A starting snippet is in [`docs/CLAUDE.snippet.md`](docs/CLAUDE.snippet.md).

## Configuration

Settings come from `$SUBER_CONFIG`, else `~/.suber/settings.json`, else `~/.suber/config.json`.
Every field also has a `SUBER_*` environment variable, which wins over the file.

| Field | Env | Notes |
|---|---|---|
| `provider` | `SUBER_PROVIDER` | `anthropic` (Messages API) or `openai` (Chat Completions) |
| `baseUrl` | `SUBER_BASE_URL` | `https://api.anthropic.com` for Console billing |
| `apiKey` | `SUBER_API_KEY` | Pass it from the launcher, not the file |
| `model`, `models.scout/worker/synth` | `SUBER_MODEL`, `SUBER_MODEL_SCOUT/WORKER/SYNTH` | Default model and per-tier models |
| `maxConcurrency` | `SUBER_MAX_CONCURRENCY` | Parallel workers (default 8) |
| `maxIterationsPerAgent` | `SUBER_MAX_ITERATIONS` | Tool-loop rounds per worker (default 10) |
| `maxTokens`, `synthMaxTokens` | `SUBER_MAX_TOKENS`, `SUBER_SYNTH_MAX_TOKENS` | Response caps |
| `promptCaching` | `SUBER_PROMPT_CACHING` | Cache system prompt and history (default on); history is then kept whole |
| `toolResultWindow` | `SUBER_TOOL_RESULT_WINDOW` | Recent tool results kept verbatim when caching is off (default 3) |
| `usageLog` | `SUBER_USAGE_LOG` | Per-call usage JSONL (default `~/.suber/usage.jsonl`; `""` = off) |
| `pricing` | none | USD per million tokens by model, merged over the built-in table |
| `thinkingBudget` | `SUBER_THINKING_BUDGET` | Leave at 0: it sends `budget_tokens`, which the 5.5 models reject |
| `requestsPerMinute`, `requestsPerSecond` | `SUBER_RPM`, `SUBER_RPS` | Client-side rate cap (0 = off) |
| `workspaceRoot` | `SUBER_WORKSPACE_ROOT` | Default root (the launch folder); pass one per call instead |
| `deniedRoots` | `SUBER_DENIED_ROOTS` | Comma-separated in env; `~/` expands to home |
| `guidance` | `SUBER_GUIDANCE` | Appended to every tool description |
| `tools` | `SUBER_TOOLS` | Worker tools (default `read_file,glob,list_dir,grep,web_fetch`) |
| `serena` | `SUBER_SERENA` | `off` (default), `auto` or `on` |
| `progress` | `SUBER_PROGRESS` | Live fleet view in a Terminal window (default off) |
| `tavilyApiKey` | `SUBER_TAVILY_API_KEY` | Adds a `web_search` tool; leave unset to keep workers off search APIs |
| `capabilities`, `acknowledgeDangerous` | `SUBER_ALLOW_WRITE/BASH`, `SUBER_ACK_DANGEROUS` | Keep off |

## Checks

```bash
bun run check
```

Typechecks, then runs [`scripts/hardening-check.ts`](scripts/hardening-check.ts). It needs no API
key and makes no API calls; it fetches `https://example.com` once to confirm public URLs still
work. Dependency advisories: `osv-scanner scan source --lockfile bun.lock`.

## Keeping up with upstream

Upstream has one maintainer, so treat its commits as untrusted until read:

```bash
git fetch upstream && git log --oneline main..upstream/main
```

Read each diff, merge only what you've reviewed, then rerun the checks.

## License

MIT, same as upstream. See [LICENSE](LICENSE).
