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
