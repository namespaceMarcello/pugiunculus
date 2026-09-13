# What the harness injects, and what it costs — open question, nothing decided

The conversation is not only what we send on purpose. Claude Code attaches notes
of its own, and so do the skills, the plugins and the hooks installed on the
machine. They are invisible in the terminal and they travel on every move, like
everything else.

Measured on one real session (1,065 transcript lines, 87 moves by the model):
**180k tokens injected, in 308 pieces.**

| tokens | times | what |
|---|---|---|
| 47k | 1 | the Artifact tool's instructions, loaded at startup — nothing was published that day |
| 27k | 1 | the `claude-api` skill, opened once for a single check |
| 14k | 1 | the list of every installed skill |
| 13k | 68 | a harness reminder of ~190 tokens, repeated on tool results |
| 8k | 36 | a plugin's hook, firing on every command |
| 7k | 19 | the output of this repo's own hooks |
| 6k | 35 | the tokens-left counter |

Three groups, and only two of them can be touched:

- **Ours.** Skills, plugins, MCP servers, `CLAUDE.md`, memory, and every hook that
  injects context. In the session above, **88k of it is three items loaded at
  startup and never used again** — they were re-sent on every move for the rest of
  the day.
- **The harness's.** The periodic reminders and the counters. Not exposed in any
  setting we know of: a hook can add text, never remove it.
- **Earned.** The output of hooks that are doing their job — this repo's own
  refusals cost 7k in that session, which is what the work costs.

## What is worth thinking about before touching anything

- The fixed part is now measured per user, as sent: `node measure-context.cjs
  --fixed` reads the attachment records a transcript keeps of what the harness
  listed at session start — every skill with its line, the agent types, each
  MCP server's instructions and the names of its deferred tools, the context a
  hook added, the system prompt itself — and counts how often the window's
  sessions used each one. What a plugin or a claude.ai connector adds is
  marked as yours to switch off; the rest is built in. A tool that is not
  deferred costs its whole schema, which the transcript does not show.
- Whether switching them off should ever be automatic. Turning off a plugin
  changes what the agent can do: a wrong call here costs more than the tokens it
  saves. A report the user acts on may be the honest ceiling.
- Whether a skill's cost should be counted per use. A skill opened for one check
  is paid for the rest of the session, and nothing gives it back.
- How this meets the pruner (`docs/potatore.md`). The pruner trims what comes back
  from tools; this is about what is already there before any tool is called. Same
  principle, earlier in the pipe, and the larger number of the two.

No decision, no code yet. The number is the point: **the fixed part is paid on
every single move**, and in one ordinary day three unused items carried 88k of it.
