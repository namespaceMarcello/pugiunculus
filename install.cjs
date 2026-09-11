#!/usr/bin/env node
/**
 * pugi install / uninstall.
 *
 *   node install.cjs                add the three blockers to ~/.claude/settings.json
 *   node install.cjs --notebook     add the session notebook too; later runs keep it
 *   node install.cjs --no-notebook  take the notebook out, keep the blockers
 *   node install.cjs --uninstall    take everything out again
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
const NOTEBOOK_ON = process.argv.includes('--notebook')
const NOTEBOOK_OFF = process.argv.includes('--no-notebook')

const ENTRIES = [
  {
    event: 'PreToolUse',
    matcher: 'Read',
    file: 'pugi.cjs',
    what: 'blocks whole-file reads of large files',
  },
  {
    event: 'PreToolUse',
    matcher: 'Task|Agent',
    file: 'pugi-agents.cjs',
    what: 'blocks the next fan-out after a wasteful batch of subagents',
  },
  {
    event: 'PreToolUse',
    matcher: 'Bash|PowerShell',
    file: 'pugi-bash.cjs',
    what: 'blocks `cat BIG` and friends — the same waste through the shell',
  },
]

// One script on seven entries: it records on some events and puts the
// notebook back on the others. See hooks/pugi-notebook.cjs.
const NOTEBOOK = [
  { event: 'UserPromptSubmit' },
  { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit' },
  { event: 'PostToolUse', matcher: 'Bash', if: 'Bash(git commit *)' },
  { event: 'PostToolUse', matcher: 'PowerShell', if: 'PowerShell(git commit *)' },
  { event: 'Stop' },
  { event: 'SessionStart', matcher: 'compact|clear|resume' },
  { event: 'SessionEnd', matcher: 'clear' },
].map((e) => ({ ...e, file: 'pugi-notebook.cjs' }))

// Matches both the old squint*.cjs paths and the current pugi*.cjs ones, so a
// first run after the rename cleans up the old entries and every run after
// that stays idempotent.
const commandMatches = (entry, re) => (entry.hooks || []).some((h) => re.test(String(h.command || '')))
const isOurs = (entry) => commandMatches(entry, /(?:squint|pugi)(?:-agents|-bash|-notebook)?\.cjs/)
const isNotebook = (entry) => commandMatches(entry, /pugi-notebook\.cjs/)

let settings = {}
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))
} catch {
  /* no settings file yet — we will create one */
}

if (fs.existsSync(SETTINGS)) {
  const backup = SETTINGS + '.backup-pugi'
  fs.copyFileSync(SETTINGS, backup)
  console.log('backed up   ' + backup)
}

// One-time migration: squint's data dir becomes pugi's, so the existing log
// keeps being measured instead of starting over under the new name.
const OLD_DIR = path.join(os.homedir(), '.claude', 'squint')
const DIR = path.join(os.homedir(), '.claude', 'pugi')
if (fs.existsSync(OLD_DIR) && !fs.existsSync(DIR)) {
  fs.renameSync(OLD_DIR, DIR)
  console.log('migrated    ' + OLD_DIR + ' -> ' + DIR)
}

settings.hooks = settings.hooks || {}
const lists = () => Object.entries(settings.hooks).filter(([, list]) => Array.isArray(list))

// The notebook is opt-in; once chosen it survives a plain re-install.
const hadNotebook = lists().some(([, list]) => list.some(isNotebook))
const notebook = !UNINSTALL && !NOTEBOOK_OFF && (NOTEBOOK_ON || hadNotebook)

let removed = 0
for (const [event, list] of lists()) {
  const kept = list.filter((e) => !isOurs(e))
  if (kept.length === list.length) continue
  removed += list.length - kept.length
  if (kept.length) settings.hooks[event] = kept
  else delete settings.hooks[event]
}

if (!UNINSTALL) {
  for (const e of [...ENTRIES, ...(notebook ? NOTEBOOK : [])]) {
    const hook = { type: 'command', command: 'node "' + HOOKS + '/' + e.file + '"', timeout: 5 }
    if (e.if) hook.if = e.if
    ;(settings.hooks[e.event] = settings.hooks[e.event] || []).push(e.matcher ? { matcher: e.matcher, hooks: [hook] } : { hooks: [hook] })
  }
}

fs.mkdirSync(path.dirname(SETTINGS), { recursive: true })
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n')
JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) // prove it is still valid JSON

if (UNINSTALL) {
  console.log(removed ? 'removed     ' + removed + ' pugi hook(s)' : 'nothing to remove — pugi was not installed')
} else {
  for (const e of ENTRIES) console.log('installed   ' + e.matcher.padEnd(17) + e.what)
  if (notebook) console.log('installed   ' + 'session notebook'.padEnd(17) + 'your requests, the files changed and what was done, back after every cut')
  console.log('')
  console.log('They take effect immediately; no restart needed.')
  console.log('')
  console.log('  see your own numbers   node measure.cjs')
  console.log('  tune the read block    PUGI_THRESHOLD_BYTES=16000     (default 8000)')
  console.log('  tune the fan-out block PUGI_FANOUT_MIN=6              (default 4)')
  console.log(notebook ? '  drop the notebook      node install.cjs --no-notebook' : '  add the notebook       node install.cjs --notebook    (off by default)')
  console.log('  disable all, keep log  touch ~/.claude/pugi/OFF')
  console.log('  remove                 node install.cjs --uninstall')
  console.log('  decisions              ~/.claude/pugi/log.jsonl')
}
