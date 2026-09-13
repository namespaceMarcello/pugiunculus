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
- **No hook rewrites the user's prompt into a summary** (2026-09-13). The hook
  API cannot replace a prompt, only add to it or erase it; the prompt is 0.6% of
  the payload; and a small model resolving a confused request resolves it by
  guessing. A confused prompt is information for the model that reads it.

## Known problems

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
- Re-run the notebook benchmark in the shape of a real session (40+ turns,
  repeated runs) before deciding whether cutting pays at all.
- Consider having the installer write the auto-compaction window: the fixed 55k
  is the largest untouched block on every move.
