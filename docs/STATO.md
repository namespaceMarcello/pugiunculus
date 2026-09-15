# Where the project stands

Three sections, and they are **replaced, not appended**: a step done is deleted, a
defect closed is deleted. What happened lives in `docs/archivio/FATTO.md`.

## Decisions

- **The project is Pugiunculus** (2026-09-12), `namespaceMarcello/pugiunculus` on
  GitHub. The folder on disk is `Desktop\pugiunculus` (renamed 2026-09-14; it was `Desktop\squint`).
- **Nothing ships on an argument.** A hook arrives with a benchmark and its rows,
  or it does not arrive.
- **The session notebook is out** (2026-09-14; it had shipped off since
  2026-09-13). 33 long sessions across Haiku, Sonnet and Opus at every effort
  level showed the mechanism works and nothing else: the arm that never cuts
  loses a standing rule a quarter of the time, and two identical runs differed
  by more than any gap between arms. Removed under the rule of the day — what
  moves no measured number does not stay — with its hook, its bench and its
  rows; the README keeps the table, `docs/archivio/FATTO.md` the story.
- **The status line and its recap are out** (2026-09-14). A window on what the
  hooks did, not a saving: it moved no number. The installer puts back the
  status line ours had replaced. The router's own line under the prompt stays,
  since the hook writes it anyway.

- **No hook rewrites the user's words.** They are 0.6% of a payload and the only
  part that cannot be rebuilt from disk.
- **Compression happens at the level of blocks, not words** — see
  the pruner note (removed from the repo 2026-09-14, in git history).
- **The pruner is closed, not built** (2026-09-13). A `PostToolUse` hook cannot
  replace a built-in tool's output, the weight is in `Bash` volume and deliberate
  `Read` slices, and a hook cannot act on what is already in the conversation.
  The note keeps the reasons. Retroactive pruning is a proxy question, decided on
  the ceiling `bench/prune-sim.cjs` (removed 2026-09-14, in git history) measures, not before.
- **The effort router suggests, and sets nothing** (2026-09-14). The first
  version wrote four skills with `effort:` for the agent to invoke: measured
  over two days they landed 8 times in 28 (Claude Code bug #81313, #81318), and
  even landing every time the ceiling was −1.1% of the sessions' cost
  (`bench/effort-score.cjs --savings`, 14 days). The skills are gone — the
  installer removes the ones it wrote — and the hook writes one line next to
  the prompt: the score on a 1-to-10 scale and the signals that fired, no
  instruction on how to think. The raw score runs −5 to +6 and thinking follows
  it step by step, so five named levels threw most of it away. Counting how
  many times a signal fires, instead of whether it fires, was tried: 57%
  against 75%, so each signal counts once. Still off by default: what the line
  does to thinking is `--text`, a week away. The words are English by default
  and learned from the user's own history at install, kept only when they win
  on held-out sessions.
- **No proxy on `ANTHROPIC_BASE_URL`** (2026-09-14, twice). For per-request
  effort: the ceiling was −1.1%. For the API's context editing, which Claude
  Code does not expose (issue #26215): the model's thinking is 20% of what a
  request re-reads and the API keeps it billed as input on Opus 4.5+ and Fable
  (docs, confirmed); the thinking replay (`bench/prune-sim.cjs --thinking`, removed 2026-09-14, in git history) replays
  `clear_thinking` on 14 days — ceiling 6.9% with no cache penalty, 1.6% keeping
  the current turn only with 24 sessions of 38 paying more, negative for every
  wider window, because a rolling clear rewrites the cached tail every turn.
  Tool results were 8.6% → under 1% by the same replay. Nothing a proxy could
  reach pays for its risks: credentials through it, a dead proxy stops Claude,
  subscription login through a gateway undocumented (#23022). Closed.

- **No re-read blocker** (2026-09-14). a re-read count (`measure-context.cjs --rereads`, removed 2026-09-14, in git history): the same
  slice read again, file unchanged, no compaction in between — 11 calls, 13k
  tokens, 3% of the Read tokens, in 2 sessions of 38 over 14 days. Claude Code
  already refuses exact duplicates; nothing left to move.
- **No wider shell blocker** (2026-09-14). a shell-result count (`measure-context.cjs --shell`, removed 2026-09-14, in git history): shell
  results are 58% of all tool-result tokens; those of 2k tokens or more are 100
  results, 324k tokens, 15% of all tool results — but 137k already had a filter
  on the pipe, and the biggest of the rest were whole-file `cat`s from before
  the shell blocker existed, repeats let through on purpose, and `sed` ranges
  under 500 lines heavy in bytes, which are deliberate slices. Under 100k tokens
  in 14 days where a refusal could act, on commands whose output cannot be sized
  before they run. No target.
- **No Write blocker** (2026-09-13). `measure-context.cjs --writes` (removed 2026-09-14, in git history): 36 Write
  calls over already-open files in 14 days, 111k tokens of content. Nothing a
  refusal could move.
- **Large reads go to a lean subagent, not the conversation** (2026-09-13).
  `install.cjs --lettore`: 10.7k tokens to start against 47.9k for a
  general-purpose agent, and the subagent cache kept for an hour.
- **`effortLevel` in `settings.json` is not re-read during a session**
  (2026-09-14). Tested live: session started at `xhigh`, the file rewritten to
  `low` (top level and `modelSettings`), one prompt sent three minutes later with
  no skill invoked — the transcript records `xhigh`. A hook cannot set the
  turn's effort by writing settings; the file is read at startup only. What is
  left for per-prompt effort: `/effort` typed by the user, or a line the model
  reads — the router.
- **No hook rewrites the user's prompt into a summary** (2026-09-13). The hook
  API cannot replace a prompt, only add to it or erase it; the prompt is 0.6% of
  the payload; and a small model resolving a confused request resolves it by
  guessing. A confused prompt is information for the model that reads it.

- **The cold-cache hook ships on, with the blockers** (2026-09-14). The cache
  lives one TTL after the last request; the first prompt after a longer idle
  rewrites the whole conversation at 2×. On the user's transcripts
  (`bench/cold.cjs`): 15 returns after more than an hour in 7 days, the
  rewrites alone 13% of the week's cost, and the work that followed them 60%;
  a `/compact` at each return would have cost 25% less (30 days: 6% and 13%).
  The hook blocks that prompt once, prices continuing against `/compact` and
  `/clear`, and passes the same prompt sent again; a compaction after the last
  request passes; slash commands always pass. Not a threshold on context size:
  the user asked for the hour alone, because a 99k rewrite repeated every day
  wears as much as one big one. Its effect is the log's blocked-to-insisted
  ratio, read after a week.

- **The model hook ships on, with the blockers** (2026-09-14). A subagent launched
  without a model inherits the session's. On the transcripts (`bench/agent-model.cjs`,
  30 days): 308 launches matched, 76 without a model, 64 on Opus and 11 on Fable,
  $647 at list price against $242 on Sonnet; median 33 requests each, so real
  work, not reads. The hook refuses once with the three choices and lets the
  orchestrator choose; the same launch again passes. It writes no model itself:
  the user chose the refusal over a silent `model: sonnet`, so the choice, and
  whether it is Opus again, stays in the log. In the last 7 days only 1 launch
  lacked a model: the rule in CLAUDE.md took hold after 2026-09-11.

## Known problems

- None open.

## Next steps

- **The running total in the refusal (`PUGI_RUNNING_TOTAL`, off) needs its
  number, and it is the insist rate.** Today a block is undone by an insist
  **24.5%** of the time (535 blocks over 7 days: 404 held, 131 undone; `.ts`
  21%, `.md` 40%, and 86 of the 90 `.md` blocks are two documents of
  kittencare). The line costs ~15 tokens a block, ~6k a week against 2.44M
  saved, so the cost is not the question — whether an agent that sees what it
  is accumulating insists less is. No paid bench needed: the log records
  `held` on every block, so the two arms separate themselves over a few days
  of ordinary use. If the rate does not move, the line goes, like the status
  line before it.

- Exempting `.md` from the read block was asked for and refused on the
  numbers: 60% of `.md` blocks hold and are worth 328k tokens, against 3k
  spent on the refusals that fail. `measure.cjs` puts break-even at 1.4%.
  The threshold (`--sweep`) is the lever there, not the extension.

- The fixed block (`--fixed`, 14% of what a request re-reads, ~56k per
  request): the part the user controls is ~9k — 64 skills listed (7k, 5.4k of
  it for 50 never used), 7 agent types, 7 MCP servers. Switching every unused
  plugin off would move ~2% of re-reads at the cache-read rate: under 1% of
  cost. `skillListingMaxDescChars` (default 1,536 chars) does not bite: the
  listing averages ~360 chars per skill. Whether to switch plugins off is the
  user's call on what the agent can do, not on cost.

- Two levers `node measure-context.cjs --split` found, both unmeasured as
  levers (14 days, 35 sessions, what every request re-reads): **the model's
  thinking is the largest single block — 20% of everything re-read**. It is
  stored empty in the transcript and stays in the context, so re-reading it
  costs more than producing it. Whether a lower effort level shrinks it, and
  what it costs in answers, is a benchmark. And **a quarter of everything
  re-read is conversation carried over by sessions resumed on an earlier one**
  (13 of 35 started at 226-380k): the cost side of the cut question, measured.

- After a week with the router's line and the reader on (2026-09-14):
  `bench/effort-score.cjs --text` for what the line does to thinking, `--split`
  for the thinking share, `--agents` for what the reader cost. On the first two
  days — 27 turns with the line — every row but one has fewer than ten turns.
  The router stays opt-in until those numbers exist.

- The auto-compaction window, measured (2026-09-14, `node measure-context.cjs
  --compact`): on 1M models the automatic pass runs at ~967k, so the user's
  sessions sit at a median 249k per request (359k over 30 days) and 1 of 18 was
  ever compacted. Replayed with a cap, charging each compaction one read of the
  context, 10k of summary output and the 36k Claude Code puts back (measured
  on the one compaction in the transcripts): 150k −35%, 200k −32%, 250k −29%,
  400k −17% over 7 days; −48% at 200k over 30 days. The replay reproduces the
  billed cost within 8.5%. What it does not price is the detail a summary
  loses. Next: a week with `/autocompact 200k`, then `--compact` again and the
  correction rate; if it holds, the installer writes `autoCompactWindow`.

- Cache-read price per model (2026-09-14): Fable 5.1 bills cache hits at
  0.025× the input price, every other model at 0.1×. `measure-context.cjs` and
  `bench/effort-score.cjs` now weight reads by the request's model; the shares
  moved little because 64% of the last week's requests ran on Opus 5.

- The prompt-cache TTL, simulated on the transcripts (2026-09-14, script in git
  history): the 5-minute TTL would have cost +15% over 7 days and +17% over 30,
  because of 56 pauses of 5-60 minutes a week; the hour reproduces the billed
  cost within 2%. The hour is the default on a subscription but drops to five
  minutes on usage credits, and 13% of the last 30 days' cache writes were at
  five minutes. Candidate for the installer: `promptCacheTtl: "1h"`, one line.

- After a week with the model hook on (2026-09-14): `node bench/agent-model.cjs`
  for what was chosen after a refusal. If it is Opus every time, the refusal
  is a round trip for nothing and goes.

- After a week with the cold-cache hook on (2026-09-14): `node bench/cold.cjs`
  for blocked against insisted, and whether the returns that compacted cost
  what the replay said. If nobody ever compacts, the hook is a nag and goes.
