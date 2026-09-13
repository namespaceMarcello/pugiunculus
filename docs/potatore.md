# The pruner (*potatore*) — design note, not built yet

What Pugiunculus stops today is waste at the door: a whole-file `Read`, a
`cat BIG`, a fan-out of small subagents. This note is about the next hook, and it
comes from one measurement: **what actually fills a session is not the prompts,
it is the material the work produces, and it never leaves again.**

## What the numbers say

Measured on one real session (`node measure-context.cjs` repeats it on any
history; the per-category split is in the same shape):

| | |
|---|---|
| sent on every move, at the end of a working day | **514k tokens** |
| fixed part (system prompt, tool definitions, CLAUDE.md, memory) | 55k, present from the first move |
| tool results (files read, command output, fetched pages) | ~110k |
| the model's own moves (answers, tool calls, reasoning) | ~100k |
| what the harness injects around it (reminders, hook output, loaded skills) | ~120k |
| **everything the human typed** | **3k — 0.6%** |

Re-reading that conversation is **73% of what the session costs**, the median
request carries 274k tokens, and one in ten carries 691k.

Two consequences, and the second is the one that decides the design:

1. Shorter prompts change nothing. There is nothing to win there.
2. **Compression belongs at the level of blocks, not words.** A fetched page in
   that session was 20k tokens and six lines of it were used. Squeezing its prose
   would have saved ~3k; dropping it after taking the six lines saves 19.8k. The
   waste is whole artifacts that stay in the conversation long after their purpose
   is spent.

## What the pruner must do

Two hooks, both automatic, no user action, nothing to remember:

- **`PostToolUse` → `updatedToolOutput`.** Replace a tool result with what matters
  plus a pointer, before it ever enters the conversation: the failures of a test
  run instead of the whole run, the matching section of a page instead of the
  page. The raw thing is written to disk and the pointer says where, so a second
  look costs one targeted read instead of a refetch.
- **`PreToolUse` → `updatedInput`.** Rewrite the call instead of refusing it: a
  whole-file `Read` becomes a sliced read or a `Grep`. The three current blockers
  refuse and make the agent ask again, which costs a round trip every time; a
  rewrite costs none and cannot be argued with.

## What it must never do

- Touch exact paths, line numbers, identifiers or error strings. Those are what
  the agent works from; a paraphrase of a stack trace is a bug generator.
- Prune the user's words. Ever. They are 0.6% of the payload and the only part
  that cannot be rebuilt.
- Prune silently: every decision goes to `~/.claude/pugi/log.jsonl`, on and off,
  like the other hooks.

## Where the notebook fits

The notebook (`hooks/pugi-notebook.cjs`, already built, off by default) was
justified by a bet that is not yet won — that cutting the conversation pays. The
pruner gives it a second job that pays on every tool call:

- **It is the index of what the pruner threw away.** The pointer the pruner leaves
  inline dies with the first context cut; the notebook entry does not.
- **It tells the pruner what not to prune.** It already holds the current requests
  and the files being touched: prune lightly anything that matches the work in
  flight, heavily everything else. A local, deterministic relevance signal that
  costs no model call.
- **It makes the re-read targeted.** "Page X, saved at Y, used for Z" turns a
  refetch into one sliced read.

## Open questions, to settle with a benchmark and not in prose

- Which tools are worth pruning first. Suspects, in order of measured weight:
  `WebFetch`, `Bash`, `Read` of files nobody sliced.
- How much to keep, and whether "keep the matching part" can be decided
  deterministically or needs a cheap model (which would cost a call per tool use —
  probably fatal).
- Whether a wrong prune costs more than it saves: the agent re-runs the command,
  and that is a full round trip. This is the number that decides the design.
- Whether the installer should also write the auto-compaction window and turn off
  MCP servers and skills a user's own logs show they never use — the fixed 55k is
  the largest untouched block, and it travels on every single move.

## How it gets decided

Like everything else here: `bench/notebook.cjs` already drives one long session
over many turns and measures cost, correctness and what survives. The pruner arm
is one more arm in that harness. It ships **off** until the rows say otherwise,
and if they never do, it is deleted.
