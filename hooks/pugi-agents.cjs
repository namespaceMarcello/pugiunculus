#!/usr/bin/env node
/**
 * pugi-agents — a Claude Code PreToolUse hook for subagent fan-out.
 *
 * A Haiku subagent that does nothing at all costs ~29,600 tokens before any
 * work happens. Sonnet: ~43,600. That is a meter drop, and every agent you
 * spawn pays it. Ten small agents pay ten meter drops for the work of two.
 *
 * Measured on the same 50 questions (see the README):
 *   10 agents x 5 questions   558,726 tokens
 *    5 agents x 10 questions  314,239   -44%
 *    2 agents x 25 questions  204,398   -63%   -- same 50/50 correct answers
 *
 * WHERE IT REFUSES, AND WHY THERE:
 * Never the first fan-out of a session: there is nothing to learn from yet.
 * Once a batch of MIN small agents has finished, every later spawn that looks
 * the same — a prompt no longer than the ones just paid for — is refused,
 * with the evidence ("last batch: 10 agents, median prompt 230 chars") and
 * the ways through:
 *   - a prompt at least twice that median (or SMALL_CHARS, whichever is
 *     less): the agent has put several tasks in one prompt
 *   - a valve: after VALVE refused waves in a row with no pass in between,
 *     the next spawn goes through, so a model that never reads the message
 *     cannot loop forever
 *   - with PUGI_FANOUT_ESCAPE=1, the words [separate context] in the
 *     prompt. Off by default: measured, Sonnet wrote them into prompts that
 *     had no such need four times out of five and paid more than the control
 *
 * Refusing once and waving the retry through was tried first. Measured on
 * Haiku and Sonnet: nine retries out of ten, same agents, same prompts.
 * A block the retry walks through is a suggestion, and suggestions were
 * already measured not to work (README, "telling doesn't work").
 *
 * A wave is every spawn issued in the same turn: Claude Code runs them, and
 * their hooks, at the same instant. Each is judged on its own prompt, so a
 * wave of five short prompts is refused together, not one of five.
 *
 * STATE: one append-only file per session. Five hooks running at once must not
 * lose each other's writes, and a read-modify-write of one JSON file does.
 *
 * Config (all optional):
 *   PUGI_FANOUT_MIN       default 4     — batch size that counts as wasteful
 *   PUGI_FANOUT_CHARS     default 1500  — median prompt below this = "small"
 *   PUGI_FANOUT_GAP       default 60    — seconds of quiet that end a batch
 *   PUGI_FANOUT_VALVE     default 3     — refused waves in a row before one passes
 *   PUGI_FANOUT_ESCAPE    default unset — "1" offers [separate context] as a way through
 *   PUGI_OFF=1, or a file at ~/.claude/pugi/OFF   — disable, keep logging
 *   PUGI_FANOUT_OFF=1     — disable only this hook: the control group for an
 *                           A/B that leaves the read and shell hooks on
 *   PUGI_LOG=0            — no decision log
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const MIN_BATCH = Number(process.env.PUGI_FANOUT_MIN) || 4
const SMALL_CHARS = Number(process.env.PUGI_FANOUT_CHARS) || 1500
const GAP_MS = (Number(process.env.PUGI_FANOUT_GAP) || 60) * 1000
const VALVE = Number(process.env.PUGI_FANOUT_VALVE) || 3

/** Spawns closer than this were issued in the same turn. */
const WAVE_MS = 1500
const ESCAPE = /\[separate context\]/i
const ESCAPE_ON = process.env.PUGI_FANOUT_ESCAPE === '1'

const HOME = os.homedir()
const DIR = path.join(HOME, '.claude', 'pugi')
const LOG = path.join(DIR, 'log.jsonl')
const OFF_SWITCH = path.join(DIR, 'OFF')
const STATE = path.join(os.tmpdir(), 'pugi-state')

const SPAWN_TOOLS = new Set(['Task', 'Agent'])

function exit(payload) {
  if (payload) process.stdout.write(JSON.stringify(payload))
  process.exit(0)
}

function note(row) {
  if (process.env.PUGI_LOG === '0') return
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.appendFileSync(LOG, JSON.stringify(row) + '\n')
  } catch {
    /* logging must never break the hook */
  }
}

function median(nums) {
  if (!nums.length) return 0
  const s = [...nums].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (raw += d))
process.stdin.on('end', () => {
  try {
    run(JSON.parse(raw))
  } catch {
    /* on any error the spawn goes through untouched */
  }
  exit(null)
})

function run(ev) {
  if (!SPAWN_TOOLS.has(ev.tool_name)) return

  const now = Date.now()
  const prompt = String(ev.tool_input?.prompt || '')
  const promptLength = prompt.length
  const base = { ts: new Date().toISOString(), session: ev.session_id || null, tool: ev.tool_name }

  // Append-only history: one line per spawn that went through ({at, len}) and
  // one per refusal ({block: <end of the batch it answered>, at}).
  fs.mkdirSync(STATE, { recursive: true })
  const stateFile = path.join(STATE, 'fanout-' + (ev.session_id || 'unknown') + '.jsonl')
  const history = []
  try {
    for (const line of fs.readFileSync(stateFile, 'utf8').split('\n')) {
      if (!line) continue
      try {
        history.push(JSON.parse(line))
      } catch {}
    }
  } catch {
    /* first spawn of the session */
  }
  const spawns = history.filter((h) => h.block === undefined)
  const refusals = history.filter((h) => h.block !== undefined)
  const record = (row) => {
    try {
      fs.appendFileSync(stateFile, JSON.stringify(row) + '\n')
    } catch {}
  }

  // Batches are runs of spawns with gaps of at most GAP. The trailing one is
  // still open if its last spawn is recent; the batch judged is the last one
  // that has closed. Refused spawns are not in the history, so every hook of
  // one wave sees the same batches and reaches the same verdict.
  let end = spawns.length - 1
  if (end >= 0 && now - spawns[end].at <= GAP_MS) {
    let i = end
    while (i > 0 && spawns[i].at - spawns[i - 1].at <= GAP_MS) i--
    end = i - 1
  }
  const previous = []
  for (let i = end; i >= 0; i--) {
    if (previous.length && previous[0].at - spawns[i].at > GAP_MS) break
    previous.unshift(spawns[i])
  }
  const med = median(previous.map((s) => s.len))
  const previousWasWasteful = previous.length >= MIN_BATCH && med < SMALL_CHARS

  const pass = (decision, extra) => {
    record({ at: now, len: promptLength })
    note({ ...base, decision, chars: promptLength, previousBatch: previous.length, ...extra })
  }

  if (!previousWasWasteful) return pass('pass')

  if (process.env.PUGI_OFF === '1' || process.env.PUGI_FANOUT_OFF === '1' || fs.existsSync(OFF_SWITCH)) {
    return pass('off')
  }

  // The ways through: a prompt that has grown, or a declared need.
  const enough = Math.min(SMALL_CHARS, 2 * med)
  if (promptLength >= enough) return pass('rebatched', { medianChars: med })
  if (ESCAPE_ON && ESCAPE.test(prompt)) return pass('escaped', { medianChars: med })

  // The valve: refused waves since the last spawn that went through. Spawns
  // of the current turn do not count as "went through" yet, so every hook of
  // this wave counts the same waves and opens together.
  let lastPassAt = 0
  for (const s of spawns) if (now - s.at > WAVE_MS) lastPassAt = s.at
  let waves = 0
  let lastWave = -Infinity
  for (const r of refusals) {
    if (r.at <= lastPassAt || now - r.at <= WAVE_MS) continue // this wave does not count yet
    if (r.at - lastWave > WAVE_MS) waves++
    lastWave = r.at
  }
  if (waves >= VALVE) return pass('insisted', { medianChars: med, refusedWaves: waves })

  // The entry cost is the installing user's, not a constant. `node measure.cjs`
  // derives it from their own logs and leaves it here.
  let toll = null
  try {
    toll = JSON.parse(fs.readFileSync(path.join(DIR, 'toll.json'), 'utf8')).toll
  } catch {
    /* not measured yet — the message says so instead of inventing a number */
  }

  record({ block: previous[previous.length - 1].at, at: now })
  const n = previous.length
  note({ ...base, decision: 'blocked', previousBatch: n, medianChars: med, chars: promptLength, refusedWaves: waves + 1 })

  exit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `Fan-out refused: your last batch was ${n} subagents with a median prompt of ${med} characters. ` +
        (toll
          ? `On this machine the cheapest subagent you have ever run cost ${toll.toLocaleString('en-US')} tokens before doing any work, so that batch spent at least ${(n * toll).toLocaleString('en-US')} tokens on entry costs alone. `
          : `Every agent pays a fixed entry cost before doing any work — tens of thousands of tokens, depending on your plugins and MCP servers. Run \`node measure.cjs\` to measure yours. `) +
        `Combining the same work into fewer, larger agents measured 63% cheaper at identical accuracy. ` +
        `Put several tasks in each agent's prompt: a prompt of at least ${enough} characters goes through.` +
        (ESCAPE_ON ? ` If these tasks genuinely need separate contexts, write [separate context] in the prompt and it goes through.` : ''),
    },
    suppressOutput: true,
  })
}
