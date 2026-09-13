# What was done

Newest at the bottom. Two to five lines each: what, and how to try it.

### 2026-09-12 — squint becomes Pugiunculus

Hooks renamed to `hooks/pugi*.cjs`, environment variables to `PUGI_*`, data
directory to `~/.claude/pugi`. `install.cjs` removes the old entries from
`settings.json` and moves the old data directory on first run, so an existing
install keeps its log. Try it: `node test.cjs` (27 tests at the time), then
`node install.cjs` twice and check `~/.claude/settings.json` has three `pugi`
hooks and no duplicates.

### 2026-09-13 — the session notebook, and the measurement that sent it back

`hooks/pugi-notebook.cjs`: hooks write a per-session notebook — the user's
requests verbatim, the files changed, one line of what each change did — and put
it back into the context after a compaction, a `/clear` or a resume. Off by
default: `node install.cjs --notebook` adds it, `--no-notebook` removes it.
`measure-context.cjs` splits a session's cost by category; `bench/notebook.cjs`
drives one long multi-turn session in three arms (today / cut / notebook) across
models and effort levels. 33 sessions said the mechanism works and the benchmark
cannot see anything else — rows in `bench/notebook-results.jsonl`, table in the
README. Try it: `node test.cjs` (38 green), `node measure-context.cjs`,
`node bench/notebook.cjs --report`.

### 2026-09-13 — the pruner closed, and the three measurements that closed it

`docs/potatore.md` is now a closed note: a `PostToolUse` hook cannot replace a
built-in tool's output, the weight is in `Bash` volume and deliberate `Read`
slices, and no hook can touch what is already in the conversation.
`measure-context.cjs` gained `--tools` (which tools' results weigh most, and
what the big `Read`s were, joined with the pugi log) and `--fixed` (every
skill, command, agent and MCP server listed on each move, and which ones the
window never used); its parsing is exported for `bench/prune-sim.cjs`, which
replays real sessions under "clear tool results older than K requests once the
context passes X" and prices the cache re-write that clearing costs. `--split`
sums what a request carries by category — the fixed part billed by the first
request, what a resumed session carried over, your words, tool results, the
model's text, tool calls and thinking (billed output minus what is visible),
harness reminders — at the end of each session and re-read across all its
requests, against what the API billed. Try it: `node measure-context.cjs
--tools`, `--fixed`, `--split`, `node bench/prune-sim.cjs --days 14`,
`node test.cjs` (38 green).
