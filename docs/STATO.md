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

## Known problems

- The notebook benchmark cannot answer the question it was built for: sixteen
  turns never reach the context size where cutting pays (a real session carries
  274k tokens per request, the benchmark a fraction of that).
- The standing-rule probe is too noisy to use as evidence: it moves with how
  consistently a model obeys an old instruction, not with what a cut costs.
- `bench/notebook.cjs` reuses `ask` and `grade` copied from `bench/hard.cjs`. If
  the question wording changes in one, the two benchmarks stop comparing.

## Next steps

- Build the pruner (`docs/potatore.md`), starting with `PostToolUse` on the tools
  that weigh most: `WebFetch`, `Bash`, unsliced `Read`.
- Measure whether a wrong prune costs more than it saves — the agent re-running a
  command is a full round trip.
- Re-run the notebook benchmark in the shape of a real session (40+ turns,
  repeated runs) before deciding whether cutting pays at all.
- Consider having the installer write the auto-compaction window and turn off MCP
  servers and skills the user's logs show are never used: the fixed 55k is the
  largest untouched block on every move. Measured and still undecided in
  `docs/privately.md` — 88k of one session was three items loaded at startup and
  never used.
