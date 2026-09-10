#!/usr/bin/env node
/**
 * squint install / uninstall.
 *
 *   node install.cjs              add the hook to ~/.claude/settings.json
 *   node install.cjs --uninstall  take it out again
 *
 * Your settings file is backed up next to itself before anything is written.
 * The install is idempotent: running it twice changes nothing the second time.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json')
const HOOK = path.join(__dirname, 'hooks', 'squint.cjs').replace(/\\/g, '/')
const COMMAND = `node "${HOOK}"`
const UNINSTALL = process.argv.includes('--uninstall')

function load() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))
  } catch {
    return {}
  }
}

function isSquint(entry) {
  return (entry.hooks || []).some((h) => String(h.command || '').includes('squint.cjs'))
}

const settings = load()
const existed = fs.existsSync(SETTINGS)

if (existed) {
  const backup = SETTINGS + '.backup-squint'
  fs.copyFileSync(SETTINGS, backup)
  console.log('backed up   ' + backup)
}

settings.hooks = settings.hooks || {}
settings.hooks.PreToolUse = settings.hooks.PreToolUse || []

const before = settings.hooks.PreToolUse.length
settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((e) => !isSquint(e))
const removed = before - settings.hooks.PreToolUse.length

if (!UNINSTALL) {
  settings.hooks.PreToolUse.push({
    matcher: 'Read',
    hooks: [{ type: 'command', command: COMMAND, timeout: 5 }],
  })
}

fs.mkdirSync(path.dirname(SETTINGS), { recursive: true })
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n')

// prove the file is still valid JSON before declaring success
JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))

if (UNINSTALL) {
  console.log(removed ? 'removed     squint from PreToolUse' : 'nothing to remove — squint was not installed')
} else {
  console.log('installed   PreToolUse -> Read -> ' + COMMAND)
  console.log('')
  console.log('It takes effect immediately; no restart needed.')
  console.log('Try it: ask Claude Code to read a source file bigger than 8 KB.')
  console.log('')
  console.log('  tune       SQUINT_THRESHOLD_BYTES=16000   (default 8000)')
  console.log('  disable    SQUINT_OFF=1                   (keeps logging, for A/B tests)')
  console.log('  remove     node install.cjs --uninstall')
  console.log('  decisions  ~/.claude/squint/log.jsonl')
}
