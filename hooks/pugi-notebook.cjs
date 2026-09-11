#!/usr/bin/env node
/**
 * pugi-notebook — the session notebook. Kept by hooks, not by the model.
 *
 * Claude Code sends the whole conversation with every request, so the only way
 * to stop paying for an old conversation is to cut it: auto-compaction or
 * /clear. A cut loses whatever the summary forgets. The notebook is what
 * survives it: your requests word for word, the files Claude changed, and one
 * line of what it did in each turn that changed something. After a cut it goes
 * back into the context. Nothing else.
 *
 * One script, several events (registered by `node install.cjs --notebook`):
 *   UserPromptSubmit                    your prompt, verbatim
 *   PostToolUse Edit|Write|...          the file it changed
 *   PostToolUse git commit              one line: /clear now starts light
 *   Stop                                first line of the answer, if the turn changed files
 *   SessionEnd clear                    hands the notebook to the session /clear starts
 *   SessionStart compact|clear|resume   puts the notebook back in the context
 *
 * Files: ~/.claude/pugi/notebook/<session>.jsonl is the record, and
 * <project>-<id>.md next to it is the same notebook for you to read. Notebooks
 * untouched for 30 days are deleted when a new session starts.
 *
 * PUGI_OFF=1 or a file at ~/.claude/pugi/OFF turns it off, like the other hooks.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const DIR = path.join(os.homedir(), '.claude', 'pugi')
const BOOK = path.join(DIR, 'notebook')
const OFF_SWITCH = path.join(DIR, 'OFF')

const BUDGET = 9000 // characters; Claude Code caps what one hook can inject at 10,000
const REQUEST_MAX = 1500 // one pasted log must not push every other request out
const LINE_MAX = 160
const HANDOFF_MS = 120e3 // from the SessionEnd of a /clear to the SessionStart it hands to
const KEEP_MS = 30 * 864e5
const NUDGE = 'pugi: committed. /clear now starts light, and the notebook comes along.'

function exit(payload) {
  if (payload) process.stdout.write(JSON.stringify(payload))
  process.exit(0)
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (raw += d))
process.stdin.on('end', () => {
  let out = null
  try {
    if (process.env.PUGI_OFF !== '1' && !fs.existsSync(OFF_SWITCH)) out = run(JSON.parse(raw))
  } catch {
    /* the notebook must never break a session */
  }
  exit(out)
})

const idOf = (ev) => String(ev.session_id || '').replace(/[^\w-]/g, '')
const logOf = (id) => path.join(BOOK, id + '.jsonl')
const handoffOf = (cwd) =>
  path.join(BOOK, '.handoff-' + crypto.createHash('sha1').update(String(cwd || '').toLowerCase()).digest('hex').slice(0, 12))

function append(id, row) {
  fs.mkdirSync(BOOK, { recursive: true })
  fs.appendFileSync(logOf(id), JSON.stringify(row) + '\n')
}

/** The first event of a session names its notebook after the project. */
function open(id, ev) {
  if (fs.existsSync(logOf(id))) return
  const project = (path.basename(String(ev.cwd || '')) || 'session').replace(/[^\w.-]/g, '_')
  append(id, { t: 'meta', project, md: `${project}-${id.slice(-8)}.md`, at: Date.now() })
}

/** Fold the record into the notebook. `dirty`: files changed since the last line of what was done. */
function read(id) {
  let text
  try {
    text = fs.readFileSync(logOf(id), 'utf8')
  } catch {
    return null
  }
  const book = { project: 'session', md: null, requests: [], files: [], done: [], dirty: false }
  for (const line of text.split('\n')) {
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (r.t === 'meta' && !book.md) {
      book.project = r.project
      book.md = r.md
    } else if (r.t === 'ask') book.requests.push(r)
    else if (r.t === 'edit') {
      book.files = book.files.filter((f) => f !== r.file)
      book.files.push(r.file)
      book.dirty = true
    } else if (r.t === 'did') {
      book.done.push(r)
      book.dirty = false
    }
  }
  return book
}

const clock = (ms) => new Date(ms).toTimeString().slice(0, 5)

/** Newest requests first into the budget; files and what was done always fit. */
function render(book) {
  if (!book || (!book.requests.length && !book.files.length && !book.done.length)) return null
  const head = [
    `# Session notebook — ${book.project}`,
    'Kept by hooks, not by the model: the requests word for word, the files changed, one line of what each change did. Earlier requests still hold unless a later one says otherwise.',
  ]
  const tail = []
  if (book.files.length) tail.push('', '## Files changed', book.files.slice(-30).join(', '))
  if (book.done.length) tail.push('', '## Done', ...book.done.slice(-20).map((d) => `- [${clock(d.at)}] ${d.text}`))
  let room = BUDGET - head.join('\n').length - tail.join('\n').length - 120
  const kept = []
  let i = book.requests.length - 1
  for (; i >= 0; i--) {
    const r = book.requests[i]
    const line = `- [${clock(r.at)}] ${r.text.replace(/\n/g, '\n  ')}`
    if (line.length + 1 > room) break
    kept.unshift(line)
    room -= line.length + 1
  }
  const body = []
  if (book.requests.length) {
    body.push('', '## Requests, verbatim, oldest first')
    if (i >= 0) body.push(`- (${i + 1} earlier request${i ? 's' : ''} left out to fit)`)
    body.push(...kept)
  }
  return [...head, ...body, ...tail].join('\n')
}

function writeMd(id) {
  const book = read(id)
  const text = render(book)
  if (text && book.md) fs.writeFileSync(path.join(BOOK, book.md), text + '\n')
}

function short(file, cwd) {
  const rel = cwd ? path.relative(String(cwd), String(file)) : ''
  const p = !rel || rel.startsWith('..') || path.isAbsolute(rel) ? String(file) : rel
  return p.split('\\').join('/')
}

function firstLine(text) {
  for (const line of String(text || '').split('\n')) {
    const clean = line.replace(/\*\*|__|`/g, '').replace(/^\s*(#+|>|[-*•])\s*/, '').trim()
    if (clean) return clean.length > LINE_MAX ? clean.slice(0, LINE_MAX - 1) + '…' : clean
  }
  return null
}

/** /clear: the new session takes over the notebook the old one handed off in the same folder. */
function adopt(id, cwd) {
  const file = handoffOf(cwd)
  let h
  try {
    h = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return
  }
  try {
    fs.unlinkSync(file)
  } catch {}
  if (!h || h.id === id || Date.now() - h.at > HANDOFF_MS) return
  if (!fs.existsSync(logOf(h.id)) || fs.existsSync(logOf(id))) return
  fs.renameSync(logOf(h.id), logOf(id))
}

function sweep() {
  let names = []
  try {
    names = fs.readdirSync(BOOK)
  } catch {
    return
  }
  const now = Date.now()
  for (const n of names) {
    const f = path.join(BOOK, n)
    try {
      if (now - fs.statSync(f).mtimeMs > KEEP_MS) fs.unlinkSync(f)
    } catch {}
  }
}

function run(ev) {
  const id = idOf(ev)
  if (!id) return null
  switch (ev.hook_event_name) {
    case 'UserPromptSubmit': {
      let text = String(ev.prompt || '').trim()
      if (!text) return null
      if (text.length > REQUEST_MAX) text = text.slice(0, REQUEST_MAX) + ' […]'
      open(id, ev)
      append(id, { t: 'ask', at: Date.now(), text })
      writeMd(id)
      return null
    }
    case 'PostToolUse': {
      const input = ev.tool_input || {}
      if (ev.tool_name === 'Bash' || ev.tool_name === 'PowerShell')
        return /\bgit\s+commit\b/.test(String(input.command || '')) ? { systemMessage: NUDGE } : null
      const file = input.file_path || input.notebook_path
      if (!file) return null
      open(id, ev)
      append(id, { t: 'edit', at: Date.now(), file: short(file, ev.cwd) })
      return null
    }
    case 'Stop': {
      const book = read(id)
      if (!book || !book.dirty) return null
      const line = firstLine(ev.last_assistant_message)
      if (!line) return null
      append(id, { t: 'did', at: Date.now(), text: line })
      writeMd(id)
      return null
    }
    case 'SessionEnd':
      if (ev.reason === 'clear' && fs.existsSync(logOf(id))) fs.writeFileSync(handoffOf(ev.cwd), JSON.stringify({ id, at: Date.now() }))
      return null
    case 'SessionStart': {
      if (ev.source === 'clear') adopt(id, ev.cwd)
      else if (ev.source === 'startup') sweep()
      if (!['compact', 'clear', 'resume'].includes(ev.source)) return null
      const text = render(read(id))
      return text ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } } : null
    }
  }
  return null
}
