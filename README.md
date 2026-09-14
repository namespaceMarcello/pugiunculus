# Pugiunculus

**Your coding agent opens an 84 KB file to read ten lines. Then carries 12,000 tokens of it for the rest of the session.**

Pugiunculus is four hooks that stop the ways a coding agent burns tokens on nothing:

- **opening a whole file** to read ten lines — 11,747 tokens where 614 would do
- **`cat BIG` instead** — the same waste through the shell, which is where most of it actually happens
- **spawning ten small subagents** where two would do — each pays a fixed entry cost before doing any work
- **the first prompt after an hour away** — the cache is cold, and "commit" rewrites 265k tokens at twice the input price

The first two and the last refuse once and explain the cost; if you or the agent really need it, the same request again goes through. The third refuses until the prompts change, because refusing once was measured to change nothing — its section says so, with numbers.

```bash
git clone https://github.com/namespaceMarcello/pugiunculus && node pugiunculus/install.cjs
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

**That number is not a constant, and Pugiunculus does not pretend it is.** It is the sum of your system prompt, every tool schema, your skill list and your CLAUDE.md — so it depends on your plugins and MCP servers, not on ours. `node measure.cjs` derives yours from your own logs (the cheapest subagent you have ever run) and the hook quotes *that* back at you when it blocks. Until you run it, the refusal says so instead of inventing a figure.

The same 50 questions, split three ways:

| shape | tokens | vs. baseline | correct |
|---|---|---|---|
| 10 agents × 5 questions | 558,726 | — | 50/50 |
| 5 agents × 10 questions | 314,239 | **−44%** | 50/50 |
| 2 agents × 25 questions | **204,398** | **−63%** | 50/50 |

Same questions, same answers. **Fewer, bigger agents cut 63%** — when a person does the batching. Roughly double what the read block saves on the same model.

**Where the third hook refuses, and why there.** Never the first fan-out of a session: there is nothing to learn from yet. Once a batch of four or more small agents has finished, every later spawn that looks the same — a prompt no longer than the ones just paid for — is refused, carrying the evidence with it — *"your last batch was 10 subagents with a median prompt of 230 characters, about 300,000 tokens on entry costs alone"* — and the way through: a prompt at least twice that median. A valve lets the fourth refused wave through, so a model that never reads the message cannot loop. (`PUGI_FANOUT_ESCAPE=1` adds a second way through, `[separate context]` written in the prompt; it is off by default, for the reason measured below.) A wave is every spawn issued in the same turn: Claude Code fires them, and their hooks, at the same instant, and each is judged on its own prompt, so five short prompts are refused together, not one of five.

### Does the refusal make the agent batch?

The 63% above was batched by hand. The hook's job is to get the *model* to do it, so that was tested on its own: headless Claude Code sessions, each given ten questions in two batches of five. Batch A was told "one subagent per question", so the session had a wasteful batch on record. Batch B only said "also with subagents". With the hook on, the first wave of batch B was refused. The control had only this hook off; the read and shell hooks stayed on in both arms.

**The first version refused once and let the retry through.** Measured: it changed nothing.

| orchestrator | hook | what it did after the refusal | agents | tokens / run | $ / run | correct |
|---|---|---|---|---|---|---|
| Haiku 4.5 | refuse once | insisted 4 / 5, rebatched 1 / 5 | 9.2 | 1,041,979 | 0.29 | 50/50 |
| Sonnet 5 | refuse once | insisted 5 / 5 | 10 | 912,893 | 0.39 | 50/50 |

Nine times out of ten the model read the refusal and re-issued the same agents with the same prompts. The refusal cost a round trip and bought nothing, because the retry was free and the model knew it. Telling doesn't work, stopping does — and a block that waves the retry through is telling. That is the README's own finding turned on its own hook.

**So now it refuses until the prompts change.** Same experiment, same control:

| orchestrator | hook | what it did after the refusal | agents | tokens / run | $ / run | minutes | correct |
|---|---|---|---|---|---|---|---|
| Haiku 4.5 | off | — | 10 | 912,278 | 0.26 | 0.8 | 29/30 |
| Haiku 4.5 | **on**, hatch offered | **rebatched 5 / 5** | **6.6** | **821,277** | **0.23** | 1.1 | 50/50 |
| Sonnet 5 | off | — | 10 | 922,179 | 0.38 | 0.9 | 30/30 |
| Sonnet 5 | on, hatch offered | escaped 4 / 5, rebatched 1 / 5 | 9.4 | 1,002,250 | 0.42 | 1.1 | 50/50 |
| Sonnet 5 | **on**, no hatch | **rebatched 4 / 5**, valve 1 / 5 | **7.2** | **811,527** | **0.35** | 1.2 | 50/50 |

Haiku, refused twice, folded the five questions into one or two agents every time: 10% fewer tokens, 12% less money, a third longer on the clock, every answer right. It never touched the hatch.

Sonnet read the same message and, four times out of five, wrote `[separate context]` into prompts that had no such need — Haiku had just shown these tasks batch fine — and launched its ten agents anyway, paying 10% *more* than the control for the refused waves. The escape hatch was used by the model that read the message, and it was used as a bypass. With the hatch gone, the same Sonnet folded the questions four times out of five and hit the valve once: 12% fewer tokens, 8% less money. So the hatch is off by default and one environment variable away, on the strength of five runs. A model that genuinely needs separate contexts now pays three refused waves for them; that cost is in the table too, in the valve row's minutes.

**What was not measured.** Whether batching *hurts* anywhere: tasks that need separate contexts, or long outputs that fill one agent up. Every batched arm answered 50/50 on this task, which says nothing about those. Opus was not tried as an orchestrator.

---

## The cold cache

Claude Code sends the whole conversation with every request and reads it from a cache: 0.1× the input price (0.025× on Fable 5.1) instead of 1×. The cache lives one TTL after the last request — an hour on a subscription, five minutes on an API key or on usage credits. Come back later and the first prompt, whatever it says, rewrites the whole conversation at the cache-write rate, 2×. A 265k context is 530k there: twenty turns of re-reading it warm, for "commit".

The fourth hook reads the transcript on every prompt. When the last request is older than the TTL it blocks the prompt once and shows a table: what continuing, `/compact` first and `/clear` cost now and on every later turn, in input tokens, and what each one loses — nothing, the detail a summary drops, the whole history. Colours say which way each number goes (`NO_COLOR` or `PUGI_COLOR=0` turns them off). `↑` brings the prompt back; sent again, it goes through. A `/compact` after the last request goes through too: the cache is rebuilt either way. Slash commands are never blocked.

```
pugi: you were away 2h 15m; the cache keeps the conversation for an hour. Your prompt is on hold.
What each choice costs, in input tokens:

  ┌────────────────┬────────────────────────────────────┬──────────────────────────┬────────────────────────────────────────┐
  │ if you…        │ you pay now                        │ then, on every request   │ and you lose                           │
  ├────────────────┼────────────────────────────────────┼──────────────────────────┼────────────────────────────────────────┤
  │ continue       │ 530k tokens  (the whole history)   │ 27k tokens               │ nothing                                │
  │ /compact first │ 315k tokens (−41%)                 │ 9k tokens   (−66%)       │ detail: a summary replaces the history │
  │ /clear         │ 0           (−100%)                │ 6k tokens   (−79%)       │ the history                            │
  └────────────────┴────────────────────────────────────┴──────────────────────────┴────────────────────────────────────────┘
  ↑ brings your prompt back; Enter sends it and continues as it is.
```

The blocked prompt is written to Claude Code's prompt history as well, so `↑` finds it even when Claude Code dropped it.

On the logs this was built from, 7 days: 15 returns after more than an hour, and the rewrites alone were 13% of everything the week cost. What followed those returns was 60% of the week; replayed with a `/compact` at each return it would have cost 25% less. Over 30 days: 6% and 13%. That is a ceiling — it assumes you compact every time — and the hook's log says how often you did:

```bash
node bench/cold.cjs             # your own returns after an hour: as it went, with /compact first, with /clear
node bench/cold.cjs --days 30
```

It follows `promptCacheTtl` in your settings (5 minutes when set to `5m`), and `PUGI_COLD_MINUTES` overrides it.

---

## Does it actually work?

50 questions about a 40,000-line TypeScript codebase, each requiring one exact value from a large file. Every question asked twice — once with Pugiunculus, once without — to fresh subagents that had no idea they were in an experiment. 100 runs.

| model | with Pugiunculus | without | difference | correct answers |
|---|---|---|---|---|
| Haiku 4.5 | 558,726 | 817,065 | **+46.2% without** | 50/50 both ways |
| Sonnet | 493,503 | 603,494 | **+22.3% without** | 50/50 both ways |
| Opus | 398,611 | 407,423 | **+2.2% — noise** | 50/50 both ways |

**Not one wrong answer, either way.** Pugiunculus made it cheaper, never worse.

On Haiku it helped in **10 groups out of 10** — no exceptions. Its cost: about three extra tool calls per ten questions.

### The stronger the model, the less this matters

That third row is the one to read carefully. **On Opus, Pugiunculus fired zero times.** Not "rarely" — never. Across 50 questions and 10 agents, Opus did not open a single whole file. It went straight to Grep every time, so the hook had nothing to block. The +2.2% is one noisy group, not an effect.

| model | groups where Pugiunculus changed the outcome | times it fired |
|---|---|---|
| Haiku 4.5 | 10 / 10 | every group |
| Sonnet | 2 / 10 | 7 blocks, 2 insisted |
| Opus | 1 / 10 (noise) | **0** |

Opus spent the fewest tokens of the three — 398,611, 29% below Haiku. **Tokens are not the bill, though.** At list prices ($1/MTok for Haiku 4.5, $2 for Sonnet 5, $5 for Opus 5) the same 50 questions cost:

| model | with Pugiunculus | without | Pugiunculus saves |
|---|---|---|---|
| Haiku 4.5 | **$0.56** | $0.82 | **32%** |
| Sonnet 5 | $0.99 | $1.21 | 18% |
| Opus 5 | $1.99 | $2.04 | 2% |

*(Approximate: the harness reports one total per agent, not an input/output/cache split. Output was five lines per run, so almost all of it is input, priced at the input rate.)*

So the ranking flips when you count money instead of tokens. **Haiku with Pugiunculus was the cheapest way to get all 50 answers right — 3.6× cheaper than Opus, at identical accuracy.** Opus is more efficient per task and still costs far more per task.

**Which is the case for Pugiunculus, not against it.** The cheap model is the one you run in bulk, it is the one that opens whole files, and it is where Pugiunculus saves the most: a third of the bill. On Opus it saves 2% and never fires — so if every agent you run is Opus, do not install this.

### Telling the agent doesn't work. Stopping it does.

Same 50 questions, Pugiunculus **off** in both arms. One arm got a line at the top of the prompt: *"you read whole files 19% of the time; a targeted read costs about 30× less."*

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

| | with Pugiunculus | without |
|---|---|---|
| recall | **97.9%** | **99.5%** |
| tokens | 326,932 | 620,978 |

Eight tasks tied, one was worse with Pugiunculus, one was better. The one real loss: 9 of 13 constants found instead of 13 of 13. Pugiunculus doesn't hide anything — it shifts the work onto the agent's ability to search, and a small model searches imperfectly.

**Strong models need it less.** Sonnet already reads well: Pugiunculus changed the outcome in only 2 groups out of 10. But in those two it saved ~70,000 tokens each. Sonnet also *insisted* (asked twice and got the file) 2 times out of 9 blocks. Haiku never did — the escape hatch is used by the models that know when they need it.

**The fan-out hook buys a fifth of what hand-batching does.** Batching by hand cut 63%; the refusal, on the same kind of task, cut 10–12%, because the model folds five questions into two agents, not twenty-five into one. And it adds a third to the wall-clock: two refused waves before the work starts.

**Model choice beats every hook.** No hook can see that you picked an expensive model for mechanical work — that decision is already made by the time a tool call exists. Haiku with Pugiunculus answered all 50 questions for $0.56; Opus, needing neither hook, cost $1.99 for the same answers. No hook can fix that for you.

**Claude Code already blocks exact duplicate re-reads** natively. Pugiunculus is about the first read, not the second.

**Effort levels change nothing here.** The obvious cheaper lever would be to raise the agent's reasoning budget and hope it picks Grep on its own. Tested: 20 more Haiku runs with Pugiunculus off, `effortLevel` set to `low` for one batch and `xhigh` for the other.

| | tokens | whole-file reads | correct |
|---|---|---|---|
| default | 817,065 | 41 | 50/50 |
| effort `low` | 817,093 | 41 | 50/50 |
| effort `xhigh` | 816,980 | 41 | 50/50 |

Three configurations, 113 tokens apart, and **the same 41 whole-file reads every time**.

A caveat worth stating plainly: results that identical are suspicious. Real behavioural variance is larger — elsewhere in this benchmark the same prompt ranged from 46k to 117k tokens. So the likely explanation is that per-model `effortLevel` never reached the spawned agents at all, not that reasoning budget is irrelevant. Claude Code wrote empty transcripts for those subagents, so thinking-token usage could not settle it.

Either way the practical answer is the same: **turning that dial did not stop a single whole-file read.**

---

## The effort router: think as much as the request needs

The model's own thinking is the largest single block a session re-reads — 20% of everything, measured with `node measure-context.cjs --split` on 14 days of real work — and it is produced at whatever effort the session was set to, whether the prompt was "commit e push" or a design question. Nothing in Claude Code lets a hook change the effort of a request, so the router does the one thing a hook can do: it says.

The router is one hook. On every prompt, `hooks/pugi-effort.cjs` scores the text with a word list — no model, no network — and adds one line next to it: *Effort suggested for this turn: 3/10 (mechanical, short).* Nothing else: no instruction on how to think, no skill to invoke, no parameter set. The number is the raw score on a 1-to-10 scale. On the author's 14 days the score runs from −5 to +6 and the thinking of the turns follows it step by step — 214 tokens at −5, 1.6k at 0, 4.8k at +2, 5.3k at +4 — so folding it into five named levels was throwing most of it away. A bare "vai" keeps the previous turn's number. The prompt itself is never touched.

Whether a word list can tell an easy turn from a hard one is the whole question, so `bench/effort-score.cjs` replays every typed prompt of your own history through the scorer and measures what the turn it started actually cost:

| scored as | turns | thinking, median | tool calls, median |
|---|---|---|---|
| low | 51 | 454 | 1 |
| medium | 260 | 1k | 3 |
| high | 74 | 1k | 1 |
| xhigh | 35 | 4k | 7 |
| max | 13 | 4k | 9 |

433 prompts, 14 days. Restricted to the 228 turns whose session sat at the same effort, so thinking is comparable, the turns scored `max` thought 16× the ones scored `low`. The list separates. What it does not do yet is prove the saving: that is a week of `node measure-context.cjs --split` with the router on, and it is why the router ships **off**.

```bash
node install.cjs --effort       # the hook; detects your language, learns your words from your history
node bench/effort-score.cjs     # the table above, on your own prompts; --samples prints ten prompts per level to read by eye
node bench/effort-score.cjs --text   # did the line move thinking? turns with it against turns without, same class, same session level
node install.cjs --no-effort    # takes the hook and the word pack out
```

The words are English by default, in `hooks/effort-words.json`, and the installer does not expect you to write your own. `node install.cjs --effort` reads your last 30 days of prompts, tells which language they are in, and adds that language's pack when there is one (`hooks/effort-words.it.json` today; `--lang xx` picks one by hand). Then, with a hundred prompts or more of history, it **learns your words**: within each effort level your sessions ran at, the turns that thought most are hard and the ones that thought least are easy, and a word or pair of words that keeps company with hard turns becomes a hard signal, one that keeps company with easy turns a mechanical one, in whatever language you write. Nothing learned is trusted on the data it came from: the lists are learned on half the sessions and judged on the other half by how often they rank a hard turn above an easy one, and they are written to `~/.claude/pugi/effort-words.json` only when they beat what is already there.

On the author's 814 prompts, judged on sessions the words never saw:

| word lists | ranks a hard turn above an easy one |
|---|---|
| English defaults | 62% |
| plus the Italian pack | 65% |
| learned from the history | 76% |

50% is a coin flip. `node bench/effort-score.cjs --learn` repeats the judgement on your own history without writing anything; `--no-learn` at install skips the step; anything you add to the words file by hand stays, and a file the installer did not write is never touched.

One split can be lucky, so `node bench/effort-score.cjs --check` does it three harder ways on the same 817 prompts: five folds by session, every session judged once by words that never saw it — defaults 63%, learned 76% on the mean, and better on every fold; a split by time, learned on the first three weeks and judged on the last — 55% to 67%, the weakest, because the last week's work was different from the rest; and a learning curve — 50 prompts give 63%, 100 give 67%, 200 give 72%, which is why the installer asks for a hundred.

**Does the line move thinking?** Not measured yet. `node bench/effort-score.cjs --text` compares, at the same session level and the same scored class, the turns that had the line next to the prompt with the turns that did not; it needs a week of sessions to say anything, and it is why the router ships **off**.

### Reading in a lean agent

A file read in the main conversation stays there and is re-read by every later request. Read by a subagent, it is paid once and thrown away with the agent's context; only the answer comes back. The catch is what a subagent pays before reading anything — its own system prompt and tool schemas. Measured on 744 subagents over 14 days: median 24k tokens for the first request, 44k at the 90th percentile.

`node install.cjs --lettore` writes a reader agent with three tools and ten lines of instructions, and sets the subagent prompt cache to an hour, so that price is paid once an hour rather than once per agent. Same trivial task, same model:

| agent | first request |
|---|---|
| `general-purpose`, Sonnet | 47,946 tokens |
| `lettore`, Sonnet | 10,657 tokens |

The whole-file `Read` refusal names it when it is installed. Hand it large reads and explorations across files with a complete brief — which files, what to look for, what shape of answer; open thirty lines yourself.

---

## Measure your own history before you install

Pugiunculus ships with the tool that produced these numbers. Point it at your own logs:

```bash
node measure.cjs
```

It replays your entire Claude Code history and tells you how many whole-file reads Pugiunculus would have blocked, how many tokens were at stake, and — the part most tools skip — **how often it would have got in your way**: blocks per session, median and worst case.

```bash
node measure.cjs --sweep     # compare 4 / 8 / 16 / 32 / 64 KB thresholds
```

Nothing is uploaded. No API calls. It reads `~/.claude/projects` and prints numbers.

On the 607-session history this was built from: 734 reads would have been blocked, 3.5M tokens at stake, median 2 blocks per session, worst case 15.

Four more readings of the same logs, same rules:

```bash
node measure-context.cjs          # where a session's cost goes: re-reading the conversation, cache writes, output, your prompts
node measure-context.cjs --tools  # which tools' results weigh most, and what the big Reads were (slices, insisted, hook off)
node measure-context.cjs --fixed  # every skill, command, agent and MCP server listed to the model on each move, and which ones you never use
node measure-context.cjs --split  # what a request carries, by category: the fixed part, your words, tool results, the model's text, calls and thinking
node measure-context.cjs --compact # what compacting at 150k, 200k, 250k or 400k would have cost or saved, your sessions replayed with the cap
```

On a 1M-context model the automatic compaction runs at about 967k, so a session grows all day and every request re-reads all of it. `--compact` replays your sessions with a lower cap and charges each compaction (one read of the context, the summary, what Claude Code puts back). What it cannot price is the detail a summary loses: that is a week with `/autocompact 200k` on. Cache reads are priced per model: 0.1× the input price, 0.025× on Fable 5.1.

**The trade, in one line:** a blocked read is worth ~4,800 tokens. A pointless block costs ~85 (the refusal, then you read it anyway). Pugiunculus pays for itself if it is right **more than 1.9% of the time**.

---

## How the benchmark was run

Reproducible, because a number you can't reproduce is a marketing claim.

- **Subjects:** fresh subagents, one arm at a time, identical prompts. They were not told an experiment was happening.
- **Questions:** generated by script from the codebase (`const NAME = <literal>` in files over 12 KB, unique name across the project), with the correct answers extracted from source — never written by hand, never graded by judgement.
- **Control:** `PUGI_OFF=1` disables the block while still logging every decision, so the control group's behaviour is counted, not assumed. The fan-out experiment uses `PUGI_FANOUT_OFF=1` instead, so its control keeps the read and shell hooks on and differs from the treatment in one hook only.
- **Scoring:** exact string match against the extracted answers, quoting normalised.
- **Everything logged:** `~/.claude/pugi/log.jsonl` records every decision — `slice`, `small`, `blocked`, `insisted`, `rebatched`, `escaped`, `off` — so you can tell whether behaviour changed, not just whether the bill did.
- **The fan-out experiment ships:** `node bench/fanout.cjs --src <your codebase> --model haiku --runs 5` runs it against your own code, headless, and `--report` prints the table. The raw rows behind the tables above are in `bench/fanout-results.jsonl` (refuse-until-changed) and `bench/fanout-results-v1.jsonl` (refuse once).
- **So does the chain benchmark:** `node bench/hard.cjs --src <your codebase> --model haiku` (add `--off` for the control, `--per 25` for the long sessions, `--list` to see the questions) and `--report`. Its rows are in `bench/hard-results-*.jsonl`, one file per arm.
- **The hooks are tested:** `node --test test.cjs` feeds each one the JSON Claude Code would and checks every decision on this page — including five hooks fired at the same instant.

---

## Config

| | |
|---|---|
| `PUGI_THRESHOLD_BYTES` | when to start blocking, `Read` and shell alike (default `8000`) |
| `PUGI_BASH_LINES` | a `head` / `sed` range wider than this counts as the whole file (default `500`) |
| `PUGI_FANOUT_MIN` | how many small agents in a row make a batch wasteful (default `4`) |
| `PUGI_FANOUT_CHARS` | median prompt under this is "small" (default `1500`) |
| `PUGI_FANOUT_GAP` | seconds of quiet that end a batch (default `60`) |
| `PUGI_FANOUT_VALVE` | refused waves in a row before one is let through anyway (default `3`) |
| `PUGI_FANOUT_ESCAPE=1` | offer `[separate context]` as a way through the fan-out refusal — off by default, Sonnet used it as a bypass 4 times out of 5 |
| `PUGI_COLD_MINUTES` | minutes of idle after which the cache counts as cold (default `60`, or `5` when `promptCacheTtl` is `5m`) |
| `PUGI_OFF=1` | disable every block, keep the log — for your own A/B |
| `PUGI_READ_OFF=1` · `PUGI_BASH_OFF=1` · `PUGI_FANOUT_OFF=1` · `PUGI_COLD_OFF=1` | disable one hook only, so a control group differs in one thing |
| `~/.claude/pugi/OFF` | same, as a file — subagents do not inherit your shell, so this is the one that gives you a real control group |
| `PUGI_LOG=0` | turn the log off entirely |

```bash
node install.cjs --uninstall
```

Your `settings.json` is backed up to `settings.json.backup-pugi` before anything is written.

Why 8 KB: swept 4 / 8 / 16 / 32 / 64 KB over 607 real sessions. 8 KB keeps 91% of the tokens at stake with 26% fewer blocks than 4 KB. Above 64 KB nothing fires at all, because `Read` truncates its own results around 16k tokens.

---

## What this is not

It is not a framework or a memory system. It is four hooks that stop four specific wastes, one that writes an effort number next to each prompt, and a lean reader agent — plus the measurement tools, so you can check whether any of it moved the number on *your* machine.

If the number doesn't move for you, uninstall it. That's what the measurement is for.

MIT.
