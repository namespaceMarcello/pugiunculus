# Where the project stands

Three sections, and they are **replaced, not appended**: a step done is deleted, a
defect closed is deleted. What happened lives in `docs/archivio/FATTO.md`.

## Decisions

- **The project is Pugiunculus** (2026-09-12), `namespaceMarcello/pugiunculus` on
  GitHub. The folder on disk is still `Desktop\squint`; that is not a mistake.
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

## Known problems

- None open.

## Next steps

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

- Consider having the installer write the auto-compaction window: the fixed 55k
  is the largest untouched block on every move.
