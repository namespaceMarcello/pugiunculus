#!/usr/bin/env node
/**
 * What clearing old tool results out of the conversation would have saved —
 * a ceiling, from your own transcripts. No model call, nothing leaves the machine.
 *
 *   node bench/prune-sim.cjs              the last 14 days of ~/.claude/projects
 *   node bench/prune-sim.cjs --days 30
 *
 * No hook can touch a result that is already in the conversation; a proxy on
 * ANTHROPIC_BASE_URL could, and so could the API's own context editing. Before
 * either is built, this replays every interactive session request by request
 * under a few policies: once the context exceeds X tokens, clear the tool
 * results older than K requests, but only if at least M tokens would go —
 * batched, the way the API's context editing does it. Each cleared result
 * leaves a 20-token placeholder.
 *
 * Cost model, the same relative weights as measure-context.cjs (input 1, cache
 * read 0.1, cache write 1.25 for the 5-minute TTL or 2 for the hour, output 5):
 *   - a cleared result is no longer re-read by every later request: −0.1 per token per request;
 *   - clearing edits the cached prefix at the position of the oldest cleared
 *     result, so everything after that point is written again at the write
 *     rate instead of being read at 0.1. That penalty is what decides whether
 *     pruning pays. The "ceiling" row ignores it: the most any pruner could save.
 *
 * It also counts context drops of 20% or more between two requests with no
 * compaction in between. If the harness already cleared old results on its
 * own, that is where it would show; the transcript does not say why a context shrank.
 */

const path = require('node:path')
const { transcripts, messages, chars, CHARS_PER_TOKEN, W, DAYS, ROOT } = require(path.join(__dirname, '..', 'measure-context.cjs'))

const PLACEHOLDER = 20
const POLICIES = [
  { name: 'ceiling: clear everything older than 10 requests, no cache penalty', K: 10, X: 0, M: 0, free: true },
  { name: 'X=100k  K=10  M=20k', K: 10, X: 100e3, M: 20e3 },
  { name: 'X=100k  K=30  M=50k', K: 30, X: 100e3, M: 50e3 },
  { name: 'X=200k  K=10  M=20k', K: 10, X: 200e3, M: 20e3 },
  { name: 'X=200k  K=30  M=50k', K: 30, X: 200e3, M: 50e3 },
  { name: 'X=200k  K=30  M=100k', K: 30, X: 200e3, M: 100e3 },
]

/** A session as its requests in order: the usage of each, and the tool results that entered the context just before it. */
function requests(msgs) {
  const out = []
  const seen = new Map() // request id -> index in out
  let pending = [] // tool-result tokens since the last request
  let compact = false
  for (const m of msgs) {
    if (m.isSidechain) continue
    if ((m.type === 'system' && m.subtype === 'compact_boundary') || m.isCompactSummary) {
      compact = true
      continue
    }
    const c = m.message && m.message.content
    if (m.type === 'user') {
      if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_result') pending.push(chars(b.content) / CHARS_PER_TOKEN)
      continue
    }
    const u = m.type === 'assistant' && m.message && m.message.usage
    const id = u && (m.message.id || m.requestId)
    if (!id) continue
    const w1h = (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0
    const usage = {
      input: u.input_tokens || 0,
      read: u.cache_read_input_tokens || 0,
      write1h: w1h,
      write5m: Math.max(0, (u.cache_creation_input_tokens || 0) - w1h),
      output: u.output_tokens || 0,
    }
    // Streaming writes one line per content block; the last one carries the final usage.
    if (seen.has(id)) {
      out[seen.get(id)].usage = usage
      continue
    }
    seen.set(id, out.length)
    out.push({ usage, results: pending, compact })
    pending = []
    compact = false
  }
  return out
}

const context = (r) => r.usage.input + r.usage.read + r.usage.write5m + r.usage.write1h

/** The cache write rate this session paid: whichever TTL wrote more tokens. */
function writeRate(reqs) {
  let w1h = 0
  let w5m = 0
  for (const r of reqs) {
    w1h += r.usage.write1h
    w5m += r.usage.write5m
  }
  return w1h >= w5m ? W.write1h : W.write5m
}

function simulate(reqs, p) {
  const rate = writeRate(reqs)
  let real = 0
  let sim = 0
  let events = 0
  let live = [] // { tokens, at: request index, pos: context size when it entered, cleared }
  let cleared = 0 // tokens taken out of the context so far, placeholders netted
  reqs.forEach((r, i) => {
    const u = r.usage
    const ctx = context(r)
    if (r.compact) {
      // The summary replaced everything; there is nothing old left to clear.
      live = []
      cleared = 0
    }
    for (const t of r.results) if (t > PLACEHOLDER) live.push({ tokens: t, at: i, pos: ctx, cleared: false })
    real += u.input * W.input + u.read * W.read + u.write5m * W.write5m + u.write1h * W.write1h + u.output * W.output

    // The policy runs before this request is sent.
    let penalty = 0
    const simCtx = ctx - cleared
    const cand = live.filter((x) => !x.cleared && x.at <= i - p.K)
    const D = cand.reduce((s, x) => s + x.tokens - PLACEHOLDER, 0)
    if (cand.length && simCtx > p.X && D >= p.M) {
      const oldest = Math.min(...cand.map((x) => x.pos))
      const before = live.filter((x) => x.cleared && x.pos < oldest).reduce((s, x) => s + x.tokens - PLACEHOLDER, 0)
      const tail = Math.max(0, simCtx - D - (oldest - before))
      if (!p.free) penalty = tail * (rate - W.read)
      for (const x of cand) x.cleared = true
      cleared += D
      events++
    }

    // What was cleared came out of the cached prefix first, then out of what was being written.
    let rem = cleared
    const read = Math.max(0, u.read - rem)
    rem -= u.read - read
    const write1h = Math.max(0, u.write1h - rem)
    rem -= u.write1h - write1h
    const write5m = Math.max(0, u.write5m - rem)
    rem -= u.write5m - write5m
    const input = Math.max(0, u.input - rem)
    sim += input * W.input + read * W.read + write5m * W.write5m + write1h * W.write1h + u.output * W.output + penalty
  })
  return { real, sim, events }
}

/**
 * Context drops of 20% or more between consecutive requests, with no compaction
 * in between, that hold: the request after the drop is still below 90% of what
 * came before. A one-request dip is a helper call the harness made for itself
 * (a title, a summary), not the conversation shrinking.
 */
function drops(reqs) {
  const out = []
  for (let i = 1; i < reqs.length - 1; i++) {
    if (reqs[i].compact || reqs[i + 1].compact) continue
    const a = context(reqs[i - 1])
    const b = context(reqs[i])
    const c = context(reqs[i + 1])
    if (a > 50e3 && b < 0.8 * a && c < 0.9 * a) out.push({ before: a, drop: a - b })
  }
  return out
}

const sessions = []
for (const file of transcripts(ROOT)) {
  const msgs = messages(file)
  if (!msgs) continue
  const reqs = requests(msgs)
  if (reqs.length) sessions.push(reqs)
}
if (!sessions.length) {
  console.log(`No interactive sessions in the last ${DAYS} days under ${ROOT}.`)
  process.exit(0)
}

const nReq = sessions.reduce((s, r) => s + r.length, 0)
console.log(`Last ${DAYS} days: ${sessions.length} interactive sessions, ${nReq} requests. Savings are relative to what was actually paid.\n`)
console.log('policy'.padEnd(70) + 'events'.padStart(7) + 'saved'.padStart(8) + '   sessions that pay more')
for (const p of POLICIES) {
  let real = 0
  let sim = 0
  let events = 0
  let worse = 0
  for (const reqs of sessions) {
    const r = simulate(reqs, p)
    real += r.real
    sim += r.sim
    events += r.events
    if (r.sim > r.real * 1.001) worse++
  }
  const saved = real ? ((100 * (real - sim)) / real).toFixed(1) : '0.0'
  console.log(p.name.padEnd(70) + String(events).padStart(7) + (saved + '%').padStart(8) + `   ${worse} of ${sessions.length}`)
}

const all = []
let affected = 0
for (const reqs of sessions) {
  const d = drops(reqs)
  if (d.length) affected++
  all.push(...d)
}
const med = (xs) => Math.round(xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] / 1000) + 'k'
console.log(
  `\nContext drops of 20% or more that hold, with no compaction in between: ${all.length} in ${affected} of ${sessions.length} sessions` +
    (all.length ? `; median drop ${med(all.map((d) => d.drop))} tokens, median context before it ${med(all.map((d) => d.before))}.` : '.')
)
console.log('If the harness cleared old tool results on its own, this is where it would show. The transcript does not say why a context shrank.')
