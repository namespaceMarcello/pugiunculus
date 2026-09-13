# Where the project stands

Three sections, and they are **replaced, not appended**: a step done is deleted, a
defect closed is deleted. What happened lives in `docs/archivio/FATTO.md`.

## Decisions

- **The project is Pugiunculus** (2026-09-12), `namespaceMarcello/pugiunculus` on
  GitHub. The folder on disk is still `Desktop\squint`; that is not a mistake.
- **Nothing ships on an argument.** A hook arrives with a benchmark and its rows,
  or it does not arrive.
- **The session notebook ships off** (2026-09-13). 33 long sessions across Haiku,
  Sonnet and Opus at every effort level showed the mechanism works and nothing
  else: the arm that never cuts loses a standing rule a quarter of the time, and
  two identical runs differed by more than any gap between arms. The README
  carries the table.
- **No hook rewrites the user's words.** They are 0.6% of a payload and the only
  part that cannot be rebuilt from disk.
- **Compression happens at the level of blocks, not words** — see
  `docs/potatore.md`.
- **The pruner is closed, not built** (2026-09-13). A `PostToolUse` hook cannot
  replace a built-in tool's output, the weight is in `Bash` volume and deliberate
  `Read` slices, and a hook cannot act on what is already in the conversation.
  The note keeps the reasons. Retroactive pruning is a proxy question, decided on
  the ceiling `bench/prune-sim.cjs` measures, not before.
- **The effort router ships off, like the notebook** (2026-09-13). The scorer
  separates easy turns from hard ones on the user's own prompts (8× to 16× in
  thinking between the extreme classes); what it saves is unmeasured until a
  week of `--split` with it on. A skill's `effort:` beats the session level for
  the turn; no hook can change effort directly. Fable-only in practice: on other
  models a mid-session effort change invalidates the prompt cache. The words
  are English by default and **learned from the user's own history** at install,
  kept only when they win on held-out sessions (62% → 76% on the author's
  prompts); a hand-written language pack is the fallback, not the design.
- **No Write blocker** (2026-09-13). `measure-context.cjs --writes`: 36 Write
  calls over already-open files in 14 days, 111k tokens of content. Nothing a
  refusal could move.
- **Large reads go to a lean subagent, not the conversation** (2026-09-13).
  `install.cjs --lettore`: 10.7k tokens to start against 47.9k for a
  general-purpose agent, and the subagent cache kept for an hour.
- **No hook rewrites the user's prompt into a summary** (2026-09-13). The hook
  API cannot replace a prompt, only add to it or erase it; the prompt is 0.6% of
  the payload; and a small model resolving a confused request resolves it by
  guessing. A confused prompt is information for the model that reads it.

## Known problems

- **A skill's `effort:` does not reliably apply when the model invokes the
  skill** (2026-09-13). Typed by the user as a slash command it applies every
  time, across turns (verified with `claude -p` and `--resume`: `low` under
  `--effort max`, twice). Invoked by the model through the Skill tool it
  applied 0 times in 2 in fresh sessions and 4 times in 6 in the author's
  interactive session, with no pattern found (first load or not, level). The
  effort router depends on the model-invoked path, so what it suggests may not
  happen; `bench/effort-score.cjs --applied` counts how often it did. It is a
  known Claude Code bug: anthropics/claude-code issues #81313 (effort applied
  on slash-command invocation, ignored via the Skill tool), #81318 (model and
  effort overrides broken for commands and skills since v2.1.220), #79664 and
  #69267. The transcript records identical lines for the invocations that
  worked and the ones that did not; the difference is inside the harness.
  Until it is fixed, the reliable levers stay `/effort` and a typed slash
  skill, and the router is a suggestion the harness may or may not honour.

- The notebook benchmark cannot answer the question it was built for: sixteen
  turns never reach the context size where cutting pays (a real session carries
  274k tokens per request, the benchmark a fraction of that).
- The standing-rule probe is too noisy to use as evidence: it moves with how
  consistently a model obeys an old instruction, not with what a cut costs.
- `bench/notebook.cjs` reuses `ask` and `grade` copied from `bench/hard.cjs`. If
  the question wording changes in one, the two benchmarks stop comparing.

## Next steps

- Decide the proxy on the number `bench/prune-sim.cjs` gives. On 14 days (35
  sessions, 6,016 requests) the ceiling — every tool result older than ten
  requests cleared, no cache penalty — is 8.6% of the cost; with the 1-hour cache
  paid for, every batched policy saves under 1% and a third of the sessions pay
  more. Sustained context drops without a compaction are small and rare (16, in
  5 sessions, median 19k): nothing shows the harness clearing old results on its
  own. The retroactive road looks closed; the user says so, not the script.
- Read `node measure-context.cjs --fixed` and decide what to switch off. The
  installer does nothing here until that decision is written: turning off a
  plugin changes what the agent can do (`docs/privately.md`).
- Two levers `node measure-context.cjs --split` found, both unmeasured as
  levers (14 days, 35 sessions, what every request re-reads): **the model's
  thinking is the largest single block — 20% of everything re-read**. It is
  stored empty in the transcript and stays in the context, so re-reading it
  costs more than producing it. Whether a lower effort level shrinks it, and
  what it costs in answers, is a benchmark. And **a quarter of everything
  re-read is conversation carried over by sessions resumed on an earlier one**
  (13 of 35 started at 226-380k): the cost side of the cut question, measured.
- **A proxy for per-message effort** (noted 2026-09-14). The only automatic
  and reliable way to set effort per prompt today: Fable 5.1 accepts an
  effort-only system message before a user turn, cache intact (beta
  `mid-conversation-output-config-2026-07-01`), and Claude Code already uses
  it — that is why an effort change keeps the cache on Fable. A local proxy on
  `ANTHROPIC_BASE_URL` could add that message with the level the router's
  scorer gives. Step one, zero risk: a proxy in observe-only mode that forwards
  everything unchanged and logs the shape of Claude Code's requests (the beta
  header, the effort message). Step two, only if the shape matches the docs:
  add one message. Open questions before step two: a subscription login
  through a gateway is undocumented; a dead proxy stops Claude until it is
  restarted; credentials pass through it.
- Two ways to see the hooks work are installed for the author (2026-09-13):
  the status line (`--status`) and the router's `systemMessage`. Which one
  earns its place is the author's call after a few days; the other goes.
- After a week with the effort router and the reader on (installed for the
  author 2026-09-13): `--split` again for the thinking share, the pugi log for
  how often the suggested skill was actually invoked, `--agents` for what the
  reader cost. The router stays opt-in until those numbers exist.
- Re-run the notebook benchmark in the shape of a real session (40+ turns,
  repeated runs) before deciding whether cutting pays at all.
- Consider having the installer write the auto-compaction window: the fixed 55k
  is the largest untouched block on every move.
