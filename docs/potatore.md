# The pruner (*potatore*) — closed, not built

Decided 2026-09-13. This note keeps the idea and the reasons it was dropped, so it
is not reopened without a new fact.

## The idea

What Pugiunculus stops today is waste at the door: a whole-file `Read`, a
`cat BIG`, a fan-out of small subagents. The pruner was to be the next hook,
from one observation that is still true: **what fills a session is not the
prompts, it is the material the work produces, and it never leaves again.**
Re-reading the conversation is 73% of what a session costs; the median request
carries 274k tokens; the words the human typed are 0.6% of the payload.

Two hooks were proposed:

- `PostToolUse` replacing a tool result with what matters plus a pointer to the
  raw thing on disk — the failures of a test run instead of the run, the matching
  section of a page instead of the page.
- `PreToolUse` rewriting a call instead of refusing it — a whole-file `Read`
  becoming a slice or a `Grep`, so the refusal's round trip is not paid.

## Why it is closed

Three findings, each enough on its own.

**1. The hook API cannot do it.** A `PostToolUse` hook cannot replace the output
of a built-in tool (`Read`, `Bash`, `Grep`, `WebFetch`): the documentation says
so explicitly, it can only add context. The one field that replaces output,
`updatedMCPToolOutput`, applies to MCP tools only. `PreToolUse` `updatedInput`
changes the parameters of the same tool; it cannot turn a `Read` into a `Grep`.
No event can touch a result already in the conversation.

**2. The weight is not where the note looked for it.** Measured on 34 interactive
sessions over 14 days (`node measure-context.cjs --tools` repeats it):

| tool | share of tool-result tokens |
|---|---|
| `Bash` | 61% |
| `Read` | 19% |
| `WebFetch` | 2% |
| MCP tools, all together | 2% |

`Bash` is volume, not blocks: ~3,800 calls of ~350 tokens, already filtered by
RTK. Of the 54 `Read` results above 2k tokens, three quarters were slices the
agent asked for with offset and limit, six were whole files read before the
hook was installed, two were insisted. The existing blocker works; "a `Read`
nobody sliced" is no longer a problem. 69% of all tool-result tokens sit in
results under 2k tokens — block-level pruning has little to bite. The one output
a hook may replace (MCP) is 2% of the total. And `WebFetch` already answers the
prompt with a small model instead of returning the page.

**3. The mechanism does not answer the diagnosis.** The diagnosis is an artifact
that stays after its purpose is spent. A hook acts before the model has seen
the result, when nobody knows which six lines will matter; the 19.8k saved in
the original example was a retroactive operation, and no hook can do one. A
fixed rule at the door (only the `FAIL` lines of a test run) is the wrong prune
the note itself called decisive, and its cost is not only the re-run: a cut that
drops the warning the agent needed produces a wrong answer, not a retry.

A fourth point about the note itself: its cost table (55k + 110k + 100k + 120k
+ 3k) summed to 388k, not the 514k it claimed, and no script in the repo
produced the per-category split it cited. Numbers that justify a hook must come
from a committed script.

## What a hook cannot do, a proxy could — at a price

Retroactive pruning needs to see the whole request: a local proxy on
`ANTHROPIC_BASE_URL`, or a rewrite of the session transcript before a resume.
Both are possible; both meet the cache. With the 1-hour cache TTL, editing the
prefix at a point P re-writes everything after P at 2× where it was read at
0.1×. Break-even is 19 × (tail after the cut) / (tokens removed) requests: a
20k page cut with 200k behind it pays back after 190 requests, more than a
session has. Pruning pays only when rare, large and batched — the shape
auto-compaction already has. Whether "clear old tool results" beats "summarize
everything" is the notebook's question, and its benchmark could not answer it.

`bench/prune-sim.cjs` replays real transcripts under such policies and puts a
ceiling on the saving before any proxy is written. The proxy is decided on that
number, and on whether a subscription login may go through a gateway at all.

## What replaced it

- `node measure-context.cjs --tools` — which tools weigh most in your own
  history, and what the big `Read`s were.
- `node bench/prune-sim.cjs` — the ceiling of retroactive pruning, and whether
  the harness already clears old results on its own.
- `node measure-context.cjs --fixed` — the block that travels on every move:
  skills, plugins and MCP servers your logs never use. See `docs/privately.md`.
- `node measure-context.cjs --split` — the per-category table this note
  claimed and could not reproduce, from the transcripts, against what the API
  billed.

What stays from the note: compression at the level of blocks, not words; never
touch paths, identifiers or error strings; never rewrite the user's words; never
prune silently.
