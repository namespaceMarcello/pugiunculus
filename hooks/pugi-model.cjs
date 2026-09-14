#!/usr/bin/env node
/**
 * pugi-model — a Claude Code PreToolUse hook for Agent / Task: name the model.
 *
 * A subagent launched without a model inherits the session's, and the session
 * runs on the dearest one. On the logs this was built from, 30 days: 290
 * launches, 61 without a model — all of them on Opus, $517 at list price,
 * against ~$207 on Sonnet. The rule was written (Haiku for mechanical work,
 * Sonnet for a closed brief, Opus for design) and skipped one time in five.
 *
 * This hook refuses a launch without a model once, with the three choices,
 * and lets the orchestrator choose. The same launch again — same brief, same
 * type — goes through with or without a model, and the log says which:
 *   given     a model was named from the start
 *   blocked   no model: refused, the choices shown
 *   chosen    relaunched with a model — which one is the number
 *   insisted  relaunched still without one: through
 *   defined   a custom agent whose definition names its model
 *   off       PUGI_OFF, PUGI_MODEL_OFF or ~/.claude/pugi/OFF
 * It never writes a model into the call. On any error the call goes through.
 *
 * STATE: one append-only file per session, since a wave of launches runs its
 * hooks at the same instant and a read-modify-write of one file loses writes.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const HOME = os.homedir()
const DIR = path.join(HOME, '.claude', 'pugi')
const LOG = path.join(DIR, 'log.jsonl')
const STATE = path.join(os.tmpdir(), 'pugi-state')
const OFF_SWITCH = path.join(DIR, 'OFF')
const LOGGING = process.env.PUGI_LOG !== '0'
const SPAWN_TOOLS = new Set(['Agent', 'Task'])

const note = (row) => {
  if (!LOGGING) return
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.appendFileSync(LOG, JSON.stringify(row) + '\n')
  } catch {}
}

/** The model of the session's last request, from the tail of its transcript; null when unknown. */
function sessionModel(file) {
  try {
    const size = fs.statSync(file).size
    const fd = fs.openSync(file, 'r')
    let text
    try {
      const start = Math.max(0, size - 256 * 1024)
      const buf = Buffer.alloc(size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      text = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      let m
      try {
        m = JSON.parse(lines[i])
      } catch {
        continue
      }
      if (!m.isSidechain && m.type === 'assistant' && m.message && m.message.model && m.message.model !== '<synthetic>') return m.message.model
    }
  } catch {}
  return null
}

/** A custom agent's definition names its model: ~/.claude/agents/<type>.md or <cwd>/.claude/agents/<type>.md. */
function definedModel(type, cwd) {
  if (!type || !/^[\w-]+$/.test(type)) return null
  for (const dir of [cwd && path.join(cwd, '.claude', 'agents'), path.join(HOME, '.claude', 'agents')]) {
    if (!dir) continue
    try {
      const head = fs.readFileSync(path.join(dir, type + '.md'), 'utf8').slice(0, 4096)
      const fm = /^---\n([\s\S]*?)\n---/.exec(head)
      const m = fm && /^model:\s*(\S+)/m.exec(fm[1])
      if (m) return m[1]
    } catch {}
  }
  return null
}

function run(ev) {
  if (!SPAWN_TOOLS.has(ev.tool_name)) return null
  const input = ev.tool_input || {}
  const prompt = String(input.prompt || '')
  const type = String(input.subagent_type || '')
  const session = ev.session_id || 'unknown'
  const base = { ts: new Date().toISOString(), session, hook: 'model', tool: ev.tool_name, type: type || null }
  const key = crypto.createHash('sha1').update(type + '\n' + prompt).digest('hex').slice(0, 16)

  // Launches refused so far in this session, by fingerprint.
  const stateFile = path.join(STATE, 'model-' + session + '.jsonl')
  const refused = new Set()
  try {
    for (const line of fs.readFileSync(stateFile, 'utf8').split('\n')) if (line) refused.add(line.trim())
  } catch {}
  const again = refused.has(key)

  if (input.model) {
    note({ ...base, decision: again ? 'chosen' : 'given', model: String(input.model) })
    return null
  }
  if (type.includes(':')) {
    // A plugin's agent: its definition is not on disk where this hook looks; left alone.
    note({ ...base, decision: 'plugin' })
    return null
  }
  const defined = definedModel(type, ev.cwd)
  if (defined) {
    note({ ...base, decision: 'defined', model: defined })
    return null
  }
  if (process.env.PUGI_OFF === '1' || process.env.PUGI_MODEL_OFF === '1' || fs.existsSync(OFF_SWITCH)) {
    note({ ...base, decision: 'off' })
    return null
  }
  if (again) {
    note({ ...base, decision: 'insisted' })
    return null
  }
  try {
    fs.mkdirSync(STATE, { recursive: true })
    fs.appendFileSync(stateFile, key + '\n')
  } catch {}
  const inherited = typeof ev.transcript_path === 'string' ? sessionModel(ev.transcript_path) : null
  note({ ...base, decision: 'blocked', inherited })
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `No model given: this subagent would inherit the session's model` +
        (inherited ? ` (${inherited})` : '') +
        `, the dearest one. Relaunch it with one:\n` +
        `  haiku   mechanical, checkable work\n` +
        `  sonnet  a closed brief\n` +
        `  opus    design, obscure debugging, an invariant\n` +
        `Never fable. The same launch again, still without a model, goes through.`,
    },
    suppressOutput: true,
  }
}

if (require.main === module) {
  let raw = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => (raw += d))
  process.stdin.on('end', () => {
    let out = null
    try {
      out = run(JSON.parse(raw))
    } catch {
      /* on any error the call goes through untouched */
    }
    if (out) process.stdout.write(JSON.stringify(out))
    process.exit(0)
  })
}

module.exports = { definedModel, sessionModel }
