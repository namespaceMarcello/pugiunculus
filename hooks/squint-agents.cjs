#!/usr/bin/env node
/**
 * squint-agents — a Claude Code PreToolUse hook for subagent fan-out.
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
 * WHERE IT BLOCKS, AND WHY THERE:
 * Not mid-batch. If you spawn ten agents in one turn, refusing the last seven
 * leaves you with a shredded fan-out and three orphans. Instead this waits for
 * the batch to finish, then blocks the FIRST spawn of the next one — the only
 * moment where stopping costs nothing and the evidence is already in hand
 * ("last batch: 10 agents, median prompt 480 chars").
 *
 * Consequence, stated plainly: the first fan-out of a session is never blocked.
 * There is nothing to learn from yet.
 *
 * Config (all optional):
 *   SQUINT_FANOUT_MIN     default 4     — batch size that counts as wasteful
 *   SQUINT_FANOUT_CHARS   default 1500  — median prompt below this = "small"
 *   SQUINT_FANOUT_GAP     default 60    — seconds of quiet that ends a batch
 *   SQUINT_OFF=1, or a file at ~/.claude/squint/OFF   — disable, keep logging
 *   SQUINT_LOG=0          — no decision log
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const MIN_BATCH = Number(process.env.SQUINT_FANOUT_MIN) || 4
const SMALL_CHARS = Number(process.env.SQUINT_FANOUT_CHARS) || 1500
const GAP_SECONDS = Number(process.env.SQUINT_FANOUT_GAP) || 60

const HOME = os.homedir()
const DIR = path.join(HOME, '.claude', 'squint')
const LOG = path.join(DIR, 'log.jsonl')
const OFF_SWITCH = path.join(DIR, 'OFF')
const STATE = path.join(os.tmpdir(), 'squint-state')

const SPAWN_TOOLS = new Set(['Task', 'Agent'])

function exit(payload) {
  if (payload) process.stdout.write(JSON.stringify(payload))
  process.exit(0)
}

function note(row) {
  if (process.env.SQUINT_LOG === '0') return
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
  const promptLength = String(ev.tool_input?.prompt || '').length
  const base = { ts: new Date().toISOString(), session: ev.session_id || null, tool: ev.tool_name }

  fs.mkdirSync(STATE, { recursive: true })
  const stateFile = path.join(STATE, 'fanout-' + (ev.session_id || 'unknown') + '.json')
  let state = { spawns: [], blockedFor: null }
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {
    /* first spawn of the session */
  }
  state.spawns = state.spawns || []

  const last = state.spawns[state.spawns.length - 1]
  const startsNewBatch = !last || (now - last.at) / 1000 > GAP_SECONDS

  // Walk back over the previous batch: contiguous spawns with small gaps.
  let previous = []
  if (startsNewBatch && state.spawns.length) {
    previous = [state.spawns[state.spawns.length - 1]]
    for (let i = state.spawns.length - 2; i >= 0; i--) {
      if ((previous[0].at - state.spawns[i].at) / 1000 > GAP_SECONDS) break
      previous.unshift(state.spawns[i])
    }
  }

  const previousWasWasteful =
    previous.length >= MIN_BATCH && median(previous.map((s) => s.len)) < SMALL_CHARS

  const save = (extra) => {
    state.spawns.push({ at: now, len: promptLength })
    if (state.spawns.length > 200) state.spawns = state.spawns.slice(-200)
    Object.assign(state, extra || {})
    try {
      fs.writeFileSync(stateFile, JSON.stringify(state))
    } catch {}
  }

  if (!startsNewBatch || !previousWasWasteful) {
    save()
    note({ ...base, decision: 'pass', batchSoFar: state.spawns.length, chars: promptLength })
    return
  }

  if (process.env.SQUINT_OFF === '1' || fs.existsSync(OFF_SWITCH)) {
    save()
    note({ ...base, decision: 'off', previousBatch: previous.length, chars: promptLength })
    return
  }

  // Insisted: the same batch-start was already refused once. Let it through.
  if (state.blockedFor === previous.length) {
    save({ blockedFor: null })
    note({ ...base, decision: 'insisted', previousBatch: previous.length })
    return
  }

  // The entry cost is the installing user's, not a constant. `node measure.cjs`
  // derives it from their own logs and leaves it here.
  let toll = null
  try {
    toll = JSON.parse(fs.readFileSync(path.join(DIR, 'toll.json'), 'utf8')).toll
  } catch {
    /* not measured yet — the message says so instead of inventing a number */
  }

  save({ blockedFor: previous.length })
  const n = previous.length
  const med = median(previous.map((s) => s.len))
  note({ ...base, decision: 'blocked', previousBatch: n, medianChars: med })

  exit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `Fan-out blocked once. Your last batch was ${n} subagents with a median prompt of ${med} characters. ` +
        (toll
          ? `On this machine the cheapest subagent you have ever run cost ${toll.toLocaleString('en-US')} tokens before doing any work, so that batch spent at least ${(n * toll).toLocaleString('en-US')} tokens on entry costs alone. `
          : `Every agent pays a fixed entry cost before doing any work — tens of thousands of tokens, depending on your plugins and MCP servers. Run \`node measure.cjs\` to measure yours. `) +
        `Combining the same work into fewer, larger agents measured 63% cheaper at identical accuracy. ` +
        `Put several tasks in each agent's prompt instead. If they genuinely need separate contexts, repeat this call and it will go through.`,
    },
    suppressOutput: true,
  })
}
