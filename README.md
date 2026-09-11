# squint

**Your coding agent opens an 84 KB file to read ten lines. Then carries 12,000 tokens of it for the rest of the session.**

squint is three hooks that stop the ways a coding agent burns tokens on nothing:

- **opening a whole file** to read ten lines — 11,747 tokens where 614 would do
- **`cat BIG` instead** — the same waste through the shell, which is where most of it actually happens
- **spawning ten small subagents** where two would do — each pays a fixed entry cost before doing any work

Each refuses once and explains the cost. If the agent really needs it, it asks again and gets it. The first two are measured to pay off. The third, as shipped, is measured *not* to change what the model does — its section says so, with numbers.

```bash
git clone https://github.com/namespaceMarcello/squint && node squint/install.cjs
```

No restart. No API key. Nothing leaves your machine.

---

## The thing it stops

A real question on a real 84 KB source file — *"where is the click handled?"*

| | tokens |
|---|---|
| open the whole file | **11,747** |
| `Grep` for the symbol, then `Read` 30 lines around it | **614** |

Same answer. **19× cheaper.** And the 12,000 tokens don't stay in the context competing with everything else for the rest of the session.

The 11,747 is what the transcript shows the agent actually received, not the file's size. The file is 84,652 bytes — about 21,000 tokens — but `Read` stops at roughly 47,000 characters, so the "whole file" was 973 of its 1,822 lines. The refusal below quotes the size-based figure as an upper bound; every number in this README is the measured one.

The agent knows how to do the second one. It just doesn't, unless something stops it.

### What it looks like

```
> where is the click handled in boot.ts?

  Read(src/iso/boot.ts)
  ✗ Whole-file Read blocked: up to ~21163 tokens for one file. Find the
    line with Grep first, then Read with offset/limit around it. If you
    genuinely need the entire file, repeat this exact Read and it will
    go through.

  Grep(pattern: "click", path: "src/iso/boot.ts")
  ✓ 8 matches                                              164 tokens

  Read(src/iso/boot.ts, offset: 405, limit: 30)
  ✓ 30 lines                                               450 tokens

  statoCursore() at line 409 decides when the cursor lights up.
```

One refusal, two targeted calls, same answer. The agent needed no instruction beyond the refusal itself — and if it had actually needed the file, repeating the Read would have gone through.

## The back door

Blocking `Read` does nothing about `cat file`, which puts the same tokens in the same context through the shell. In the logs this was built from, **Bash out-consumed Read** — 7.08M tokens against 5.85M — with `cat` alone at 693 calls and 1.5M, and wide `sed -n` ranges another 1.6M.

The third hook closes it: `cat BIG`, `type BIG`, `Get-Content BIG`, `nl` / `tac` / `less BIG`, `head -n 5000 BIG`, `head -c 100000 BIG`, `tail -n +1 BIG`, `sed -n '1,4000p' BIG`, `sed -n '1,$p' BIG` — and every command of a chain, so `cd src && cat BIG` is still `cat BIG`. It is deliberately conservative: a pipe or a redirect of stdout (`cat x | grep y`) is allowed because that output was never going to be large, and a narrow slice (`sed -n '100,140p'`, `head -n 40`, `Get-Content x -Tail 40`) is exactly the behaviour we want.

It is a list of the shapes that showed up in real logs, not a fence. `awk '{print}'`, `grep '' file` and `python -c` go straight through, on purpose: an agent that reaches for those after a refusal has decided it needs the file.

Two things to know before installing it. The shell tool cuts its output at about 30,000 characters, so one `cat` can cost at most ~7,500 tokens, and in the logs above the average `cat` was worth about 2,200 — against ~4,800 for a blocked `Read`. The back door is wider, but each pass through it is cheaper: expect more blocks here, each saving less.

> If you already run something that compresses shell output (rtk, headroom, …), your `cat` may be cheap already. Measure before installing this one.

## The other thing it stops

A Haiku subagent that does *nothing at all* — zero tools, replies "OK" — already cost **29,584 tokens** on the machine this was built on. Sonnet: **43,586**. That is an entry fee, paid before any work happens, once per agent you spawn.

**That number is not a constant, and squint does not pretend it is.** It is the sum of your system prompt, every tool schema, your skill list and your CLAUDE.md — so it depends on your plugins and MCP servers, not on ours. `node measure.cjs` derives yours from your own logs (the cheapest subagent you have ever run) and the hook quotes *that* back at you when it blocks. Until you run it, the refusal says so instead of inventing a figure.

The same 50 questions, split three ways:

| shape | tokens | vs. baseline | correct |
|---|---|---|---|
| 10 agents × 5 questions | 558,726 | — | 50/50 |
| 5 agents × 10 questions | 314,239 | **−44%** | 50/50 |
| 2 agents × 25 questions | **204,398** | **−63%** | 50/50 |

Same questions, same answers. **Fewer, bigger agents cut 63%** — when a person does the batching. Roughly double what the read block saves on the same model.

**Where the second hook fires, and why there.** Not mid-batch: refusing the last seven of a ten-agent fan-out leaves three orphans and a mess. It waits for the batch to end, then blocks the *first wave of the next one*, carrying the evidence with it — *"your last batch was 10 subagents with a median prompt of 480 characters, about 300,000 tokens on meter drops alone."* A wave is every spawn issued in the same turn: Claude Code fires them, and their hooks, at the same instant, so they are all refused together with the same message. Consequence, stated plainly: the first fan-out of a session is never blocked. There is nothing to learn from yet.

### Does the refusal make the agent batch? Measured: no.

The 63% above was batched by hand. The hook's job is to get the *model* to do it, so that was tested on its own: 16 headless Claude Code sessions, each given ten questions in two batches of five. Batch A was told "one subagent per question", so the session had a wasteful batch on record. Batch B only said "also with subagents". With the hook on, the first wave of batch B was refused, with the message above and the measured entry cost in it. The control had only this hook off; the read and shell hooks stayed on in both arms.

| orchestrator | hook | refused | what it did next | agents | tokens / run | $ / run | minutes | correct |
|---|---|---|---|---|---|---|---|---|
| Haiku 4.5 | on | 5 / 5 | insisted 4, rebatched 1 | 9.2 | 1,041,979 | 0.29 | 1.0 | 50/50 |
| Haiku 4.5 | off | — | — | 10 | 912,278 | 0.26 | 0.8 | 29/30 |
| Sonnet 5 | on | 5 / 5 | insisted 5 | 10 | 912,893 | 0.39 | 1.1 | 50/50 |
| Sonnet 5 | off | — | — | 10 | 922,179 | 0.38 | 0.9 | 30/30 |

Nine times out of ten the model read the refusal and re-issued the same agents with the same prompts. Once, Haiku folded two questions into one agent. Nobody wrote a longer prompt. The refusal costs a round trip — 14% more tokens and a fifth more wall-clock on Haiku, noise on Sonnet — and buys nothing, because the retry is free and the model knows it.

**This is the README's own finding turned on its own hook.** Telling doesn't work, stopping does — and a block that waves the retry through is telling. The read hook gets away with it because the cheaper path is one Grep away and the refusal repeats for every file; the fan-out hook refuses once per batch, and the cheaper path means rewriting ten prompts into two. So, as shipped, the third hook is a meter, not a brake: it records every wasteful batch and quotes its cost, and its log will tell you what your fan-outs are costing you. It does not yet stop them. What would — refusing until the prompts actually change — trades away the escape hatch, and that is a decision, not a bug fix.

**What was not measured.** Whether batching *hurts* anywhere: tasks that need separate contexts, or long outputs that fill one agent up. The 2 × 25 arm answered 50/50 on this task, which says nothing about those.

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

**The fan-out hook, as shipped, costs a round trip and changes nothing.** Nine retries out of ten on Haiku and Sonnet, 14% more tokens on Haiku for the same answers. The section above has the table. Until it refuses harder, it is a meter.

**Model choice beats every hook.** No hook can see that you picked an expensive model for mechanical work — that decision is already made by the time a tool call exists. Haiku with squint answered all 50 questions for $0.56; Opus, needing neither hook, cost $1.99 for the same answers. No hook can fix that for you.

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
- **Control:** `SQUINT_OFF=1` disables the block while still logging every decision, so the control group's behaviour is counted, not assumed. The fan-out experiment uses `SQUINT_FANOUT_OFF=1` instead, so its control keeps the read and shell hooks on and differs from the treatment in one hook only.
- **Scoring:** exact string match against the extracted answers, quoting normalised.
- **Everything logged:** `~/.claude/squint/log.jsonl` records every decision — `slice`, `small`, `blocked`, `insisted`, `rebatched`, `off` — so you can tell whether behaviour changed, not just whether the bill did.
- **The fan-out experiment ships:** `node bench/fanout.cjs --src <your codebase> --model haiku --runs 5` runs it against your own code, headless, and `--report` prints the table. The raw rows behind the table above are in `bench/fanout-results.jsonl`.
- **The hooks are tested:** `node --test test.cjs` feeds each one the JSON Claude Code would and checks every decision on this page — including five hooks fired at the same instant.

---

## Config

| | |
|---|---|
| `SQUINT_THRESHOLD_BYTES` | when to start blocking, `Read` and shell alike (default `8000`) |
| `SQUINT_BASH_LINES` | a `head` / `sed` range wider than this counts as the whole file (default `500`) |
| `SQUINT_FANOUT_MIN` | how many small agents in a row make a batch wasteful (default `4`) |
| `SQUINT_FANOUT_CHARS` | median prompt under this is "small" (default `1500`) |
| `SQUINT_FANOUT_GAP` | seconds of quiet that end a batch (default `60`) |
| `SQUINT_OFF=1` | disable every block, keep the log — for your own A/B |
| `SQUINT_READ_OFF=1` · `SQUINT_BASH_OFF=1` · `SQUINT_FANOUT_OFF=1` | disable one hook only, so a control group differs in one thing |
| `~/.claude/squint/OFF` | same, as a file — subagents do not inherit your shell, so this is the one that gives you a real control group |
| `SQUINT_LOG=0` | turn the log off entirely |

```bash
node install.cjs --uninstall
```

Your `settings.json` is backed up to `settings.json.backup-squint` before anything is written.

Why 8 KB: swept 4 / 8 / 16 / 32 / 64 KB over 607 real sessions. 8 KB keeps 91% of the tokens at stake with 26% fewer blocks than 4 KB. Above 64 KB nothing fires at all, because `Read` truncates its own results around 16k tokens.

---

## What this is not

It is not a framework, a memory layer, or a context manager. It is three hooks, about 560 lines together, that stop two specific wastes and meter a third — and a measurement tool so you can check whether they stopped anything on *your* machine.

If the number doesn't move for you, uninstall it. That's what the measurement is for.

MIT.
