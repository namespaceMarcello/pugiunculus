#!/usr/bin/env node
/**
 * pugi-bash — closes the back door.
 *
 * The read hook stops `Read(file)`. It does nothing about `cat file`, which
 * dumps the same tokens into the same context through the shell. In the logs
 * this was built from, `cat` alone was 693 calls and 1.5M tokens, and `sed -n`
 * over wide ranges another 1.6M — Bash out-consumed Read overall.
 *
 * Blocks, once, a shell command whose whole point is to print a large file:
 *   cat BIG            type BIG (cmd)       Get-Content BIG (PowerShell)
 *   nl / tac / more / less / bat BIG
 *   head -n 5000 BIG   head -5000 BIG       head -c 100000 BIG
 *   tail -n +1 BIG     sed -n '1,4000p' BIG sed -n '1,$p' BIG
 * Chains are checked one command at a time: `cd src && cat BIG` is still `cat BIG`.
 *
 * Deliberately conservative — anything that could already be small is allowed:
 *   - a pipe or a redirect of stdout (`cat x | grep y`, `cat x > y`): output
 *     is filtered or diverted, so it never lands in the context
 *   - small ranges (`sed -n '100,140p'`, `head -n 40`, `Get-Content x -Tail 40`)
 *     — that is the behaviour we want
 *   - files under the threshold, missing files, anything unparseable
 *
 * It is a list of the shapes that showed up in real logs, not a fence. `awk`,
 * `grep '' FILE` and `python -c` are not on it, on purpose: an agent that
 * reaches for those after a refusal has decided it needs the file.
 *
 * Config:
 *   PUGI_THRESHOLD_BYTES    default 8000  — same knob as the read hook
 *   PUGI_BASH_LINES         default 500   — ranges wider than this count as "whole file"
 *   PUGI_OFF=1, or ~/.claude/pugi/OFF — disable, keep logging
 *   PUGI_BASH_OFF=1         — disable only this hook
 *   PUGI_LOG=0              — no decision log
 *
 * NOTE: if you run a tool that compresses shell output (rtk, headroom, ...),
 * your `cat` may already be cheap. Measure before installing this one.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const THRESHOLD = Number(process.env.PUGI_THRESHOLD_BYTES) || 8000
const MAX_LINES = Number(process.env.PUGI_BASH_LINES) || 500

const HOME = os.homedir()
const DIR = path.join(HOME, '.claude', 'pugi')
const LOG = path.join(DIR, 'log.jsonl')
const OFF_SWITCH = path.join(DIR, 'OFF')
const STATE = path.join(os.tmpdir(), 'pugi-state')

function exit(payload) {
  if (payload) process.stdout.write(JSON.stringify(payload))
  process.exit(0)
}

function note(row) {
  if (process.env.PUGI_LOG === '0') return
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

/** Verbs that print a file whole, in whichever shell lands here. */
const PRINTERS = new Set(['cat', 'type', 'get-content', 'gc', 'nl', 'tac', 'more', 'less', 'bat'])

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

/** The first named file at or over the threshold, or null. */
function bigFile(args, cwd) {
  for (const a of args) {
    const bytes = sizeOf(a, cwd)
    if (bytes >= THRESHOLD) return { file: unquote(a), bytes }
  }
  return null
}

/**
 * The line count a command limits itself to: `-n 40`, `-n40`, `-40`,
 * `--lines=40`, `-TotalCount 40`, `-Head 40`, `-Tail 40`. A leading `+`
 * (`tail -n +1`) means "from here to the end" and comes back as written.
 */
function lineLimit(segment) {
  const m = (' ' + segment).match(/(?:\s-n\s*|\s--lines[= ]|\s-(?:TotalCount|Head|Tail)\s+|\s-)(\+?\d+)\b/i)
  return m ? m[1] : null
}

/**
 * Decide whether one command (no chains) exists to print a large file.
 * Returns {file, bytes, why} or null.
 */
function offenderIn(segment, cwd) {
  // A pipe, or a redirect of stdout, means the output is filtered or diverted.
  // `2>` only diverts stderr: the file still lands in the context.
  if (/\|/.test(segment) || /(?:^|[^2])>/.test(segment)) return null

  const parts = segment.trim().split(/\s+/)
  const args = parts.slice(1)
  const verb = path.basename(parts[0] || '').toLowerCase().replace(/\.exe$/, '')
  const limit = lineLimit(segment)
  const slice = limit !== null && !limit.startsWith('+') && Number(limit) <= MAX_LINES

  // cat / type / Get-Content FILE — a small -TotalCount or -Tail is a slice
  if (PRINTERS.has(verb)) {
    if (slice) return null
    const hit = bigFile(args, cwd)
    return hit && { ...hit, why: verb }
  }

  // head / tail: the default is 10 lines, a small -n is what we want, `-c` under
  // the threshold is fine, and `tail -n +1` is the whole file from line one
  if (verb === 'head' || verb === 'tail') {
    const bytes = (segment.match(/\s-c\s*(\d+)/) || [])[1]
    if (bytes !== undefined) {
      if (Number(bytes) < THRESHOLD) return null
    } else if (limit === null || slice) return null
    const hit = bigFile(args, cwd)
    return hit && { ...hit, why: verb + (bytes !== undefined ? ' -c ' + bytes : ' -n ' + limit) }
  }

  // sed -n 'A,Bp' FILE — a wide range, or `A,$p`, is a whole-file read in costume
  if (verb === 'sed') {
    const m = segment.match(/(\d+)\s*,\s*(\d+|\$)\s*p/)
    if (!m) return null
    const toEnd = m[2] === '$'
    const span = toEnd ? Infinity : Number(m[2]) - Number(m[1])
    if (span <= MAX_LINES) return null
    const hit = bigFile(args, cwd)
    return hit && { ...hit, why: toEnd ? 'sed range to the end of the file' : 'sed range of ' + span + ' lines' }
  }

  return null
}

/** Chains are checked one command at a time: `cd src && cat BIG` is still `cat BIG`. */
function offender(command, cwd) {
  for (const segment of command.split(/&&|\|\||;|\r?\n/)) {
    const hit = offenderIn(segment, cwd)
    if (hit) return hit
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

  if (process.env.PUGI_OFF === '1' || process.env.PUGI_BASH_OFF === '1' || fs.existsSync(OFF_SWITCH)) {
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
        `Whole-file shell read blocked: \`${hit.why}\` on ${hit.file} is up to ~${tokens} tokens. ` +
        `That is the same cost as reading the file whole — the shell is just the back door. ` +
        `Pipe it through grep, narrow the range, or use Read with offset/limit. ` +
        `If you genuinely need the whole file, repeat this command and it will go through.`,
    },
    suppressOutput: true,
  })
}
