#!/usr/bin/env node
/**
 * pugi-recap — a sentence for you, not for the model, about what the hooks did.
 *
 * Installed with `node install.cjs --status`, on two events:
 *   Stop          after each answer: what happened in that turn, if anything
 *   SessionStart  at startup and resume: what happened in the last 24 hours, across sessions
 *
 * It returns only `systemMessage`, the hook field the terminal shows to the
 * user; no context is added to the conversation, so it costs the model
 * nothing. Speaks Italian when the Italian word pack is installed, English
 * otherwise. Silent when there is nothing to say. On any error, silent.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const status = require(path.join(__dirname, 'pugi-status.cjs'))

const STATE = path.join(os.tmpdir(), 'pugi-state')

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (raw += d))
process.stdin.on('end', () => {
  let out = null
  try {
    out = run(JSON.parse(raw))
  } catch {
    /* silent */
  }
  if (out) process.stdout.write(JSON.stringify(out))
  process.exit(0)
})

function run(ev) {
  const lang = status.language()
  const it = lang === 'it'
  if (ev.hook_event_name === 'Stop') {
    const session = ev.session_id
    if (!session) return null
    const file = path.join(STATE, session + '.recap.json')
    let state = {}
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {}
    const c = status.fromLog({ session, since: state.at || null })
    if (c.last) {
      state.at = c.last
      try {
        fs.mkdirSync(STATE, { recursive: true })
        fs.writeFileSync(file, JSON.stringify(state))
      } catch {}
    }
    const p = status.parts(c, null, lang)
    if (!p.length) return null
    return { systemMessage: (it ? 'Pugiunculus in questo turno: ' : 'Pugiunculus this turn: ') + p.join('; ') + '.' }
  }
  if (ev.hook_event_name === 'SessionStart') {
    const since = new Date(Date.now() - 24 * 3600e3).toISOString()
    const c = status.fromLog({ since, all: true })
    const p = status.parts(c, null, lang)
    if (!p.length) return null
    return { systemMessage: (it ? 'Pugiunculus nelle ultime 24 ore: ' : 'Pugiunculus in the last 24 hours: ') + p.join('; ') + '.' }
  }
  return null
}
