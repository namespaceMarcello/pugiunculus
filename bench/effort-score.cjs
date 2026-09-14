#!/usr/bin/env node
/**
 * Does the effort scorer separate easy turns from hard ones, what would it
 * have changed, and can it learn your words? Replayed on your own prompts.
 * No model call, nothing leaves the machine.
 *
 *   node bench/effort-score.cjs              the last 14 days of ~/.claude/projects
 *   node bench/effort-score.cjs --days 30
 *   node bench/effort-score.cjs --samples    also print ten prompts per level, to read by eye
 *   node bench/effort-score.cjs --savings    estimate what the router would have saved, from the levels you ran at
 *   node bench/effort-score.cjs --learn      learn word lists from your history and judge them on held-out sessions
 *   node bench/effort-score.cjs --learn --write   the same, and write them to ~/.claude/pugi/effort-words.json when they win
 *   node bench/effort-score.cjs --check      harder: five folds by session, a split by time, and a learning curve
 *   node bench/effort-score.cjs --text       did the line next to the prompt move thinking? turns with it against turns without, same class, same session level
 *
 * Every typed prompt of every interactive session is scored with
 * hooks/pugi-effort.cjs, exactly as the hook would (the words in
 * ~/.claude/pugi/effort-words.json count, as they do for the hook). Then the
 * turn it started — every request until the next typed prompt — is measured
 * from the transcript: thinking tokens (from the billed output, or the API's
 * own count when it is recorded), tool calls, requests. If the scorer is worth
 * anything, the turns it calls `max` thought and worked far more than the ones
 * it calls `low`. Thinking also depends on the effort the session was at, so
 * the table is repeated for the session effort that has the most turns.
 *
 * --savings: the transcript records the effort every request ran at. Where the
 * same class of prompt ran at two levels, the ratio of their median thinking is
 * how much that level multiplies thinking. Each turn is then re-priced at the
 * level the scorer suggests, and the difference is counted twice, as it is
 * paid: once as output, and once per later request that re-reads it.
 *
 * --learn: see bench/effort-learn.cjs.
 */

const path = require('node:path')
const { W, DAYS, ROOT } = require(path.join(__dirname, '..', 'measure-context.cjs'))
const { score, LEVELS, USER_WORDS } = require(path.join(__dirname, '..', 'hooks', 'pugi-effort.cjs'))
const lib = require(path.join(__dirname, 'effort-learn.cjs'))

const args = process.argv.slice(2)
const SAMPLES = args.includes('--samples')
const SAVINGS = args.includes('--savings')
const LEARN = args.includes('--learn')
const WRITE = args.includes('--write')
const CHECK = args.includes('--check')
const TEXT = args.includes('--text')
const days = args.includes('--days') ? Number(args[args.indexOf('--days') + 1]) : DAYS
const MARK = 'written by pugi install.cjs; node install.cjs --no-effort removes it'

/** The router's suggestions from the pugi log: session, time, grade. */
function suggestions() {
  const fs = require('node:fs')
  const os = require('node:os')
  const rows = []
  try {
    for (const l of fs.readFileSync(path.join(os.homedir(), '.claude', 'pugi', 'log.jsonl'), 'utf8').split('\n')) {
      if (!l.includes('"hook":"effort"')) continue
      try {
        const r = JSON.parse(l)
        if (r.hook === 'effort' && r.decision === 'suggest') rows.push({ session: r.session, at: Date.parse(r.ts), level: r.level, grade: r.grade })
      } catch {}
    }
  } catch {}
  return rows
}
const suggestedFor = (rows, t) => (t.sid && t.when ? rows.find((r) => r.session === t.sid && Math.abs(r.at - t.when) < 15000) : undefined)

// --text: the router writes one line next to the prompt and sets nothing. Did the line move thinking? Turns are
// grouped by the level the session was at and the level the scorer gives the prompt (so easy prompts are compared
// with easy prompts), and split by whether the line was there: the pugi log has every suggestion, with session
// and time. Prompts the scorer leaves at the session's own level are skipped, since the line asks for nothing.
if (TEXT) {
  const rows = suggestions()
  const { turns } = lib.collect(days)
  lib.scoreAll(score, turns)
  const median = (xs) => {
    if (!xs.length) return 0
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }
  const k = (x) => (Math.abs(x) >= 1000 ? (x / 1000).toFixed(1) + 'k' : String(Math.round(x)))
  const cells = {}
  let withLine = 0
  for (const t of turns) {
    if (!t.effort || !t.requests) continue
    if (t.level === t.effort) continue
    const s = suggestedFor(rows, t)
    const what = s ? 'line' : 'none'
    if (s) withLine++
    const key = t.effort + '|' + t.level
    const c = (cells[key] = cells[key] || { none: [], line: [] })
    c[what].push({ thinking: t.thinking, per: t.thinking / t.requests, model: t.model })
  }
  console.log(`Last ${days} days: ${turns.length} typed turns, ${withLine} with the router's line next to the prompt.`)
  console.log('Thinking per turn and per request, median, for prompts the scorer puts away from the session level:\n')
  console.log('session'.padEnd(9) + 'scored'.padEnd(8) + 'the line'.padEnd(12) + 'turns'.padStart(6) + 'thinking/turn'.padStart(15) + 'thinking/req'.padStart(14) + '   models')
  const order = (l) => LEVELS.indexOf(l)
  for (const key of Object.keys(cells).sort((a, b) => order(a.split('|')[0]) - order(b.split('|')[0]) || order(a.split('|')[1]) - order(b.split('|')[1]))) {
    const [sess, lvl] = key.split('|')
    const c = cells[key]
    if (!c.line.length) continue
    for (const what of ['none', 'line']) {
      const xs = c[what]
      if (!xs.length) continue
      const models = [...new Set(xs.map((x) => x.model))].join(',')
      console.log(sess.padEnd(9) + lvl.padEnd(8) + (what === 'line' ? 'there' : 'absent').padEnd(12) + String(xs.length).padStart(6) + k(median(xs.map((x) => x.thinking))).padStart(15) + k(median(xs.map((x) => x.per))).padStart(14) + '   ' + models)
    }
    console.log('')
  }
  console.log(`Fewer than ten turns in a row is an anecdote. The line was on from 2026-09-13 on the author's machine; "absent" is everything before, and sessions with the hook off.`)
  process.exit(0)
}

if (CHECK) {
  const r = lib.checks({ days, file: USER_WORDS, mark: MARK })
  const pct = (x) => (x === null || x === undefined ? ' n/a' : String(Math.round(100 * x)).padStart(3) + '%')
  console.log(`Last ${r.days || days} days: ${r.prompts} typed prompts. Ranks a hard turn above an easy one (50% is a coin flip):\n`)
  if (r.folds.length) {
    console.log('Five folds by session, each judged by words that never saw it:')
    console.log('fold'.padEnd(6) + 'learned on'.padStart(11) + 'judged on'.padStart(11) + 'defaults'.padStart(10) + 'learned'.padStart(9))
    r.folds.forEach((f, i) => console.log(String(i + 1).padEnd(6) + String(f.train).padStart(11) + String(f.test).padStart(11) + pct(f.defaults).padStart(10) + pct(f.learned).padStart(9)))
    const mean = (k) => r.folds.reduce((s, f) => s + (f[k] || 0), 0) / r.folds.length
    console.log('mean'.padEnd(6) + ''.padStart(22) + pct(mean('defaults')).padStart(10) + pct(mean('learned')).padStart(9) + '\n')
  }
  if (r.temporal) console.log(`By time, learned on the first ${r.temporal.train} prompts, judged on the last ${r.temporal.test}: defaults ${pct(r.temporal.defaults).trim()}, learned ${pct(r.temporal.learned).trim()}.\n`)
  if (r.curve.length) {
    console.log('Learning curve: the last n prompts before the time cut, judged on what came after:')
    console.log('n'.padEnd(6) + 'defaults'.padStart(10) + 'learned'.padStart(9) + 'words'.padStart(7))
    for (const c of r.curve) console.log(String(c.n).padEnd(6) + pct(c.defaults).padStart(10) + pct(c.learned).padStart(9) + String(c.words).padStart(7))
  }
  process.exit(0)
}

if (LEARN) {
  const r = lib.learnAndJudge({ days, file: USER_WORDS, mark: MARK, write: WRITE })
  const pct = (x) => (x === null || x === undefined ? 'n/a' : Math.round(100 * x) + '%')
  console.log(`Last ${r.days} days: ${r.prompts} typed prompts.`)
  if (r.defaults !== undefined) {
    console.log('How often each scorer ranks a hard turn above an easy one, on sessions it never saw (50% is a coin flip):')
    console.log('  English defaults alone   ' + pct(r.defaults))
    console.log('  your current word file   ' + pct(r.current))
    console.log('  learned from your history' + pct(r.learned).padStart(6) + `   (${r.words} words and pairs)`)
  }
  console.log(r.verdict)
  process.exit(0)
}

const { turns, totalCost } = lib.collect(days)
lib.scoreAll(score, turns)

if (!turns.length) {
  console.log(`No typed prompts in the last ${days} days under ${ROOT}.`)
  process.exit(0)
}

const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const k = (x) => (Math.abs(x) >= 1000 ? Math.round(x / 1000) + 'k' : String(Math.round(x)))

function table(rows, title) {
  console.log(title)
  console.log('level'.padEnd(8) + 'turns'.padStart(7) + 'thinking, median'.padStart(18) + 'calls, median'.padStart(15) + 'requests, median'.padStart(18))
  const med = {}
  for (const level of LEVELS) {
    const xs = rows.filter((t) => t.level === level)
    med[level] = median(xs.map((t) => t.thinking))
    console.log(level.padEnd(8) + String(xs.length).padStart(7) + k(med[level]).padStart(18) + String(median(xs.map((t) => t.calls))).padStart(15) + String(median(xs.map((t) => t.requests))).padStart(18))
  }
  const lo = med.low || med.medium
  const hi = med.max || med.xhigh
  console.log(lo && hi ? `hardest class thought ${(hi / lo).toFixed(1)}× the easiest, by median.\n` : 'not enough turns in the extreme classes.\n')
}

console.log(`Last ${days} days: ${turns.length} typed prompts, scored as the hook would.\n`)
table(turns, 'All turns:')
const byEffort = {}
for (const t of turns) if (t.effort) byEffort[t.effort] = (byEffort[t.effort] || 0) + 1
const top = Object.entries(byEffort).sort((a, b) => b[1] - a[1])[0]
if (top) table(turns.filter((t) => t.effort === top[0]), `Turns whose session was at effort "${top[0]}" (${top[1]} turns), so thinking is comparable:`)

const signalCount = {}
for (const t of turns) for (const s of t.signals) signalCount[s] = (signalCount[s] || 0) + 1
console.log('signals fired: ' + Object.entries(signalCount).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(', '))
const sep = lib.separation(score, turns.map((t) => ({ ...t })))
if (sep !== null) console.log(`Ranks a hard turn above an easy one ${Math.round(100 * sep)}% of the time (50% is a coin flip); --learn judges this on sessions the words never saw.`)

if (SAMPLES) {
  for (const level of LEVELS) {
    const xs = turns.filter((t) => t.level === level).slice(0, 10)
    if (!xs.length) continue
    console.log(`\n${level}:`)
    for (const t of xs) console.log(`  [${k(t.thinking)} thinking, ${t.calls} calls] ${t.text.replace(/\s+/g, ' ').slice(0, 110)}`)
  }
}

if (SAVINGS) {
  console.log('\nWhat the router would have changed, from the levels you actually ran at:')
  // How much each level multiplies thinking: the ratio of median thinking for the same class at that level and at the reference level.
  const ref = top ? top[0] : null
  const cell = {}
  for (const t of turns) if (t.effort) (cell[t.effort + '|' + t.level] = cell[t.effort + '|' + t.level] || []).push(t.thinking)
  const mult = {}
  const basis = {}
  for (const level of Object.keys(byEffort)) {
    const ratios = []
    for (const cls of LEVELS) {
      const a = cell[level + '|' + cls] || []
      const b = cell[ref + '|' + cls] || []
      if (a.length >= 5 && b.length >= 5 && median(b) > 0) ratios.push({ r: median(a) / median(b), n: Math.min(a.length, b.length) })
    }
    if (level === ref) mult[level] = 1
    else if (ratios.length) {
      ratios.sort((x, y) => x.r - y.r)
      mult[level] = ratios[Math.floor(ratios.length / 2)].r
    }
    basis[level] = ratios.length
  }
  console.log('level'.padEnd(8) + 'turns run at it'.padStart(16) + 'thinking ×'.padStart(12) + '   from')
  for (const level of LEVELS)
    if (byEffort[level]) console.log(level.padEnd(8) + String(byEffort[level]).padStart(16) + (mult[level] !== undefined ? mult[level].toFixed(2) : '?').padStart(12) + `   ${level === ref ? 'reference' : basis[level] ? basis[level] + ' classes seen at both levels' : 'no class seen at both levels: unknown, left unchanged'}`)
  let produced = 0
  let reread = 0
  let moved = 0
  let unknown = 0
  for (const t of turns) {
    const from = mult[t.effort]
    const to = mult[t.level]
    if (from === undefined || to === undefined) {
      unknown++
      continue
    }
    if (t.level === t.effort) continue
    const delta = t.thinking * (to / from) - t.thinking
    produced += delta
    reread += delta * t.after
    moved++
  }
  const cost = produced * W.output + reread * W.read
  console.log(`\nTurns the router would have moved to another level: ${moved} of ${turns.length}` + (unknown ? ` (${unknown} left as they were: level with no basis)` : '') + '.')
  console.log(`Thinking produced: ${produced <= 0 ? '−' : '+'}${k(Math.abs(produced))} tokens; re-read by later requests: ${reread <= 0 ? '−' : '+'}${k(Math.abs(reread))} token-reads.`)
  console.log(`In cost, output at ${W.output}× and re-reads at ${W.read}×: ${cost <= 0 ? '−' : '+'}${((100 * Math.abs(cost)) / totalCost).toFixed(1)}% of what these sessions cost.`)
  console.log('An estimate: the multipliers come from medians of small groups, and a level never seen for a class is left unchanged.')
}
