#!/usr/bin/env node
/**
 * squint-bash — closes the back door.
 *
 * The read hook stops `Read(file)`. It does nothing about `cat file`, which
 * dumps the same tokens into the same context through the shell. In the logs
 * this was built from, `cat` alone was 693 calls and 1.5M tokens, and `sed -n`
 * over wide ranges another 1.6M — Bash out-consumed Read overall.
 *
 * Blocks, once, a shell command whose whole point is to print a large file:
 *   cat BIG            type BIG (cmd)       Get-Content BIG (PowerShell)
 *   head -n 5000 BIG   sed -n '1,4000p' BIG
 *
 * Deliberately conservative — anything that could already be small is allowed:
 *   - a pipe or redirect (`cat x | grep y`, `cat x > y`): output is filtered
 *     or diverted, so it never lands in the context
 *   - small ranges (`sed -n '100,140p'`) — that is the behaviour we want
 *   - files under the threshold, missing files, anything unparseable
 *
 * Config:
 *   SQUINT_THRESHOLD_BYTES  default 8000  — same knob as the read hook
 *   SQUINT_BASH_LINES       default 500   — ranges wider than this count as "whole file"
 *   SQUINT_OFF=1, or ~/.claude/squint/OFF — disable, keep logging
 *   SQUINT_LOG=0            — no decision log
 *
 * NOTE: if you run a tool that compresses shell output (rtk, headroom, ...),
 * your `cat` may already be cheap. Measure before installing this one.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const THRESHOLD = Number(process.env.SQUINT_THRESHOLD_BYTES) || 8000
const MAX_LINES = Number(process.env.SQUINT_BASH_LINES) || 500

const HOME = os.homedir()
const DIR = path.join(HOME, '.claude', 'squint')
const LOG = path.join(DIR, 'log.jsonl')
const OFF_SWITCH = path.join(DIR, 'OFF')
const STATE = path.join(os.tmpdir(), 'squint-state')

function exit(payload) {
  if (payload) process.stdout.write(JSON.stringify(payload))
  process.exit(0)
}

function note(row) {
  if (process.env.SQUINT_LOG === '0') return
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.appendFileSync(LOG, JSON.stringify(row) + '\n')
  } catch {}
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (raw += d))
process.stdin.on('end', () => {
  try {
    run(JSON.parse(raw))
  } catch {
    /* on any error the command goes through untouched */
  }
  exit(null)
})

/** Strip quotes from one argument. */
const unquote = (s) => s.replace(/^['"]|['"]$/g, '')

/** Size of a file named in the command, or 0 if we cannot tell. */
function sizeOf(arg, cwd) {
  const name = unquote(arg)
  if (!name || name.startsWith('-')) return 0
  const candidates = [name, cwd ? path.resolve(cwd, name) : null].filter(Boolean)
  for (const c of candidates) {
    try {
      const st = fs.statSync(c)
      if (st.isFile()) return st.size
    } catch {}
  }
  return 0
}

/**
 * Decide whether a command exists to print a large file.
 * Returns {file, bytes, why} or null.
 */
function offender(command, cwd) {
  // A pipe or a redirect means the output is filtered or sent somewhere else.
  if (/[|>]/.test(command)) return null

  const parts = command.trim().split(/\s+/)
  const args = parts.slice(1)
  const verb = path.basename(parts[0] || '').toLowerCase()

  // cat / type / Get-Content FILE...
  if (['cat', 'type', 'get-content', 'gc'].includes(verb)) {
    for (const a of args) {
      const bytes = sizeOf(a, cwd)
      if (bytes >= THRESHOLD) return { file: unquote(a), bytes, why: verb }
    }
    return null
  }

  // head -n BIG FILE  (a small -n is exactly the behaviour we want)
  if (verb === 'head' || verb === 'tail') {
    const n = Number((command.match(/-n\s*(\d+)/) || [])[1] || 10)
    if (n <= MAX_LINES) return null
    for (const a of args) {
      const bytes = sizeOf(a, cwd)
      if (bytes >= THRESHOLD) return { file: unquote(a), bytes, why: verb + ' -n ' + n }
    }
    return null
  }

  // sed -n 'A,Bp' FILE — a wide range is a whole-file read wearing a costume
  if (verb === 'sed') {
    const m = command.match(/(\d+)\s*,\s*(\d+)\s*p/)
    if (!m) return null
    const span = Number(m[2]) - Number(m[1])
    if (span <= MAX_LINES) return null
    for (const a of args) {
      const bytes = sizeOf(a, cwd)
      if (bytes >= THRESHOLD) return { file: unquote(a), bytes, why: 'sed range of ' + span + ' lines' }
    }
  }

  return null
}

function run(ev) {
  if (ev.tool_name !== 'Bash' && ev.tool_name !== 'PowerShell') return
  const command = String(ev.tool_input?.command || '')
  if (!command) return

  const hit = offender(command, ev.cwd)
  if (!hit) return

  const base = {
    ts: new Date().toISOString(),
    session: ev.session_id || null,
    tool: 'shell',
    file: hit.file,
    bytes: hit.bytes,
  }

  if (process.env.SQUINT_OFF === '1' || fs.existsSync(OFF_SWITCH)) {
    note({ ...base, decision: 'off' })
    return
  }

  fs.mkdirSync(STATE, { recursive: true })
  const stateFile = path.join(STATE, 'bash-' + (ev.session_id || 'unknown') + '.json')
  let state = {}
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {}
  state.blocked = state.blocked || {}
  const key = hit.file.toLowerCase()

  if ((state.blocked[key] || 0) >= 1) {
    state.blocked[key] = 0
    try {
      fs.writeFileSync(stateFile, JSON.stringify(state))
    } catch {}
    note({ ...base, decision: 'insisted' })
    return
  }

  state.blocked[key] = 1
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state))
  } catch {}
  note({ ...base, decision: 'blocked', why: hit.why })

  const tokens = Math.ceil(hit.bytes / 4)
  exit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `Whole-file shell read blocked: \`${hit.why}\` on ${hit.file} is about ${tokens} tokens. ` +
        `That is the same cost as reading the file whole — the shell is just the back door. ` +
        `Pipe it through grep, narrow the range, or use Read with offset/limit. ` +
        `If you genuinely need the whole file, repeat this command and it will go through.`,
    },
    suppressOutput: true,
  })
}
