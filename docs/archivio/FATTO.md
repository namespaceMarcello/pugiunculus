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

### 2026-09-13 — the effort router

`hooks/pugi-effort.cjs` (UserPromptSubmit) scores the prompt with a fixed word
list and adds one line: "Effort suggested for this turn: X"; `install.cjs
--effort` registers it and writes four skills `effort-low/medium/xhigh/max`
into `~/.claude/skills`, each with `effort:` in its front matter, which sets the
rest of the turn and beats the session level (verified with `claude -p --effort
max`: the skill's request is recorded at `low`). `--no-effort` and `--uninstall`
remove only skills carrying our mark. `bench/effort-score.cjs` replays every
typed prompt of the user's history through the scorer against the turn's real
thinking and tool calls: on 433 prompts the `max` class thought 8× the `low`
one, 16× at equal session effort. Five tests added (43 green). Try it: `node
bench/effort-score.cjs --samples`, `node install.cjs --effort`.
Later the same day: the words moved out of the code into
`hooks/effort-words.json` (English defaults) and `hooks/effort-words.it.json`
(the Italian pack); `install.cjs --effort --lang it` copies the pack to
`~/.claude/pugi/effort-words.json`, where the hook adds it to the defaults, and
`PUGI_EFFORT_WORDS` points the hook and the bench at any file. `bench/
effort-score.cjs --savings` re-prices every turn at the suggested level from
the levels the sessions actually ran at: −1.3% of cost on 14 days, with the
most suggested level (medium) never run and so unpriced.
Then `bench/effort-learn.cjs`: the word lists learned from the user's own
transcripts (hard and easy turns by thinking terciles within each session
effort; words and pairs by their lift; tiny repeated prompts as continuations),
judged on held-out sessions by how often a hard turn ranks above an easy one.
`install.cjs --effort` detects the prompts' language by stopwords, adds the
pack when one exists, learns with 100+ prompts of history and writes only when
the learned lists beat what is there (`--no-learn` skips). On 814 prompts:
defaults 62%, Italian pack 65%, learned 76%. Three tests added (49 green).
Try it: `node bench/effort-score.cjs --learn`, `node install.cjs --effort`.
`--check` adds five folds by session (63% → 76% mean, up on every fold), a
split by time (55% → 67%) and a learning curve (50 prompts 63%, 100 67%, 200
72%); the words already learned on the same history are kept out of the
judgement.

### 2026-09-13 — the lean reader, and two measurements

`install.cjs --lettore` writes `~/.claude/agents/lettore.md` (Sonnet; Read,
Grep, Glob; marked as ours) and sets `subagentPromptCacheTtl` to `1h` when
unset; `--no-lettore` and `--uninstall` take both out and leave a value that is
not ours. The whole-file Read refusal in `hooks/pugi.cjs` names the agent when
its file exists. `measure-context.cjs --agents` reads the transcripts under
`subagents/` and reports what a subagent's first request cost (744 agents in 14
days: median 24k); `--writes` counts Write calls over files already read or
edited in the session (36 in 14 days, 111k tokens: no blocker). One test added
(44 green). Try it: `node install.cjs --lettore`, `node measure-context.cjs
--agents`, `node measure-context.cjs --writes`.
