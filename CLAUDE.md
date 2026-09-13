<!-- preferenze: 39f397b3 -->
# Pugiunculus

Hooks for Claude Code that cut what a coding session sends to the model. Three of
them refuse known waste (a whole-file `Read`, `cat BIG`, a fan-out of small
subagents). A fourth, off by default, keeps a session notebook that survives a
context cut. A fifth, off by default, suggests an effort level per prompt and
four skills set it. Nothing ships on an argument: a hook that does not move a
measured number is removed.

Node, no dependencies, CommonJS (`.cjs`), Windows first.

---

## How to work here

- A new hook arrives with a benchmark and its rows under `bench/`, or it does not
  arrive. "It should help" is not a reason.
- New behaviour ships **off** until a benchmark says otherwise.
- Every decision a hook takes is logged to `~/.claude/pugi/log.jsonl`, including
  when the hook is off, so the control group is counted and not assumed.
- Agents: never Fable. Haiku for mechanical, checkable work, Sonnet for a closed
  brief, Opus for design, obscure debugging and anything touching an invariant.
  Between agents the language is English, briefs short and complete: goal,
  constraints, files to touch, shape of the answer, when it is done.
- Report to the user in two points: what was implemented, and how to try it. The
  reasons, the bugs met on the way and the story go in `docs/STATO.md`.
- Ask the questions before starting, not halfway.
- A benchmark that spends money runs only when the user asks for it.

### Before every commit: document

| If this changed… | Write in |
|---|---|
| anything under `hooks/`, `install.cjs`, `measure*.cjs` | `docs/archivio/FATTO.md` — 2-5 lines at the end: what, and how to try it |
| a decision that is not to be reopened | `docs/STATO.md` §Decisions |
| a defect, found or closed | `docs/STATO.md` §Known problems |
| a step done or discovered | `docs/STATO.md` §Next steps |
| what a hook does, or a measured number | `README.md` — it is the public truth |
| the design of something not built yet | `docs/<topic>.md` |

Caps: `FATTO.md` grows. `STATO.md` does not — 40 KB, and its sections are
replaced, not appended. This file: 200 lines.

---

## Read before answering

| Question about… | Open |
|---|---|
| what each hook blocks, and the numbers behind it | `README.md` |
| the pruner — why it is closed, and what replaced it | `docs/potatore.md` |
| what the harness, skills and plugins inject before any tool runs, and what it costs — **open, to think about** | `docs/privately.md` |
| where the project stands: decisions, defects, next steps | `docs/STATO.md` |
| what was done, and when | `docs/archivio/FATTO.md` |
| what a session actually sends to the model | run `node measure-context.cjs` |

---

## Commands

```bash
node test.cjs                     # 49 tests: every hook decision, fed the JSON Claude Code sends
node install.cjs                  # the three blockers into ~/.claude/settings.json
node install.cjs --notebook       # add the session notebook (off by default)
node install.cjs --effort         # add the effort router: prompt hook + four skills (off by default); detects your language, learns your words from history
node bench/effort-score.cjs --learn   # learn word lists from your prompts and judge them on sessions they never saw
node bench/effort-score.cjs --check   # harder: five folds by session, a split by time, a learning curve
node install.cjs --lettore        # add the lean reader agent + subagent cache for an hour (off by default)
node bench/effort-score.cjs       # does the scorer separate easy turns from hard ones, on your own prompts
node measure-context.cjs --agents # what a subagent pays before doing anything
node measure-context.cjs --writes # Write calls over files already open: what an Edit would have spared
node measure.cjs                  # what whole-file reads cost in your own history
node measure-context.cjs          # where a session's cost goes: re-reading, cache writes, output, prompts
node measure-context.cjs --tools  # which tools' results weigh most, and what the big Reads were
node measure-context.cjs --fixed  # skills, commands, agents, MCP servers listed on every move and never used
node measure-context.cjs --split  # what a request carries, by category: fixed part, your words, tool results, the model's moves
node bench/fanout.cjs --report    # the fan-out experiment
node bench/hard.cjs --report      # the chain experiment
node bench/notebook.cjs --report  # today vs cut vs notebook, per model and effort
node bench/prune-sim.cjs          # the ceiling of clearing old tool results, replayed on your own transcripts
```

`node test.cjs` must be green before a commit.

---

## Invariants

- A hook never breaks a session: on any error the tool call goes through untouched.
- A hook never refuses the same thing twice: if the agent insists, it passes.
- Nothing leaves the machine: no API key, no network call, no telemetry.
- `PUGI_OFF=1` or `~/.claude/pugi/OFF` disables every hook and keeps the log.
- The installer is idempotent and backs up `settings.json` before writing.
- No hook ever summarizes or rewrites the user's own words.

---

## Maintenance

When a document is born in `docs/`, add its line to the table above. What
happened goes in `docs/STATO.md`, not here.
