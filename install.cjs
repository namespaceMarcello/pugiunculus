#!/usr/bin/env node
/**
 * squint install / uninstall.
 *
 *   node install.cjs              add both hooks to ~/.claude/settings.json
 *   node install.cjs --uninstall  take them out again
 *
 * Your settings file is backed up next to itself before anything is written.
 * The install is idempotent: running it twice changes nothing the second time.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json')
const HOOKS = path.join(__dirname, 'hooks').replace(/\\/g, '/')
const UNINSTALL = process.argv.includes('--uninstall')

const ENTRIES = [
  {
    matcher: 'Read',
    file: 'squint.cjs',
    what: 'blocks whole-file reads of large files',
  },
  {
    matcher: 'Task|Agent',
    file: 'squint-agents.cjs',
    what: 'blocks the next fan-out after a wasteful batch of subagents',
  },
]

const isOurs = (entry) =>
  (entry.hooks || []).some((h) => /squint(-agents)?\.cjs/.test(String(h.command || '')))

let settings = {}
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))
} catch {
  /* no settings file yet — we will create one */
}

if (fs.existsSync(SETTINGS)) {
  const backup = SETTINGS + '.backup-squint'
  fs.copyFileSync(SETTINGS, backup)
  console.log('backed up   ' + backup)
}

settings.hooks = settings.hooks || {}
settings.hooks.PreToolUse = settings.hooks.PreToolUse || []

const before = settings.hooks.PreToolUse.length
settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((e) => !isOurs(e))
const removed = before - settings.hooks.PreToolUse.length

if (!UNINSTALL) {
  for (const e of ENTRIES) {
    settings.hooks.PreToolUse.push({
      matcher: e.matcher,
      hooks: [{ type: 'command', command: 'node "' + HOOKS + '/' + e.file + '"', timeout: 5 }],
    })
  }
}

fs.mkdirSync(path.dirname(SETTINGS), { recursive: true })
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n')
JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) // prove it is still valid JSON

if (UNINSTALL) {
  console.log(removed ? 'removed     ' + removed + ' squint hook(s)' : 'nothing to remove — squint was not installed')
} else {
  for (const e of ENTRIES) console.log('installed   ' + e.matcher.padEnd(12) + e.what)
  console.log('')
  console.log('Both take effect immediately; no restart needed.')
  console.log('')
  console.log('  see your own numbers   node measure.cjs')
  console.log('  tune the read block    SQUINT_THRESHOLD_BYTES=16000   (default 8000)')
  console.log('  tune the fan-out block SQUINT_FANOUT_MIN=6            (default 4)')
  console.log('  disable both, keep log touch ~/.claude/squint/OFF')
  console.log('  remove                 node install.cjs --uninstall')
  console.log('  decisions              ~/.claude/squint/log.jsonl')
}
