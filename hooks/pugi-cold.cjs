#!/usr/bin/env node
/**
 * pugi-cold — a UserPromptSubmit hook for Claude Code.
 *
 * The conversation is cached for one TTL after the last request: an hour on a
 * subscription, five minutes on an API key or on usage credits. The first
 * prompt after a longer break finds the cache cold and rewrites the whole
 * conversation at the cache-write rate — 2× the input price, against 0.1×
 * (0.025× on Fable 5.1) for reading it warm. A 265k context costs 530k there,
 * about twenty turns of re-reading, for a prompt that may be "commit".
 *
 * This hook reads the transcript, and when the last request is older than the
 * TTL it blocks the prompt once and says what continuing costs, what /compact
 * costs instead, and that /clear is free. Sent again, the same prompt passes.
 * A compaction after the last request passes too: the cache is rebuilt anyway.
 *
 * Environment:
 *   PUGI_COLD_MINUTES        default: 60, or 5 when promptCacheTtl / CLAUDE_CODE_PROMPT_CACHE_TTL is "5m"
 *   PUGI_OFF, PUGI_COLD_OFF  "1" turns it off and keeps the log
 *   PUGI_LOG                 "0" disables the decision log
 *
 * Every decision goes to ~/.claude/pugi/log.jsonl. On any error the prompt
 * goes through untouched.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const HOME = os.homedir()
const DIR = path.join(HOME, '.claude', 'pugi')
const LOG = path.join(DIR, 'log.jsonl')
const STATE = path.join(os.tmpdir(), 'pugi-state')
const OFF_SWITCH = path.join(DIR, 'OFF')
const LOGGING = process.env.PUGI_LOG !== '0'
const TAIL = 512 * 1024

const readWeight = (model) => (/fable-5-1|mythos-5-1/.test(model || '') ? 0.025 : 0.1)
const k = (t) => (t ? Math.round(t / 1000) + 'k' : '0')

/** The cache TTL in minutes: what the settings ask for, else the hour a subscription gets. */
function ttlMinutes() {
  if (process.env.PUGI_COLD_MINUTES !== undefined && process.env.PUGI_COLD_MINUTES !== '') {
    const n = Number(process.env.PUGI_COLD_MINUTES)
    if (Number.isFinite(n) && n >= 0) return n
  }
  if (process.env.FORCE_PROMPT_CACHING_5M === '1') return 5
  let ttl = process.env.CLAUDE_CODE_PROMPT_CACHE_TTL
  if (!ttl) {
    try {
      ttl = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8')).promptCacheTtl
    } catch {}
  }
  return ttl === '5m' ? 5 : 60
}

/** The last request of the transcript — its end, its context, its model — and whether a compaction came after it. */
function lastRequest(file) {
  let text
  try {
    const size = fs.statSync(file).size
    const fd = fs.openSync(file, 'r')
    try {
      const start = Math.max(0, size - TAIL)
      const buf = Buffer.alloc(size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      text = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
    if (!/"usage"/.test(text) && size > TAIL) text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let m
    try {
      m = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (m.isSidechain) continue
    if (m.type === 'system' && m.subtype === 'compact_boundary') return { compacted: true, at: m.timestamp }
    const u = m.type === 'assistant' && m.message && m.message.usage
    if (!u) continue
    const at = Date.parse(m.timestamp || '')
    if (!at) continue
    return { at: m.timestamp, end: at, ctx: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), model: m.message.model }
  }
  return null
}

/** The context of the session's first request: the fixed part every request carries, what /clear restarts at. */
function firstRequest(file) {
  try {
    const fd = fs.openSync(file, 'r')
    let text
    try {
      const buf = Buffer.alloc(TAIL)
      const n = fs.readSync(fd, buf, 0, TAIL, 0)
      text = buf.toString('utf8', 0, n)
    } finally {
      fs.closeSync(fd)
    }
    for (const line of text.split('\n')) {
      let m
      try {
        m = JSON.parse(line)
      } catch {
        continue
      }
      const u = !m.isSidechain && m.type === 'assistant' && m.message && m.message.usage
      if (u) return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
    }
  } catch {}
  return null
}

const PUT_BACK = 35e3 // what Claude Code puts back after a compaction: the summary, up to five files, the skills invoked
const SUMMARY = 10e3 * 5 // the summary as output, at 5×
const NO_COLOR = process.env.NO_COLOR !== undefined || process.env.PUGI_COLOR === '0'
const paint = (code, s) => (NO_COLOR ? s : `\x1b[${code}m${s}\x1b[0m`)
const red = (s) => paint(31, s)
const green = (s) => paint(32, s)
const yellow = (s) => paint(33, s)
const dim = (s) => paint(2, s)
const pct = (x, of) => {
  if (!of) return ''
  const d = Math.round((100 * (x - of)) / of)
  return (d <= 0 ? '−' : '+') + Math.abs(d) + '%'
}

/** What each choice costs now and on every later turn, in input-token equivalents, against continuing as it is: a table. */
function choices(ctx, fixed, rw) {
  const restart = fixed + PUT_BACK
  const rows = [
    ['continue', 2 * ctx, ctx * rw, 'nothing', red, green],
    ['/compact first', ctx + SUMMARY, restart * rw, 'detail: a summary replaces the history', green, yellow],
    ['/clear', 0, fixed * rw, 'the history', green, red],
  ]
  const [, now0, later0] = rows[0]
  // The header reads as a sentence with each row: "if you continue, you pay now 530k, then 27k on every request, and you lose nothing".
  const widths = [14, 34, 24, 38]
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length))
  const amount = (x, of, colour, w, note) => {
    if (of === x) return colour(pad(k(x) + ' tokens' + (note ? '  ' + note : ''), w))
    const n = pad(k(x) + (x ? ' tokens' : ''), 12)
    return n + colour(pad('(' + pct(x, of) + ')', w - 12))
  }
  const rule = (l, m, r) => '  ' + l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r
  const row = (cells) => '  │ ' + cells.join(' │ ') + ' │'
  return [
    rule('┌', '┬', '┐'),
    row([pad('if you…', widths[0]), pad('you pay now', widths[1]), pad('then, on every request', widths[2]), pad('and you lose', widths[3])]),
    rule('├', '┼', '┤'),
    ...rows.map(([name, now, later, lose, cNum, cLose], i) =>
      row([pad(name, widths[0]), amount(now, now0, i ? green : red, widths[1], i ? '' : '(the whole history)'), amount(later, later0, i ? green : red, widths[2]), cLose(pad(lose, widths[3]))])
    ),
    rule('└', '┴', '┘'),
  ].join('\n')
}

/** The blocked prompt goes to Claude Code's prompt history, so ↑ brings it back; not twice in a row. */
function remember(prompt, session, cwd) {
  try {
    const file = path.join(HOME, '.claude', 'history.jsonl')
    let last = null
    try {
      const size = fs.statSync(file).size
      const fd = fs.openSync(file, 'r')
      try {
        const start = Math.max(0, size - 8192)
        const buf = Buffer.alloc(size - start)
        fs.readSync(fd, buf, 0, buf.length, start)
        const lines = buf.toString('utf8').trim().split('\n')
        last = JSON.parse(lines[lines.length - 1])
      } finally {
        fs.closeSync(fd)
      }
    } catch {}
    if (last && last.display === prompt) return false
    fs.appendFileSync(file, JSON.stringify({ display: prompt, pastedContents: {}, timestamp: Date.now(), project: cwd || process.cwd(), sessionId: session }) + '\n')
    return true
  } catch {
    return false
  }
}

const note = (row) => {
  if (!LOGGING) return
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.appendFileSync(LOG, JSON.stringify(row) + '\n')
  } catch {}
}

function run(ev) {
  const prompt = ev.prompt
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.trimStart().startsWith('/')) return null
  if (typeof ev.transcript_path !== 'string') return null
  const session = ev.session_id || 'unknown'
  const base = { ts: new Date().toISOString(), session, hook: 'cold' }

  const last = lastRequest(ev.transcript_path)
  if (!last) {
    note({ ...base, decision: 'none' })
    return null
  }
  if (last.compacted) {
    note({ ...base, decision: 'compacted' })
    return null
  }
  const ttl = ttlMinutes()
  const idleExact = (Date.now() - last.end) / 60000
  const idle = Math.round(idleExact)
  const row = { idle, ttl, ctx: last.ctx, model: last.model }
  if (process.env.PUGI_OFF === '1' || process.env.PUGI_COLD_OFF === '1' || fs.existsSync(OFF_SWITCH)) {
    note({ ...base, decision: 'off', ...row })
    return null
  }
  if (idleExact <= ttl) {
    note({ ...base, decision: 'warm', ...row })
    return null
  }

  // Blocked once per cold request: the same prompt sent again passes. The state file is this hook's own:
  // the effort hook runs on the same prompt at the same instant and writes its own, so sharing one would lose writes.
  let state = {}
  const stateFile = path.join(STATE, session + '.cold.json')
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {}
  const insisted = state.cold === last.at
  state.cold = insisted ? null : last.at
  try {
    fs.mkdirSync(STATE, { recursive: true })
    fs.writeFileSync(stateFile, JSON.stringify(state))
  } catch {}
  if (insisted) {
    note({ ...base, decision: 'insisted', ...row })
    return null
  }
  const remembered = remember(prompt, session, ev.cwd)
  note({ ...base, decision: 'blocked', ...row, remembered })

  const hours = idle >= 120 ? Math.floor(idle / 60) + 'h ' + (idle % 60) + 'm' : idle + ' min'
  const kept = ttl >= 60 ? (ttl === 60 ? 'an hour' : ttl / 60 + ' hours') : ttl + ' minutes'
  const fixed = Math.min(last.ctx, firstRequest(ev.transcript_path) || 55e3)
  return {
    decision: 'block',
    reason:
      `pugi: you were away ${hours}; the cache keeps the conversation for ${kept}. Your prompt is on hold.\n` +
      `What each choice costs, in input tokens:\n\n` +
      choices(last.ctx, fixed, readWeight(last.model)) +
      '\n' +
      dim('  ↑ brings your prompt back; Enter sends it and continues as it is.'),
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
      /* on any error the prompt goes through untouched */
    }
    if (out) process.stdout.write(JSON.stringify(out))
    process.exit(0)
  })
}

module.exports = { lastRequest, ttlMinutes }
