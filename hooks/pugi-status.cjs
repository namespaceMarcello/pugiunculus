#!/usr/bin/env node
/**
 * pugi-status — the status line: what Pugiunculus did in this session, in a sentence.
 *
 *   node install.cjs --status      into settings.statusLine; the status line you had keeps running, its rows first, ours after
 *   node install.cjs --no-status   yours back as it was
 *
 * Claude Code runs the status line command on every event with the session's
 * JSON on stdin and shows what it prints, one row per line. Ours reads
 * ~/.claude/pugi/log.jsonl for this session — reads stopped and what they
 * weighed, insists, shell and fan-out blocks, the effort levels suggested — and
 * this session's subagent transcripts, for what a lean reader kept out of the
 * chat against the 48k a general-purpose agent pays to start. It speaks the
 * language of the word pack installed (Italian, or English). Never slower than
 * a glance: the log is read from its tail, an agent from its first bytes. On
 * any error it prints nothing of its own; the previous status line still runs.
 *
 * hooks/pugi-recap.cjs shares the counting and the sentences.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const DIR = path.join(os.homedir(), '.claude', 'pugi')
const LOG = path.join(DIR, 'log.jsonl')
const PREVIOUS = path.join(DIR, 'status-previous.json')
const WORDS = path.join(DIR, 'effort-words.json')
const TAIL = 512 * 1024 // bytes of log read, from the end
const HEAD = 64 * 1024 // bytes of an agent transcript read, from the start
const FULL_AGENT = 48000 // what a general-purpose agent paid to start, measured
const LEAN = 15000

/** The last `TAIL` bytes of a file, from its first whole line. */
function tail(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - TAIL)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    const text = buf.toString('utf8')
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } catch {
    return ''
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd)
      } catch {}
  }
}

/** The first `HEAD` bytes of a file. */
function head(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(HEAD)
    const n = fs.readSync(fd, buf, 0, HEAD, 0)
    return buf.toString('utf8', 0, n)
  } catch {
    return ''
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd)
      } catch {}
  }
}

/** "it" when the Italian word pack is installed, "en" otherwise. */
function language() {
  try {
    return JSON.parse(fs.readFileSync(WORDS, 'utf8'))._lang === 'it' ? 'it' : 'en'
  } catch {
    return 'en'
  }
}

/**
 * What the pugi log says: for one session, or, with `all`, for every session.
 * `since` is an ISO timestamp; rows at or before it are skipped. No session
 * and no `all` counts nothing: a broken input must not show someone else's day.
 */
function fromLog({ session = null, since = null, all = false } = {}) {
  const c = { reads: 0, atStake: 0, insisted: 0, shell: 0, fanout: 0, effort: {}, last: null }
  if (!session && !all) return c
  for (const l of tail(LOG).split('\n')) {
    if (session && !l.includes(session)) continue
    let r
    try {
      r = JSON.parse(l)
    } catch {
      continue
    }
    if (session && r.session !== session) continue
    if (since && !(r.ts > since)) continue
    if (r.ts && (!c.last || r.ts > c.last)) c.last = r.ts
    const kind = r.hook || r.tool || (r.file ? 'read' : '')
    if (kind === 'effort') {
      if (r.decision === 'suggest') c.effort[r.level] = (c.effort[r.level] || 0) + 1
    } else if (kind === 'read' || r.file) {
      if (r.decision === 'blocked') {
        c.reads++
        c.atStake += Math.ceil((r.bytes || 0) / 4)
      } else if (r.decision === 'insisted') c.insisted++
    } else if (kind === 'shell') {
      if (r.decision === 'blocked') c.shell++
    } else if (kind === 'Agent') {
      if (r.decision === 'blocked') c.fanout++
    }
  }
  return c
}

/** This session's subagents: how many started lean, and what they spared against a full start. */
function fromAgents(transcriptPath, session) {
  const out = { agents: 0, lean: 0, spared: 0 }
  if (!transcriptPath || !session) return out
  const dir = path.join(path.dirname(transcriptPath), session, 'subagents')
  let files
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
  } catch {
    return out
  }
  for (const f of files.slice(0, 200)) {
    const m = /"usage":\{"input_tokens":(\d+),"cache_creation_input_tokens":(\d+),"cache_read_input_tokens":(\d+)/.exec(head(path.join(dir, f)))
    if (!m) continue
    out.agents++
    const first = Number(m[1]) + Number(m[2]) + Number(m[3])
    if (first < LEAN) {
      out.lean++
      out.spared += Math.max(0, FULL_AGENT - first)
    }
  }
  return out
}

const k = (t) => (t >= 1000 ? Math.round(t / 1000) + 'k' : String(Math.round(t)))
const LEVELS = ['low', 'medium', 'xhigh', 'max']

/** The parts of a sentence, in the language asked; empty when nothing happened. */
function parts(c, a, lang) {
  const it = lang === 'it'
  const out = []
  if (c.reads) out.push(it ? `${c.reads} lettur${c.reads === 1 ? 'a intera fermata' : 'e intere fermate'} (~${k(c.atStake)} token)` : `${c.reads} whole-file read${c.reads === 1 ? '' : 's'} stopped (~${k(c.atStake)} tokens)`)
  if (c.insisted) out.push(it ? `${c.insisted} insistit${c.insisted === 1 ? 'a' : 'e'}` : `${c.insisted} insisted`)
  if (c.shell) out.push(it ? `${c.shell} comand${c.shell === 1 ? 'o fermato' : 'i fermati'}` : `${c.shell} shell command${c.shell === 1 ? '' : 's'} stopped`)
  if (c.fanout) out.push(it ? `${c.fanout} sfilz${c.fanout === 1 ? 'a' : 'e'} di agenti fermat${c.fanout === 1 ? 'a' : 'e'}` : `${c.fanout} fan-out${c.fanout === 1 ? '' : 's'} stopped`)
  const levels = LEVELS.filter((l) => c.effort[l]).map((l) => (it ? `${c.effort[l]} volt${c.effort[l] === 1 ? 'a' : 'e'} ${l}` : `${c.effort[l]}× ${l}`))
  if (levels.length) out.push((it ? 'effort: ' : 'effort: ') + levels.join(', '))
  if (a && a.lean) out.push(it ? `${a.lean} lettur${a.lean === 1 ? 'a delegata' : 'e delegate'} all'agente leggero (≈${k(a.spared)} token fuori dalla chat)` : `${a.lean} read${a.lean === 1 ? '' : 's'} handed to the lean agent (≈${k(a.spared)} tokens kept out of the chat)`)
  return out
}

function statusLine(c, a, lang) {
  const p = parts(c, a, lang)
  return 'pugi │ ' + (p.length ? p.join(' · ') : lang === 'it' ? 'ancora niente da fermare' : 'nothing to stop yet')
}

/** The status line that was there before ours, run with the same input. */
function previous(input) {
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(PREVIOUS, 'utf8'))
  } catch {
    return null
  }
  if (!cfg || typeof cfg.command !== 'string' || !cfg.command.trim()) return null
  const r = spawnSync(cfg.command, { input, shell: true, encoding: 'utf8', timeout: 1500, windowsHide: true })
  return r.stdout ? r.stdout.replace(/\s+$/, '').split(/\r?\n/) : null
}

module.exports = { fromLog, fromAgents, parts, statusLine, language, k }

if (require.main === module) {
  let raw = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => (raw += d))
  process.stdin.on('end', () => {
    let ev = {}
    try {
      ev = JSON.parse(raw)
    } catch {}
    const rows = []
    try {
      rows.push(...(previous(raw) || []))
    } catch {}
    try {
      rows.push(statusLine(fromLog({ session: ev.session_id }), fromAgents(ev.transcript_path, ev.session_id), language()))
    } catch {}
    process.stdout.write(rows.filter(Boolean).join('\n'))
  })
}
