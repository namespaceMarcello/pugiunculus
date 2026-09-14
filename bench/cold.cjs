#!/usr/bin/env node
/**
 * What the cold-cache hook is worth, on your own sessions.
 *
 *   node bench/cold.cjs             the last 7 days of ~/.claude/projects
 *   node bench/cold.cjs --days 30
 *
 * Every return after an idle longer than the cache TTL (an hour) is found in
 * the transcripts: the request that rewrote the whole conversation at the
 * cache-write rate. For each one, what the rest of that session cost as it
 * went is set against the same requests replayed after a /compact at the
 * return — the cold conversation read once at the input price, 10k of summary
 * as output, then a context that restarts at 90k and grows by what each
 * request really added — and against /clear, which costs nothing. Prices as
 * in measure-context.cjs: writes 2×, reads 0.1× (0.025× on Fable 5.1), output 5×.
 * The number is a ceiling: it assumes you compact every time. The hook's own
 * log then says how often you did (blocked vs insisted).
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { transcripts, typed, readWeight, W, DAYS, ROOT } = require(path.join(__dirname, '..', 'measure-context.cjs'))

const TTL_MIN = 60
const RESTART = 90e3
const SUMMARY_OUTPUT = 10e3
const k = (x) => Math.round(x / 1e3) + 'k'

const rows = []
let total = 0
let sessions = 0
for (const file of transcripts(ROOT)) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const calls = new Map()
  let prompts = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    let m
    try {
      m = JSON.parse(line)
    } catch {
      continue
    }
    if (m.isSidechain) continue
    if (typed(m)) prompts++
    const u = m.type === 'assistant' && m.message && m.message.usage
    const id = u && (m.message.id || m.requestId)
    if (!id) continue
    const t = Date.parse(m.timestamp || '') || 0
    const c = calls.get(id) || { start: t }
    Object.assign(c, { end: t, model: m.message.model, ctx: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), write: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0 })
    calls.set(id, c)
  }
  if (prompts < 2 || !calls.size) continue
  sessions++
  const cs = [...calls.values()].sort((a, b) => a.start - b.start)
  for (const c of cs) total += (c.ctx - c.write) * readWeight(c.model) + c.write * W.write1h + c.output * W.output
  cs.forEach((c, i) => {
    if (!i) return
    const idle = (c.start - cs[i - 1].end) / 60000
    if (idle <= TTL_MIN || c.write <= 0.2 * cs[i - 1].ctx || c.write <= 20e3) return
    const after = cs.slice(i)
    const rw = readWeight(c.model)
    const asIs = after.reduce((s, x) => s + (x.ctx - x.write) * rw + x.write * W.write1h, 0)
    let sim = RESTART
    let compact = c.ctx * W.input + SUMMARY_OUTPUT * W.output
    let prev = c.ctx
    for (const x of after) {
      const d = Math.max(0, x.ctx - prev)
      prev = x.ctx
      compact += sim * rw + d * W.write1h
      sim += d
    }
    rows.push({ idle: Math.round(idle), ctx: c.ctx, n: after.length, asIs, compact })
  })
}

if (!sessions) {
  console.log(`No interactive sessions in the last ${DAYS} days under ${ROOT}.`)
  process.exit(0)
}
console.log(`Last ${DAYS} days: ${sessions} interactive sessions, ${rows.length} returns after an idle of more than an hour.`)
if (rows.length) {
  console.log('idle'.padStart(8) + 'context'.padStart(9) + 'requests after'.padStart(16) + 'as it went'.padStart(12) + '/compact first'.padStart(15) + '/clear'.padStart(8))
  const hm = (m) => (m >= 120 ? Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') : m + 'm')
  for (const r of rows.sort((a, b) => b.asIs - a.asIs).slice(0, 12)) console.log(hm(r.idle).padStart(8) + k(r.ctx).padStart(9) + String(r.n).padStart(16) + k(r.asIs).padStart(12) + k(r.compact).padStart(15) + '0'.padStart(8))
  if (rows.length > 12) console.log(`  … and ${rows.length - 12} more`)
  const A = rows.reduce((s, r) => s + r.asIs, 0)
  const C = rows.reduce((s, r) => s + r.compact, 0)
  const R = rows.reduce((s, r) => s + r.ctx * W.write1h, 0)
  console.log(`\nThe rewrites alone: ${k(R)}, ${Math.round((100 * R) / total)}% of what the ${DAYS} days cost.`)
  console.log(`What followed them, as it went: ${k(A)} (${Math.round((100 * A) / total)}%); after a /compact at each return: ${k(C)} — ${Math.round((100 * (A - C)) / total)}% of the cost, if you compacted every time. After /clear: the work of those sessions starts over.`)
}

// The hook's own log: how often it spoke, and how often you went on anyway.
try {
  const since = Date.now() - DAYS * 864e5
  const counts = {}
  for (const line of fs.readFileSync(path.join(os.homedir(), '.claude', 'pugi', 'log.jsonl'), 'utf8').split('\n')) {
    if (!line.includes('"cold"')) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (r.hook !== 'cold' || Date.parse(r.ts) < since) continue
    counts[r.decision] = (counts[r.decision] || 0) + 1
  }
  const names = Object.keys(counts)
  if (names.length) console.log(`\nThe hook so far: ` + names.map((d) => `${d} ${counts[d]}`).join(', ') + '.')
} catch {}
