#!/usr/bin/env node
/**
 * pugi install / uninstall.
 *
 *   node install.cjs                add the three blockers to ~/.claude/settings.json
 *   node install.cjs --notebook     add the session notebook too; later runs keep it
 *   node install.cjs --no-notebook  take the notebook out, keep the blockers
 *   node install.cjs --effort       add the effort router: a prompt hook and four skills; later runs keep it
 *   node install.cjs --effort --lang it   the same, plus the Italian word pack (hooks/effort-words.it.json) into ~/.claude/pugi
 *   node install.cjs --no-effort    take the effort router out, word pack included
 *   node install.cjs --lettore      add the lean reader agent and keep the subagent cache warm for an hour
 *   node install.cjs --no-lettore   take the reader agent and that setting out
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
const EFFORT_ON = process.argv.includes('--effort')
const EFFORT_OFF = process.argv.includes('--no-effort')
const LANG = process.argv.includes('--lang') ? String(process.argv[process.argv.indexOf('--lang') + 1] || '').toLowerCase() : null
const NO_LEARN = process.argv.includes('--no-learn')
const LETTORE_ON = process.argv.includes('--lettore')
const LETTORE_OFF = process.argv.includes('--no-lettore')

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

// The effort router: one hook on the prompt, and four skills the agent invokes
// to set the turn's effort. The skills live in ~/.claude/skills, marked as ours
// so a later --no-effort or --uninstall removes them and nothing else.
// See hooks/pugi-effort.cjs.
const EFFORT = [{ event: 'UserPromptSubmit', file: 'pugi-effort.cjs' }]
const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills')
const SKILL_MARK = '<!-- written by pugi install.cjs; node install.cjs --no-effort removes it -->'
const SKILLS = {
  low: 'Do the work directly, no extra deliberation: this is mechanical.',
  medium: 'Answer or act directly; think only where the request leaves a real choice.',
  xhigh: 'Think it through before acting: check the facts that decide it, and the strongest alternative.',
  max: 'Think it through fully before acting. First restate the real question, then find the facts that decide it in files or logs before opinions, then weigh the strongest alternative and say why it does not hold. Then answer short: the conclusion, the reasons that decide it, what stays uncertain.',
}
// The word pack of a language: hooks/effort-words.<lang>.json, copied to where the hook looks, marked as ours.
const WORDS_FILE = path.join(os.homedir(), '.claude', 'pugi', 'effort-words.json')
const WORDS_MARK = 'written by pugi install.cjs; node install.cjs --no-effort removes it'
const packFile = (lang) => path.join(__dirname, 'hooks', 'effort-words.' + lang + '.json')
const skillFile = (level) => path.join(SKILLS_DIR, 'effort-' + level, 'SKILL.md')
const skillText = (level) =>
  `---
name: effort-${level}
description: Sets this turn's effort to ${level}. Invoke as the first move when the context line next to the prompt says "Effort suggested for this turn: ${level}". Not for anything else.
effort: ${level}
user-invocable: false
---
${SKILL_MARK}

This turn runs at effort ${level}. ${SKILLS[level]}
`

// Matches both the old squint*.cjs paths and the current pugi*.cjs ones, so a
// first run after the rename cleans up the old entries and every run after
// that stays idempotent.
const commandMatches = (entry, re) => (entry.hooks || []).some((h) => re.test(String(h.command || '')))
const isOurs = (entry) => commandMatches(entry, /(?:squint|pugi)(?:-agents|-bash|-notebook|-effort)?\.cjs/)
const isNotebook = (entry) => commandMatches(entry, /pugi-notebook\.cjs/)
const isEffort = (entry) => commandMatches(entry, /pugi-effort\.cjs/)

// The lean reader: a subagent with three tools and ten lines of instructions,
// so a read handed to it costs its own reading and little else — measured at
// 10.7k tokens for its first request against 47.9k for a general-purpose
// agent. It comes with the subagent cache TTL set to an hour, so that part is
// paid once an hour, not once per agent.
const AGENT_FILE = path.join(os.homedir(), '.claude', 'agents', 'lettore.md')
const AGENT_MARK = '<!-- written by pugi install.cjs; node install.cjs --no-lettore removes it -->'
const AGENT_TEXT = `---
name: lettore
description: Reads files and code on behalf of the orchestrator and reports only what was asked, with exact paths and line numbers. Use for large reads or explorations across several files, never to open thirty lines.
tools: Read, Grep, Glob
model: sonnet
---
${AGENT_MARK}

You are a reader. You receive a brief naming files and what to look for.

- Find lines with Grep first, then Read with offset and limit around them. Never read a whole file unless the brief says so.
- Answer in English, short: the facts found, each with its path and line number; exact quotes when the brief asks for them; what you did not find.
- No opinions, no narrative, no suggestions unless asked.
`
const agentIsOurs = () => {
  try {
    return fs.readFileSync(AGENT_FILE, 'utf8').includes(AGENT_MARK)
  } catch {
    return false
  }
}

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
const hadEffort = lists().some(([, list]) => list.some(isEffort))
const effort = !UNINSTALL && !EFFORT_OFF && (EFFORT_ON || hadEffort)
const hadLettore = agentIsOurs()
const lettore = !UNINSTALL && !LETTORE_OFF && (LETTORE_ON || hadLettore)

let removed = 0
for (const [event, list] of lists()) {
  const kept = list.filter((e) => !isOurs(e))
  if (kept.length === list.length) continue
  removed += list.length - kept.length
  if (kept.length) settings.hooks[event] = kept
  else delete settings.hooks[event]
}

if (!UNINSTALL) {
  for (const e of [...ENTRIES, ...(notebook ? NOTEBOOK : []), ...(effort ? EFFORT : [])]) {
    const hook = { type: 'command', command: 'node "' + HOOKS + '/' + e.file + '"', timeout: 5 }
    if (e.if) hook.if = e.if
    ;(settings.hooks[e.event] = settings.hooks[e.event] || []).push(e.matcher ? { matcher: e.matcher, hooks: [hook] } : { hooks: [hook] })
  }
}

// The reader's cache setting: written with the agent, taken out with it, and never over a value that is not ours.
if (lettore) {
  if (settings.subagentPromptCacheTtl === undefined) settings.subagentPromptCacheTtl = '1h'
} else if (hadLettore && settings.subagentPromptCacheTtl === '1h') delete settings.subagentPromptCacheTtl

fs.mkdirSync(path.dirname(SETTINGS), { recursive: true })
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n')
JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) // prove it is still valid JSON

// The four effort skills follow the hook: written with it, removed with it. Only files carrying our mark are touched.
let skillsWritten = 0
let skillsRemoved = 0
for (const level of Object.keys(SKILLS)) {
  const file = skillFile(level)
  let current = null
  try {
    current = fs.readFileSync(file, 'utf8')
  } catch {}
  if (effort) {
    if (current === skillText(level)) continue
    if (current !== null && !current.includes(SKILL_MARK)) continue // someone else's skill: leave it
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, skillText(level))
    skillsWritten++
  } else if (current !== null && current.includes(SKILL_MARK)) {
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
    skillsRemoved++
  }
}

// The word pack follows the router: written on --lang, or on the language your own prompts are in when --effort is
// asked for explicitly; removed with the router; never over a file that is not ours. With enough history the lists
// are then learned from your prompts and kept only when they beat what is there on sessions they never saw.
let packWritten = null
let packRemoved = false
let learned = null
{
  let current = null
  try {
    current = JSON.parse(fs.readFileSync(WORDS_FILE, 'utf8'))
  } catch {}
  const ours = current && current._written_by === WORDS_MARK
  let lang = LANG
  const learnLib = effort && EFFORT_ON && !NO_LEARN ? require(path.join(__dirname, 'bench', 'effort-learn.cjs')) : null
  if (learnLib && !lang && (current === null || ours)) {
    const found = learnLib.detectLanguage(learnLib.collect(30).turns.map((t) => t.text))
    if (found) {
      console.log('your prompts ' + Math.round(100 * found.share) + '% ' + found.lang + ' (' + found.prompts + ' prompts in 30 days)' + (fs.existsSync(packFile(found.lang)) ? '' : '; no word pack for it, the English defaults stay'))
      if (fs.existsSync(packFile(found.lang)) && found.lang !== 'en') lang = found.lang
    }
  }
  if (effort && lang) {
    if (!/^[a-z]{2,3}$/.test(lang) || !fs.existsSync(packFile(lang))) {
      console.log('no word pack for --lang ' + lang + ' (looked for ' + packFile(lang) + '); the English defaults stay')
    } else if (current === null || ours) {
      const pack = JSON.parse(fs.readFileSync(packFile(lang), 'utf8'))
      pack._written_by = WORDS_MARK
      pack._lang = lang
      fs.mkdirSync(path.dirname(WORDS_FILE), { recursive: true })
      fs.writeFileSync(WORDS_FILE, JSON.stringify(pack, null, 2) + '\n')
      packWritten = lang
    } else console.log('left alone  ' + WORDS_FILE + ' (not written by us)')
  } else if (!effort && ours) {
    fs.rmSync(WORDS_FILE, { force: true })
    packRemoved = true
  }
  if (learnLib) learned = learnLib.learnAndJudge({ days: 30, file: WORDS_FILE, mark: WORDS_MARK, write: true })
}

// The reader agent follows the same rule as the skills: only a file carrying our mark is written over or removed.
let agentWritten = false
let agentRemoved = false
{
  let current = null
  try {
    current = fs.readFileSync(AGENT_FILE, 'utf8')
  } catch {}
  if (lettore) {
    if (current !== AGENT_TEXT && (current === null || current.includes(AGENT_MARK))) {
      fs.mkdirSync(path.dirname(AGENT_FILE), { recursive: true })
      fs.writeFileSync(AGENT_FILE, AGENT_TEXT)
      agentWritten = true
    }
  } else if (current !== null && current.includes(AGENT_MARK)) {
    fs.rmSync(AGENT_FILE, { force: true })
    agentRemoved = true
  }
}

if (UNINSTALL) {
  if (skillsRemoved) console.log('removed     ' + skillsRemoved + ' effort skill(s)')
  if (packRemoved) console.log('removed     the word pack')
  if (agentRemoved) console.log('removed     the lettore agent and its cache setting')
  console.log(removed ? 'removed     ' + removed + ' pugi hook(s)' : 'nothing to remove — pugi was not installed')
} else {
  for (const e of ENTRIES) console.log('installed   ' + e.matcher.padEnd(17) + e.what)
  if (notebook) console.log('installed   ' + 'session notebook'.padEnd(17) + 'your requests, the files changed and what was done, back after every cut')
  if (effort) console.log('installed   ' + 'effort router'.padEnd(17) + 'suggests a level per prompt; four skills effort-low/medium/xhigh/max' + (skillsWritten ? ' (' + skillsWritten + ' written)' : ''))
  if (packWritten) console.log('installed   ' + 'word pack'.padEnd(17) + packWritten + ' words added to the English defaults, in ' + WORDS_FILE)
  if (learned) {
    const pct = (x) => (x === null || x === undefined ? 'n/a' : Math.round(100 * x) + '%')
    console.log(
      'learned     ' + 'your words'.padEnd(17) + learned.verdict + (learned.defaults !== undefined ? ` (ranks hard above easy: defaults ${pct(learned.defaults)}, learned ${pct(learned.learned)}, on ${learned.prompts} prompts)` : ` (${learned.prompts} prompts)`)
    )
  }
  if (skillsRemoved) console.log('removed     ' + skillsRemoved + ' effort skill(s)')
  if (packRemoved) console.log('removed     the word pack')
  if (lettore) console.log('installed   ' + 'lettore agent'.padEnd(17) + 'a lean reader for large reads; subagent cache kept warm for an hour' + (agentWritten ? ' (written)' : ''))
  if (agentRemoved) console.log('removed     the lettore agent and its cache setting')
  console.log('')
  console.log(effort || lettore ? 'The hooks take effect immediately; the effort skills and the lettore agent from your next session.' : 'They take effect immediately; no restart needed.')
  console.log('')
  console.log('  see your own numbers   node measure.cjs')
  console.log('  tune the read block    PUGI_THRESHOLD_BYTES=16000     (default 8000)')
  console.log('  tune the fan-out block PUGI_FANOUT_MIN=6              (default 4)')
  console.log(notebook ? '  drop the notebook      node install.cjs --no-notebook' : '  add the notebook       node install.cjs --notebook    (off by default)')
  console.log(effort ? '  drop the effort router node install.cjs --no-effort' : '  add the effort router  node install.cjs --effort      (off by default)')
  console.log(lettore ? '  drop the reader agent  node install.cjs --no-lettore' : '  add the reader agent   node install.cjs --lettore     (off by default)')
  console.log('  disable all, keep log  touch ~/.claude/pugi/OFF')
  console.log('  remove                 node install.cjs --uninstall')
  console.log('  decisions              ~/.claude/pugi/log.jsonl')
}
