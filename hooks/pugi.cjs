#!/usr/bin/env node
/**
 * pugi — a Claude Code PreToolUse hook.
 *
 * Your agent opens a 21,000-token file to read ten lines. Then those 21,000
 * tokens sit in its context for the rest of the session, competing with
 * everything that matters.
 *
 * pugi stops the first whole-file Read of a large file and says what it costs.
 * If the agent really needs the whole file, it repeats the Read and gets it.
 *
 * Config (environment variables, all optional):
 *   PUGI_THRESHOLD_BYTES     default 8000  — below this, whole reads are fine
 *   PUGI_LOG                 default "1"   — "0" disables the decision log
 *   PUGI_OFF                 default unset — set to "1" to disable (for A/B tests)
 *   PUGI_READ_OFF            default unset — "1" disables only this hook
 *
 * A file at ~/.claude/pugi/OFF disables it too. Use that one when you want a
 * control group across subagents, which do not inherit your shell environment.
 *
 * The log lives at ~/.claude/pugi/log.jsonl and records every decision,
 * including when pugi is off. That is how you measure whether it helps.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const THRESHOLD = Number(process.env.PUGI_THRESHOLD_BYTES) || 8000
const LOGGING = process.env.PUGI_LOG !== '0'
const HOME = os.homedir()
const DIR = path.join(HOME, '.claude', 'pugi')
const LOG = path.join(DIR, 'log.jsonl')
const STATE = path.join(os.tmpdir(), 'pugi-state')
const OFF_SWITCH = path.join(DIR, 'OFF')

/** Files that cannot meaningfully be read in slices. */
const OPAQUE = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
  '.pdf', '.ipynb', '.zip', '.tar', '.gz', '.mp4', '.mp3', '.wav',
  '.woff', '.woff2', '.ttf', '.otf', '.exe', '.dll', '.so', '.dylib',
])

function exit(payload) {
  if (payload) process.stdout.write(JSON.stringify(payload))
  process.exit(0)
}

function note(row) {
  if (!LOGGING) return
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.appendFileSync(LOG, JSON.stringify(row) + '\n')
  } catch {
    /* logging must never break the hook */
  }
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (raw += d))
process.stdin.on('end', () => {
  try {
    run(JSON.parse(raw))
  } catch {
    /* on any error the Read goes through untouched */
  }
  exit(null)
})

function run(ev) {
  if (ev.tool_name !== 'Read') return
  const input = ev.tool_input || {}
  const file = input.file_path
  if (!file) return

  const key = path.resolve(file).split(path.sep).join('/').toLowerCase()
  const base = { ts: new Date().toISOString(), session: ev.session_id || null, file: key }

  // A slice was requested. That is the behaviour we want — record and allow.
  if (input.offset || input.limit) {
    note({ ...base, decision: 'slice', bytes: null })
    return
  }

  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return // missing file: let Read produce the real error
  }
  if (!stat.isFile()) return
  if (OPAQUE.has(path.extname(file).toLowerCase())) return

  if (stat.size < THRESHOLD) {
    note({ ...base, decision: 'small', bytes: stat.size })
    return
  }

  // Disabled: still record, so a control group can be measured.
  // Two ways to switch it off — the env var for a single run, the file for a
  // whole batch. The file matters because subagents do not inherit your shell:
  // it is the only way to run a real control group across spawned agents.
  if (process.env.PUGI_OFF === '1' || process.env.PUGI_READ_OFF === '1' || fs.existsSync(OFF_SWITCH)) {
    note({ ...base, decision: 'off', bytes: stat.size })
    return
  }

  fs.mkdirSync(STATE, { recursive: true })
  const stateFile = path.join(STATE, (ev.session_id || 'unknown') + '.json')
  let state = {}
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {
    state = {}
  }
  state.blocked = state.blocked || {}

  // Second attempt on the same file: the agent means it. Let it through.
  if ((state.blocked[key] || 0) >= 1) {
    state.blocked[key] = 0
    try {
      fs.writeFileSync(stateFile, JSON.stringify(state))
    } catch {}
    note({ ...base, decision: 'insisted', bytes: stat.size })
    return
  }

  state.blocked[key] = 1
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state))
  } catch {}
  note({ ...base, decision: 'blocked', bytes: stat.size })

  const tokens = Math.ceil(stat.size / 4)
  exit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `Whole-file Read blocked: up to ~${tokens} tokens for one file. ` +
        `Find the line with Grep first, then Read with offset/limit around it. ` +
        `If you genuinely need the entire file, repeat this exact Read and it will go through.` +
        (fs.existsSync(path.join(HOME, '.claude', 'agents', 'lettore.md'))
          ? ' For an exploration across several files, hand it to the lettore agent: it reads in its own context and returns only what you asked.'
          : ''),
    },
    suppressOutput: true,
  })
}
