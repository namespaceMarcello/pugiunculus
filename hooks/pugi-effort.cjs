#!/usr/bin/env node
/**
 * pugi-effort — suggests an effort for the turn, from the prompt alone.
 *
 * UserPromptSubmit hook. Reads the prompt, scores it with word lists (no
 * model, no network), and adds one line of context next to it: "Effort
 * suggested for this turn: 3/10 (mechanical, short)." Nothing else: no
 * instruction on how to think, no skill to invoke, no parameter set. The
 * model reads the number and does what it does with it; whether that moves
 * its thinking is what `bench/effort-score.cjs --text` measures.
 *
 * The score is a small integer from the signals that fired (design words
 * raise, mechanical verbs lower, a request for speed lowers, two question
 * marks raise…); the line carries it on a 1-to-10 scale, and the log keeps
 * both the scale and the nearest of Claude Code's five levels, which the
 * status line and the bench use. Continuations ("ok", "go") keep the previous
 * turn's suggestion.
 *
 * The words live in effort-words.json next to this file (English). A file at
 * ~/.claude/pugi/effort-words.json, or the one PUGI_EFFORT_WORDS points to,
 * adds its words to those: `node install.cjs --effort --lang it` writes the
 * Italian pack there, and `--effort` alone learns your own words from your
 * history. `bench/effort-score.cjs` replays your own prompts and says whether
 * the lists separate easy turns from hard ones.
 *
 * It never rewrites the prompt: it adds a line next to it. Every decision goes
 * to ~/.claude/pugi/log.jsonl. PUGI_OFF=1, PUGI_EFFORT_OFF=1 or the file
 * ~/.claude/pugi/OFF turn it off and keep the log. On any error the prompt
 * goes through untouched.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const DEFAULT_WORDS = path.join(__dirname, 'effort-words.json')
const USER_WORDS = process.env.PUGI_EFFORT_WORDS || path.join(os.homedir(), '.claude', 'pugi', 'effort-words.json')
// The combining diacritics (U+0300 to U+036F) that NFD splits off an accented letter, written by code so the source stays ASCII.
const COMBINING = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g')

/** The English lists, plus whatever the user's file adds — or a pack given as an object. A broken user file is ignored, not fatal. */
function loadWords(user) {
  const base = JSON.parse(fs.readFileSync(DEFAULT_WORDS, 'utf8'))
  let extra = null
  if (user && typeof user === 'object') extra = user
  else
    try {
      extra = JSON.parse(fs.readFileSync(user, 'utf8'))
    } catch {}
  if (extra && typeof extra === 'object')
    for (const key of ['why', 'design', 'debug', 'mechanical', 'fast', 'continue']) {
      const e = extra[key]
      if (!e) continue
      if (key === 'continue') base.continue = base.continue.concat(Array.isArray(e) ? e : [])
      else {
        if (Array.isArray(e.words)) base[key].words = base[key].words.concat(e.words)
        if (typeof e.weight === 'number') base[key].weight = e.weight
      }
    }
  return base
}

/** The raw score on a 1-to-10 scale: 0 is 5, each point moves one step, the ends are clamped. */
const gradeOf = (s) => Math.max(1, Math.min(10, s + 5))
/** The nearest of Claude Code's five levels, for the log, the status line and the bench. */
const levelOf = (s) => (s <= -2 ? 'low' : s <= 0 ? 'medium' : s === 1 ? 'high' : s === 2 ? 'xhigh' : 'max')
const GRADE_OF_LEVEL = { low: 2, medium: 4, high: 6, xhigh: 7, max: 9 }

/** A scorer built from a word file. `build()` with no argument uses the user's file, or the defaults. */
function build(userFile = USER_WORDS) {
  const words = loadWords(userFile)
  const re = (list) => new RegExp('\\b(' + list.join('|') + ')\\b', 'i')
  const hard = ['why', 'design', 'debug'].map((k) => [k, words[k].weight, re(words[k].words)])
  const easy = re(words.mechanical.words)
  const fast = re(words.fast.words)
  const cont = new RegExp('^\\s*(' + words.continue.join('|') + ')\\b', 'i')

  /**
   * The suggestion for a prompt: hard signals raise, mechanical verbs and a request for speed lower, a bare
   * "go" keeps the previous turn's. `prev` is the previous result, or just its level. Each signal counts once:
   * counting occurrences was tried and separated hard turns from easy ones worse (57% against 75%).
   */
  function score(text, prev) {
    // Accents stripped first: JavaScript's \b does not know "é", so "perché" would never match at a word boundary.
    const t = String(text || '')
      .normalize('NFD')
      .replace(COMBINING, '')
    if (t.trim().length < 40 && cont.test(t)) {
      const p = typeof prev === 'string' ? { level: prev, grade: GRADE_OF_LEVEL[prev] } : prev
      return { level: (p && p.level) || 'high', grade: (p && p.grade) || GRADE_OF_LEVEL.high, score: null, signals: ['continuation'] }
    }
    let s = 0
    const signals = []
    for (const [name, weight, r] of hard)
      if (r.test(t)) {
        s += weight
        signals.push(name)
      }
    if (fast.test(t)) {
      s += words.fast.weight
      signals.push('fast')
    }
    if (t.length > 400) {
      s += 1
      signals.push('long')
    }
    if ((t.match(/\?/g) || []).length >= 2) {
      s += 1
      signals.push('questions')
    }
    if (easy.test(t)) {
      s += words.mechanical.weight
      signals.push('mechanical')
    }
    if (t.length < 80 && !t.includes('?')) {
      s -= 1
      signals.push('short')
    }
    return { level: levelOf(s), grade: gradeOf(s), score: s, signals }
  }
  return { score, words }
}

const { score } = build()

module.exports = { score, build, LEVELS, USER_WORDS }

// ---------------------------------------------------------------------------
// The hook.

if (require.main === module) {
  const DIR = path.join(os.homedir(), '.claude', 'pugi')
  const LOG = path.join(DIR, 'log.jsonl')
  const STATE = path.join(os.tmpdir(), 'pugi-state')
  const OFF_SWITCH = path.join(DIR, 'OFF')
  const LOGGING = process.env.PUGI_LOG !== '0'

  const note = (row) => {
    if (!LOGGING) return
    try {
      fs.mkdirSync(DIR, { recursive: true })
      fs.appendFileSync(LOG, JSON.stringify(row) + '\n')
    } catch {}
  }
  const exit = (payload) => {
    if (payload) process.stdout.write(JSON.stringify(payload))
    process.exit(0)
  }

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
    exit(out)
  })

  function run(ev) {
    const prompt = ev.prompt
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.trimStart().startsWith('/')) return null
    const session = ev.session_id || 'unknown'
    const base = { ts: new Date().toISOString(), session, hook: 'effort' }

    let state = {}
    const stateFile = path.join(STATE, session + '.json')
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    } catch {}
    const r = score(prompt, state.effort ? { level: state.effort, grade: state.grade } : null)
    state.effort = r.level
    state.grade = r.grade
    try {
      fs.mkdirSync(STATE, { recursive: true })
      fs.writeFileSync(stateFile, JSON.stringify(state))
    } catch {}

    const row = { level: r.level, grade: r.grade, score: r.score, signals: r.signals }
    if (process.env.PUGI_OFF === '1' || process.env.PUGI_EFFORT_OFF === '1' || fs.existsSync(OFF_SWITCH)) {
      note({ ...base, decision: 'off', ...row })
      return null
    }
    note({ ...base, decision: 'suggest', ...row })
    const because = r.signals.length ? r.signals.join(', ') : 'no strong signal'
    return {
      // The line the agent reads; and, when the terminal shows it, one for you.
      systemMessage: `pugi: effort → ${r.grade}/10 (${because})`,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `Effort suggested for this turn: ${r.grade}/10 (${because}).`,
      },
    }
  }
}
