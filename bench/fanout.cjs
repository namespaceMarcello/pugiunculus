#!/usr/bin/env node
/**
 * bench/fanout.cjs — does the fan-out block change what the agent does?
 *
 * The README's −63% comes from prompts a person batched by hand. This asks the
 * other question: when squint-agents refuses a fan-out, does the orchestrating
 * model rebatch, insist, or stop delegating — and what does each cost?
 *
 * One run = one headless Claude Code session (`claude -p`) given ten questions
 * in two batches of five. Batch A is told "one subagent per question", so the
 * session has a wasteful batch on record. Batch B only says "also with
 * subagents". With the hook on, the first wave of batch B is refused.
 *
 *   node bench/fanout.cjs --src <ts codebase> --model haiku --runs 5 [--off] [--escape] [--out results.jsonl]
 *   node bench/fanout.cjs --report results.jsonl
 *
 * --off is the control (only this hook disabled); --escape runs the hook
 * with the [separate context] way through offered (SQUINT_FANOUT_ESCAPE=1).
 *
 * Each run appends one JSON line: cost, duration, spawns, every squint-agents
 * decision for that session, the answers and the score. Nothing is uploaded
 * beyond the normal Claude Code calls the session itself makes.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const argv = process.argv.slice(2)
const opt = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : def
}
const flag = (name) => argv.includes('--' + name)

const LOG = path.join(os.homedir(), '.claude', 'squint', 'log.jsonl')

// ------------------------------------------------------------------ report

if (opt('report')) {
  const rows = fs
    .readFileSync(opt('report'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const groups = {}
  // Rows written before the hatch became opt-in carry `noEscape` instead of `escape`.
  const escaped = (r) => (r.escape !== undefined ? r.escape : r.noEscape === false)
  for (const r of rows) (groups[(r.model + (r.off ? ' · hook off' : escaped(r) ? ' · on, escape' : ' · hook on')).padEnd(18)] ||= []).push(r)
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  console.log('arm                 runs  fired  reaction after the refusal        spawns  tokens/run   $/run  minutes  correct')
  for (const [arm, rs] of Object.entries(groups)) {
    // Reactions are re-derived from the logged decisions, so a better
    // classifier never needs the runs repeated.
    for (const r of rs) if (r.decisions) Object.assign(r, reaction(r.decisions))
    const fired = rs.filter((r) => r.fired).length
    const reactions = {}
    for (const r of rs) if (r.fired) reactions[r.reaction] = (reactions[r.reaction] || 0) + 1
    const reactionText = Object.entries(reactions).map(([k, v]) => `${k} ${v}`).join(', ') || '—'
    console.log(
      arm +
        String(rs.length).padStart(4) +
        String(fired).padStart(7) +
        '  ' +
        reactionText.padEnd(34) +
        String(mean(rs.map((r) => r.spawned)).toFixed(1)).padStart(6) +
        String(Math.round(mean(rs.map((r) => r.tokens))).toLocaleString('en-US')).padStart(12) +
        String(mean(rs.map((r) => r.cost)).toFixed(2)).padStart(8) +
        String((mean(rs.map((r) => r.durationMs)) / 60000).toFixed(1)).padStart(9) +
        ('  ' + rs.reduce((a, r) => a + r.correct, 0) + '/' + rs.reduce((a, r) => a + r.total, 0)).padStart(9)
    )
  }
  process.exit(0)
}

// --------------------------------------------------------------- questions

const SRC = opt('src')
if (!SRC) {
  console.error('need --src <path to a TypeScript codebase> (or --report results.jsonl)')
  process.exit(1)
}
const MODEL = opt('model', 'haiku')
const RUNS = Number(opt('runs', 1))
const OFF = flag('off')
const ESCAPE = flag('escape')
const GAP = opt('gap', '10')
const OUT = opt('out', 'fanout-results.jsonl')
const CLAUDE = opt('claude', process.platform === 'win32' ? 'claude.exe' : 'claude')
const MIN_BYTES = 12000

function tsFiles(d, acc = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && !e.name.startsWith('.')) tsFiles(p, acc)
    } else if (e.name.endsWith('.ts')) acc.push(p)
  }
  return acc
}

/** Constants with a simple literal value, in big files, with a name unique to the project. */
function questions() {
  const seen = {}
  const found = []
  for (const f of tsFiles(SRC)) {
    const text = fs.readFileSync(f, 'utf8')
    const big = Buffer.byteLength(text) >= MIN_BYTES
    text.split('\n').forEach((line, i) => {
      const m = line.match(/^(?:export )?const ([A-Z][A-Z0-9_]{2,}) = (.+?)$/)
      if (!m) return
      seen[m[1]] = (seen[m[1]] || 0) + 1
      if (!big) return
      const value = m[2].replace(/\s*(\/\/.*)?$/, '').replace(/;$/, '').trim()
      if (!/^(-?\d+(\.\d+)?( ?\/ ?\d+(\.\d+)?)?|'[^']{1,30}'|true|false)$/.test(value)) return
      found.push({ file: path.relative(SRC, f).split('\\').join('/'), name: m[1], value, line: i + 1 })
    })
  }
  const unique = found.filter((q) => seen[q.name] === 1)
  // Spread across files, then shuffle deterministically so runs are comparable.
  const perFile = {}
  const spread = unique.filter((q) => (perFile[q.file] = (perFile[q.file] || 0) + 1) <= 3)
  let s = 12345
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = spread.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[spread[i], spread[j]] = [spread[j], spread[i]]
  }
  return spread
}

const POOL = questions()
if (POOL.length < 10) {
  console.error('only ' + POOL.length + ' usable questions in ' + SRC)
  process.exit(1)
}

function prompt(qs) {
  const src = path.resolve(SRC).split('\\').join('/')
  const ask = (q, label) => `${label}. In ${src}/${q.file}, what is the value assigned to the constant ${q.name}?`
  return [
    `Answer ten questions about the TypeScript codebase at ${src}. Each asks for the literal value assigned to one constant in one file. The answer is the value exactly as written in the source (keep the quotes if it is a string).`,
    '',
    'Batch A — do this first. Delegate every question in this batch to its own subagent (model: haiku), all in parallel, then collect the answers.',
    ...qs.slice(0, 5).map((q, i) => ask(q, 'A' + (i + 1))),
    '',
    'Batch B — only after batch A is complete. Delegate these to haiku subagents as well.',
    ...qs.slice(5, 10).map((q, i) => ask(q, 'B' + (i + 1))),
    '',
    'When finished, print all ten answers, one per line, in the form `A1: value`. Nothing else.',
  ].join('\n')
}

// -------------------------------------------------------------------- runs

const norm = (v) => String(v || '').trim().replace(/^["'`]|["'`]$/g, '').replace(/\s+/g, ' ')

function score(text, qs) {
  const labels = ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'B5']
  const answers = {}
  for (const m of String(text).matchAll(/\b([AB][1-5])\s*[:：]\s*(.+)/g)) answers[m[1]] = m[2].trim()
  let correct = 0
  const detail = labels.map((l, i) => {
    const ok = norm(answers[l]) === norm(qs[i].value)
    if (ok) correct++
    return { q: l, expected: qs[i].value, got: answers[l] ?? null, ok }
  })
  return { correct, total: labels.length, detail }
}

function hookDecisions(sessionId) {
  let text = ''
  try {
    text = fs.readFileSync(LOG, 'utf8')
  } catch {}
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter((r) => r && r.session === sessionId && (r.tool === 'Agent' || r.tool === 'Task'))
    .map((r) => ({ d: r.decision, chars: r.chars ?? null, prev: r.previousBatch ?? null, waves: r.refusedWaves ?? null }))
}

/** What the orchestrator did after the first refusal, read from the hook's own log. */
function reaction(decs) {
  const i = decs.findIndex((x) => x.d === 'blocked')
  if (i < 0) return { fired: false, reaction: 'not fired', spawnsAfter: 0, medianAfter: null, refusedWaves: 0 }
  const after = decs.slice(i).filter((x) => x.d !== 'blocked')
  const chars = after.map((x) => x.chars).filter((c) => c !== null).sort((a, b) => a - b)
  const median = chars.length ? chars[Math.floor(chars.length / 2)] : null
  const waves = Math.max(0, ...decs.filter((x) => x.d === 'blocked').map((x) => x.waves || 1))
  const has = (d) => after.some((x) => x.d === d)
  // The hook itself names how each spawn got through; the run is labelled by
  // the first way it found.
  let r
  if (!after.length) r = 'no more spawns'
  else if (has('rebatched')) r = 'rebatched'
  else if (has('escaped')) r = 'escaped: [separate context]'
  else if (has('insisted')) r = 'insisted until the valve'
  else r = 'passed'
  return { fired: true, reaction: r, spawnsAfter: after.length, medianAfter: median, refusedWaves: waves }
}

function runOnce(i) {
  const qs = POOL.slice((i * 10) % (POOL.length - 9), (i * 10) % (POOL.length - 9) + 10)
  const cwd = path.join(os.tmpdir(), 'squint-bench')
  fs.mkdirSync(cwd, { recursive: true })
  // The control differs in one thing only: the fan-out hook. The read and
  // shell hooks stay on in both arms, or their savings would be booked here.
  const env = { ...process.env, SQUINT_FANOUT_GAP: GAP }
  delete env.CLAUDECODE
  delete env.SQUINT_OFF
  if (OFF) env.SQUINT_FANOUT_OFF = '1'
  else delete env.SQUINT_FANOUT_OFF
  if (ESCAPE) env.SQUINT_FANOUT_ESCAPE = '1'
  else delete env.SQUINT_FANOUT_ESCAPE

  const t0 = Date.now()
  const r = spawnSync(
    CLAUDE,
    ['-p', prompt(qs), '--model', MODEL, '--output-format', 'json', '--allowedTools', 'Agent,Read,Grep,Glob', '--max-turns', '40'],
    { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000 }
  )
  let res = null
  try {
    res = JSON.parse(r.stdout)
  } catch {
    return { model: MODEL, off: OFF, error: 'no JSON result', stderr: String(r.stderr || '').slice(-2000), stdout: String(r.stdout || '').slice(-2000) }
  }
  const usage = res.modelUsage || {}
  const tokens = Object.values(usage).reduce(
    (a, u) => a + (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadInputTokens || 0) + (u.cacheCreationInputTokens || 0),
    0
  )
  const decs = hookDecisions(res.session_id)
  const sc = score(res.result, qs)
  return {
    model: MODEL,
    off: OFF,
    escape: ESCAPE,
    session: res.session_id,
    durationMs: Date.now() - t0,
    cost: res.total_cost_usd || 0,
    tokens,
    spawned: res.subagent_stats?.spawned ?? null,
    permissionDenials: (res.permission_denials || []).length,
    denied: (res.permission_denials || []).map((d) => d.tool_name || d.tool || d),
    usage,
    decisions: decs,
    ...reaction(decs),
    correct: sc.correct,
    total: sc.total,
    answers: sc.detail,
    questions: qs,
  }
}

for (let i = 0; i < RUNS; i++) {
  process.stdout.write(`run ${i + 1}/${RUNS}  ${MODEL}  hook ${OFF ? 'off' : ESCAPE ? 'on, escape' : 'on'} ... `)
  const row = runOnce(i)
  fs.appendFileSync(OUT, JSON.stringify(row) + '\n')
  if (row.error) console.log('ERROR ' + row.error)
  else
    console.log(
      `${row.reaction}  spawned ${row.spawned}  ${row.correct}/${row.total} correct  $${row.cost.toFixed(2)}  ${(row.durationMs / 60000).toFixed(1)} min`
    )
}
