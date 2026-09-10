# squint

**Your coding agent opens a 21,000-token file to read ten lines. Then carries it for the rest of the session.**

squint is two hooks that stop the two biggest ways a coding agent burns tokens on nothing:

- **opening a whole file** to read ten lines — 21,163 tokens where 614 would do
- **spawning ten small subagents** where two would do — each one pays ~30,000 tokens before it does any work

Both refuse once and explain the cost. If the agent really needs it, it asks again and gets it.

```bash
git clone https://github.com/namespaceMarcello/squint && node squint/install.cjs
```

No restart. No API key. Nothing leaves your machine.

---

## The thing it stops

A real question on a real 84 KB source file — *"where is the click handled?"*

| | tokens |
|---|---|
| open the whole file | **21,163** |
| `Grep` for the symbol, then `Read` 30 lines around it | **614** |

Same answer. **34× cheaper.** And the 21,000 tokens don't stay in the context competing with everything else for the rest of the session.

The agent knows how to do the second one. It just doesn't, unless something stops it.

### What it looks like

```
> where is the click handled in boot.ts?

  Read(src/iso/boot.ts)
  ✗ Whole-file Read blocked: ~21163 tokens for one file. Find the line
    with Grep first, then Read with offset/limit around it. If you
    genuinely need the entire file, repeat this exact Read and it will
    go through.

  Grep(pattern: "click", path: "src/iso/boot.ts")
  ✓ 8 matches                                              164 tokens

  Read(src/iso/boot.ts, offset: 405, limit: 30)
  ✓ 30 lines                                               450 tokens

  statoCursore() at line 409 decides when the cursor lights up.
```

One refusal, two targeted calls, same answer. The agent needed no instruction beyond the refusal itself — and if it had actually needed all 1,822 lines, repeating the Read would have handed them over.

## The other thing it stops

A Haiku subagent that does *nothing at all* — zero tools, replies "OK" — already costs **29,584 tokens**. Sonnet: **43,586**. That is a meter drop, paid before any work happens, once per agent you spawn.

The same 50 questions, split three ways:

| shape | tokens | vs. baseline | correct |
|---|---|---|---|
| 10 agents × 5 questions | 558,726 | — | 50/50 |
| 5 agents × 10 questions | 314,239 | **−44%** | 50/50 |
| 2 agents × 25 questions | **204,398** | **−63%** | 50/50 |

Same questions, same answers. **Fewer, bigger agents cut 63%** — roughly double what the read block saves on the same model.

**Where the second hook fires, and why there.** Not mid-batch: refusing the last seven of a ten-agent fan-out leaves three orphans and a mess. It waits for the batch to end, then blocks the *first spawn of the next one*, carrying the evidence with it — *"your last batch was 10 subagents with a median prompt of 480 characters, about 300,000 tokens on meter drops alone."* Consequence, stated plainly: the first fan-out of a session is never blocked. There is nothing to learn from yet.

---

## Does it actually work?

50 questions about a 40,000-line TypeScript codebase, each requiring one exact value from a large file. Every question asked twice — once with squint, once without — to fresh subagents that had no idea they were in an experiment. 100 runs.

| model | with squint | without | difference | correct answers |
|---|---|---|---|---|
| Haiku 4.5 | 558,726 | 817,065 | **+46.2% without** | 50/50 both ways |
| Sonnet | 493,503 | 603,494 | **+22.3% without** | 50/50 both ways |
| Opus | 398,611 | 407,423 | **+2.2% — noise** | 50/50 both ways |

**Not one wrong answer, either way.** squint made it cheaper, never worse.

On Haiku it helped in **10 groups out of 10** — no exceptions. Its cost: about three extra tool calls per ten questions.

### The stronger the model, the less this matters

That third row is the one to read carefully. **On Opus, squint fired zero times.** Not "rarely" — never. Across 50 questions and 10 agents, Opus did not open a single whole file. It went straight to Grep every time, so the hook had nothing to block. The +2.2% is one noisy group, not an effect.

| model | groups where squint changed the outcome | times it fired |
|---|---|---|
| Haiku 4.5 | 10 / 10 | every group |
| Sonnet | 2 / 10 | 7 blocks, 2 insisted |
| Opus | 1 / 10 (noise) | **0** |

Opus spent the fewest tokens of the three — 398,611, 29% below Haiku. **Tokens are not the bill, though.** At list prices ($1/MTok for Haiku 4.5, $2 for Sonnet 5, $5 for Opus 5) the same 50 questions cost:

| model | with squint | without | squint saves |
|---|---|---|---|
| Haiku 4.5 | **$0.56** | $0.82 | **32%** |
| Sonnet 5 | $0.99 | $1.21 | 18% |
| Opus 5 | $1.99 | $2.04 | 2% |

*(Approximate: the harness reports one total per agent, not an input/output/cache split. Output was five lines per run, so almost all of it is input, priced at the input rate.)*

So the ranking flips when you count money instead of tokens. **Haiku with squint was the cheapest way to get all 50 answers right — 3.6× cheaper than Opus, at identical accuracy.** Opus is more efficient per task and still costs far more per task.

**Which is the case for squint, not against it.** The cheap model is the one you run in bulk, it is the one that opens whole files, and it is where squint saves the most: a third of the bill. On Opus it saves 2% and never fires — so if every agent you run is Opus, do not install this.

### Telling the agent doesn't work. Stopping it does.

Same 50 questions, squint **off** in both arms. One arm got a line at the top of the prompt: *"you read whole files 19% of the time; a targeted read costs about 30× less."*

| | tokens | how often it worked |
|---|---|---|
| nothing | 817,065 | — |
| **telling it** | 667,805 (−18.3%) | **3 times out of 10** |
| **stopping it** | 558,726 (−31.6%) | **10 times out of 10** |

The seven groups that ignored the warning ignored it completely — within ±200 tokens of the arm that was never told anything. Not "partly followed". Ignored.

If you have been writing rules into `CLAUDE.md` and wondering why nothing changes: this is why.

---

## Where it does *not* help

This section exists because the benchmark that only shows wins is not a benchmark.

**Tasks that genuinely need the whole file.** 10 "list every exported function in this file" tasks, scored on how many items were actually found:

| | with squint | without |
|---|---|---|
| recall | **97.9%** | **99.5%** |
| tokens | 326,932 | 620,978 |

Eight tasks tied, one was worse with squint, one was better. The one real loss: 9 of 13 constants found instead of 13 of 13. squint doesn't hide anything — it shifts the work onto the agent's ability to search, and a small model searches imperfectly.

**Strong models need it less.** Sonnet already reads well: squint changed the outcome in only 2 groups out of 10. But in those two it saved ~70,000 tokens each. Sonnet also *insisted* (asked twice and got the file) 2 times out of 9 blocks. Haiku never did — the escape hatch is used by the models that know when they need it.

**Model choice beats both hooks.** Neither hook can see that you picked an expensive model for mechanical work — that decision is already made by the time a tool call exists. Haiku with squint answered all 50 questions for $0.56; Opus, needing neither hook, cost $1.99 for the same answers. No hook can fix that for you.

**Claude Code already blocks exact duplicate re-reads** natively. squint is about the first read, not the second.

**Effort levels change nothing here.** The obvious cheaper lever would be to raise the agent's reasoning budget and hope it picks Grep on its own. Tested: 20 more Haiku runs with squint off, `effortLevel` set to `low` for one batch and `xhigh` for the other.

| | tokens | whole-file reads | correct |
|---|---|---|---|
| default | 817,065 | 41 | 50/50 |
| effort `low` | 817,093 | 41 | 50/50 |
| effort `xhigh` | 816,980 | 41 | 50/50 |

Three configurations, 113 tokens apart, and **the same 41 whole-file reads every time**.

A caveat worth stating plainly: results that identical are suspicious. Real behavioural variance is larger — elsewhere in this benchmark the same prompt ranged from 46k to 117k tokens. So the likely explanation is that per-model `effortLevel` never reached the spawned agents at all, not that reasoning budget is irrelevant. Claude Code wrote empty transcripts for those subagents, so thinking-token usage could not settle it.

Either way the practical answer is the same: **turning that dial did not stop a single whole-file read.**

---

## Measure your own history before you install

squint ships with the tool that produced these numbers. Point it at your own logs:

```bash
node measure.cjs
```

It replays your entire Claude Code history and tells you how many whole-file reads squint would have blocked, how many tokens were at stake, and — the part most tools skip — **how often it would have got in your way**: blocks per session, median and worst case.

```bash
node measure.cjs --sweep     # compare 4 / 8 / 16 / 32 / 64 KB thresholds
```

Nothing is uploaded. No API calls. It reads `~/.claude/projects` and prints numbers.

On the 607-session history this was built from: 734 reads would have been blocked, 3.5M tokens at stake, median 2 blocks per session, worst case 15.

**The trade, in one line:** a blocked read is worth ~4,800 tokens. A pointless block costs ~85 (the refusal, then you read it anyway). squint pays for itself if it is right **more than 1.9% of the time**.

---

## How the benchmark was run

Reproducible, because a number you can't reproduce is a marketing claim.

- **Subjects:** fresh subagents, one arm at a time, identical prompts. They were not told an experiment was happening.
- **Questions:** generated by script from the codebase (`const NAME = <literal>` in files over 12 KB, unique name across the project), with the correct answers extracted from source — never written by hand, never graded by judgement.
- **Control:** `SQUINT_OFF=1` disables the block while still logging every decision, so the control group's behaviour is counted, not assumed.
- **Scoring:** exact string match against the extracted answers, quoting normalised.
- **Everything logged:** `~/.claude/squint/log.jsonl` records every decision — `slice`, `small`, `blocked`, `insisted`, `off` — so you can tell whether behaviour changed, not just whether the bill did.

---

## Config

| | |
|---|---|
| `SQUINT_THRESHOLD_BYTES` | when to start blocking (default `8000`) |
| `SQUINT_OFF=1` | disable the block, keep the log — for your own A/B |
| `~/.claude/squint/OFF` | same, as a file — subagents do not inherit your shell, so this is the one that gives you a real control group |
| `SQUINT_LOG=0` | turn the log off entirely |

```bash
node install.cjs --uninstall
```

Your `settings.json` is backed up to `settings.json.backup-squint` before anything is written.

Why 8 KB: swept 4 / 8 / 16 / 32 / 64 KB over 607 real sessions. 8 KB keeps 91% of the tokens at stake with 26% fewer blocks than 4 KB. Above 64 KB nothing fires at all, because `Read` truncates its own results around 16k tokens.

---

## What this is not

It is not a framework, a memory layer, or a context manager. It is two hooks, under 300 lines together, that stop two specific wastes — and a measurement tool so you can check whether they stopped anything on *your* machine.

If the number doesn't move for you, uninstall it. That's what the measurement is for.

MIT.
