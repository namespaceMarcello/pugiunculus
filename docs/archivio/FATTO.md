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

### 2026-09-13 — see it while it happens

`hooks/pugi-status.cjs` is a status line: reads stopped and what they weighed,
insists, shell and fan-out blocks, effort levels suggested, the session's
subagents and what the lean ones spared, plus context, cache and cost from the
JSON Claude Code hands every status line. `install.cjs --status` saves the
status line that was there to `~/.claude/pugi/status-previous.json`, where the
script runs it first on every refresh; `--no-status` and `--uninstall` put it
back. The effort router now also returns `systemMessage`, the hook field shown
to the user. Four tests added (53 green). Try it: `node install.cjs --status`,
then look at the bottom of the terminal.
Then, at the author's request: the status line became a sentence in the
language of the word pack, without context, cache and cost (the line above it
already has them), and `hooks/pugi-recap.cjs` joined `--status` on `Stop` and
`SessionStart`: a `systemMessage` after each answer about that turn, and one at
session start about the last 24 hours. Two tests added (55 green).
The same evening the author saw "thinking with max effort" under a turn the
router had sent to `xhigh`: a skill's `effort:` applies when the user types
the skill (verified twice across `--resume`d turns) and not reliably when the
model invokes it (0 of 2 in fresh sessions, 4 of 6 in the interactive one).
`bench/effort-score.cjs --applied` joins the router's log with the transcripts'
`perTurnEffort`: 6 of 17 suggestions landed in two days, 2 of them the
session's own level. Written in STATO as a known problem, with the Claude Code
issues that describe it (#81313, #81318, #79664, #69267): the Skill tool path
does not apply the skill's front matter.

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

### 2026-09-14 — the router says, and sets nothing

Tested live that `effortLevel` in `settings.json` is not re-read during a
session (a hook cannot set effort by writing settings). `--savings` put the
router's ceiling at −1.4% even if every suggestion landed, and `--applied` had
them landing 8 times in 28: the four effort skills are gone. `hooks/pugi-effort.cjs`
now writes one line next to the prompt — `Effort suggested for this turn: 3/10
(mechanical, short).` — with the raw score on a 1-to-10 scale (thinking follows
the raw score step by step; the five levels hid that), no instruction, no
skill. Counting a signal's occurrences was tried and separated worse (57%
against 75%). `install.cjs --effort` writes only the hook and removes the
skills an earlier version wrote; `--applied` is gone from the bench, and
`--text` compares turns with the line against turns without, same class, same
session level; the collector keeps each turn's model. The proxy on
`ANTHROPIC_BASE_URL` is closed on the same number. 55 tests green. Try it:
`node install.cjs --effort`, then type anything and read the line;
`node bench/effort-score.cjs --text`.

### 2026-09-14 — the notebook and the status line go

Under the rule of the day — what moves no measured number does not stay — the
session notebook (`hooks/pugi-notebook.cjs`, `bench/notebook.cjs`, its
questions and its 33 result rows) and the status line with its recap
(`hooks/pugi-status.cjs`, `hooks/pugi-recap.cjs`) are removed, with their
tests and installer flags. The installer still cleans what those versions
wrote: their hook entries, the four effort skills, and a status line of the
user's that ours had replaced (restored from `status-previous.json`, then the
file removed). The README keeps the notebook table under "Tried, measured,
taken out"; the rows are in the git history. 38 tests green. Try it: `node
install.cjs` on a machine with the old install prints "restored your status
line"; `~/.claude/settings.json` has no `pugi-status` after it.

Same day, a defect in what the measurements count: `measure-context.cjs`
skipped the benchmark's own sessions only under the new name (`pugi-bench-*`);
the 98 sessions the fan-out and chain benchmarks ran before the rename
(`squint-bench*`) were counted as the user's work. Fixed; the router's savings
ceiling moves from −1.4% to −1.1%, the separation stays at 75%.

### 2026-09-14 — two candidates measured, none built

`measure-context.cjs --rereads` counts a Read whose path, offset and limit
match an earlier one in the session, with no edit of that file and no
compaction in between: 11 calls, 13k tokens, 3% of Read tokens, 2 sessions of
38 in 14 days. `--shell` lists shell results of 2k tokens or more by command
family, with whether a filter was already on the pipe: 100 results, 324k
tokens, 15% of all tool results, 137k already filtered; the biggest of the rest
were pre-blocker `cat`s, repeats let through on purpose, and byte-heavy `sed`
ranges under 500 lines. Neither becomes a hook; both are in `docs/STATO.md`
§Decisions and in the README under "Where it does not help". Try it:
`node measure-context.cjs --rereads`, `node measure-context.cjs --shell`.

### 2026-09-14 — what the API lets one touch, and the thinking replay

Read the API docs for the levers a request has: context editing
(`clear_thinking`, `clear_tool_uses`), server-side compaction, per-message
effort, cache TTL, tool search; and the Claude Code docs for what the harness
exposes (a Haiku agent did that read). Claude Code exposes cache TTL, the
compaction threshold, effort, tool search and the skill-listing caps, not
context editing. The docs confirm that on Opus 4.5+ and Fable prior turns'
thinking stays in context and is billed as input. `bench/prune-sim.cjs
--thinking` replays the API's `clear_thinking` on the transcripts (the request
model now carries each request's thinking tokens and its user turn): ceiling
6.9%, 1.6% keeping the current turn only, negative beyond. The proxy is closed
on that number too. `--fixed` read: the user-controlled part of the fixed block
is ~9k of 56k per request, under 1% of cost. Try it: `node bench/prune-sim.cjs
--thinking`, `node measure-context.cjs --fixed`.

### 2026-09-14 — the repo holds only what it offers

New rule in CLAUDE.md: a road tried and not taken is not mentioned in the
README, the code or the commands; its number goes in STATO §Decisions and its
script stays in git history. Applied: the README loses "Tried, measured, taken
out", the re-read and shell paragraphs, the router's first-version history and
the pruner paragraph; `measure-context.cjs` loses `--writes`, `--rereads`,
`--shell`; `bench/prune-sim.cjs`, `docs/potatore.md` and `docs/privately.md`
are removed; STATO's references point at git history. What is left is the
three blockers, the router, the reader, and the measurements a user runs
before installing. Try it: `node measure-context.cjs --tools`, `node test.cjs`.

### 2026-09-14 — cache reads priced per model, and the compaction replay

`measure-context.cjs` weights cache reads by the request's model: 0.025× on
Fable 5.1, 0.1× elsewhere (`readWeight`, also used by `bench/effort-score.cjs`).
New `--compact`: every session replayed with the context capped at 150k, 200k,
250k and 400k, each compaction charged one read of the context, 10k of summary
output and what Claude Code puts back, measured on the compactions in the
transcripts. On the last 7 days: −35% at 150k, −32% at 200k. Try it:
`node measure-context.cjs --compact`, `node measure-context.cjs --compact --days 30`.

### 2026-09-14 — the cold-cache hook

`hooks/pugi-cold.cjs`, on UserPromptSubmit, installed with the blockers: when
the transcript's last request is older than the cache TTL (an hour; five
minutes when `promptCacheTtl` is `5m`; `PUGI_COLD_MINUTES` overrides), the
prompt is blocked once with what continuing costs, what `/compact` costs
instead, and that `/clear` is free; the same prompt again passes, a compaction
after the last request passes, slash commands always pass. `bench/cold.cjs`
replays the user's own returns after an hour: as it went, with `/compact`
first, with `/clear`, and reads the hook's log. Four tests. Try it: leave a
session for an hour, type anything; `node bench/cold.cjs`.

### 2026-09-14 — the cold-cache table speaks in dollars

The refusal is a table that reads as a sentence per row — if you continue /
compact first / clear: what you pay now, then on every request, and what you
lose — in dollars at list price for the model in use (a price table per model
family in the hook), the conversation's size in tokens said once above it.
Before, the cells were input-token equivalents and read as token counts. The
blocked prompt is appended to `~/.claude/history.jsonl` so ↑ brings it back.
Try it: `PUGI_COLD_MINUTES=0` in a session, a second prompt shows the table.

### 2026-09-14 — the table says the tokens and their kind, then the dollars

Each cell of the cold-cache table: how many tokens and of what kind (cache
write, cache read, input plus output), the dollars at list price and the
saving in parentheses; above it the model found in the transcript, named,
and the four prices used. Try it: `PUGI_COLD_MINUTES=0`, a second prompt.

### 2026-09-14 — the table says how warm the cache was

One line above the table: how much of the conversation the last request read
from the cache (its `cache_read_input_tokens` over its context), and that this
one would read none of it. Try it: `PUGI_COLD_MINUTES=0`, a second prompt.

### 2026-09-14 — the model hook

`hooks/pugi-model.cjs`, on PreToolUse for Agent and Task, installed with the
blockers: a launch without a model is refused once with the three choices
(haiku, sonnet, opus) and the orchestrator chooses; the same launch again
passes, and the log says which model was chosen or that none was. A custom
agent whose definition names its model passes. `bench/agent-model.cjs`
matches every subagent to its launching call and prices the ones without a
model against Sonnet. Four tests. Try it: launch an Agent without `model`.

### 2026-09-14 — NO_COLOR by the convention

`pugi-cold.cjs` turns colours off when `NO_COLOR` is set and not empty, as
the convention says, not whenever the variable exists: a Haiku subagent
running `node test.cjs` had it set empty and saw the colour test fail.
Try it: `NO_COLOR=1 node test.cjs` and `node test.cjs`, 47 each.
