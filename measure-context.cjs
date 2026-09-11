#!/usr/bin/env node
/**
 * Where the tokens of a Claude Code session actually go.
 *
 *   node measure-context.cjs            the last 7 days of ~/.claude/projects
 *   node measure-context.cjs --days 30
 *
 * Claude Code sends the whole conversation with every request. This reads your
 * own transcripts and splits what that costs: re-reading the conversation,
 * writing it into the cache, the model's output — and how much of all that is
 * the prompts you typed. Prices are relative (cache read 0.1x input, 5-minute
 * cache write 1.25x, 1-hour write 2x, output 5x). Every current model uses the
 * same ratios, so the shares hold whichever model you run. Interactive sessions
 * only: two typed prompts or more, subagents left out. Nothing leaves your machine.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const args = process.argv.slice(2)
const DAYS = Number(args.includes('--days') ? args[args.indexOf('--days') + 1] : 7)
const ROOT = path.join(os.homedir(), '.claude', 'projects')
const SINCE = Date.now() - DAYS * 864e5
const CHARS_PER_TOKEN = 3.3
const W = { input: 1, read: 0.1, write5m: 1.25, write1h: 2, output: 5 }
const CAPS = [150e3, 250e3, 400e3]
const NOISE = /^\s*(<command-|<local-command|Caveat:|\[Request interrupted|<system-reminder>|<task-notification|<bash-|This session is being continued)/

function transcripts(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      // Subagents run in their own context; the benchmarks' sessions (cwd pugi-bench-*) are not your work.
      if (e.name !== 'subagents' && !e.name.includes('pugi-bench')) transcripts(p, out)
    } else if (e.name.endsWith('.jsonl') && !e.name.startsWith('agent-')) {
      try {
        if (fs.statSync(p).mtimeMs >= SINCE) out.push(p)
      } catch {}
    }
  }
  return out
}

/** The text you typed, or null for tool results, reminders, commands and summaries. */
function typed(m) {
  if (m.type !== 'user' || m.isMeta || m.isCompactSummary) return null
  const c = m.message && m.message.content
  let t = null
  if (typeof c === 'string') t = c
  else if (Array.isArray(c) && !c.some((b) => b && b.type === 'tool_result'))
    t = c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
  return t && !NOISE.test(t) ? t : null
}

const sessions = []
for (const file of transcripts(ROOT)) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const s = { prompts: [], calls: new Map(), compacted: false }
  for (const line of text.split('\n')) {
    if (!line) continue
    let m
    try {
      m = JSON.parse(line)
    } catch {
      continue
    }
    if (m.isSidechain) continue
    if ((m.type === 'system' && m.subtype === 'compact_boundary') || m.isCompactSummary) s.compacted = true
    const t = typed(m)
    if (t) s.prompts.push({ tokens: t.length / CHARS_PER_TOKEN, at: s.calls.size })
    const u = m.type === 'assistant' && m.message && m.message.usage
    const id = u && (m.message.id || m.requestId)
    if (!id) continue
    // Streaming writes one line per content block; the last one carries the final usage.
    const w1h = (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0
    s.calls.set(id, {
      input: u.input_tokens || 0,
      read: u.cache_read_input_tokens || 0,
      write1h: w1h,
      write5m: Math.max(0, (u.cache_creation_input_tokens || 0) - w1h),
      output: u.output_tokens || 0,
    })
  }
  if (s.prompts.length >= 2 && s.calls.size) sessions.push(s)
}

if (!sessions.length) {
  console.log(`No interactive sessions in the last ${DAYS} days under ${ROOT}.`)
  process.exit(0)
}

let total = 0
let read = 0
let write = 0
let output = 0
let prompts = 0
let promptCost = 0
let calls = 0
let compacted = 0
const contexts = []
const beyond = CAPS.map(() => 0)
for (const s of sessions) {
  const cs = [...s.calls.values()]
  calls += cs.length
  if (s.compacted) compacted++
  let w1h = 0
  let w5m = 0
  for (const c of cs) {
    const r = c.read * W.read
    const w = c.write5m * W.write5m + c.write1h * W.write1h
    const o = c.output * W.output
    total += c.input * W.input + r + w + o
    read += r
    write += w
    output += o
    w1h += c.write1h
    w5m += c.write5m
    const ctx = c.input + c.read + c.write5m + c.write1h
    contexts.push(ctx)
    CAPS.forEach((cap, i) => (beyond[i] += Math.max(0, ctx - cap) * W.read))
  }
  // A prompt is written into the cache once, then re-read by every later request of its session.
  const writeWeight = w1h >= w5m ? W.write1h : W.write5m
  for (const p of s.prompts) {
    prompts++
    promptCost += p.tokens * (writeWeight + W.read * Math.max(0, cs.length - p.at - 1))
  }
}

const share = (x) => {
  const v = (100 * x) / total
  return (v < 1 ? v.toFixed(2) : Math.round(v)) + '%'
}
const sorted = contexts.sort((a, b) => a - b)
const q = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] / 1000) + 'k'

console.log(`Last ${DAYS} days: ${sessions.length} interactive sessions, ${calls} requests, ${prompts} prompts you typed.\n`)
console.log(`  re-reading the conversation      ${share(read)} of the cost`)
console.log(`  writing it into the cache        ${share(write)}`)
console.log(`  the model's output               ${share(output)}`)
console.log(`  the prompts you typed            ${share(promptCost)}`)
console.log('')
console.log(`  conversation sent per request    median ${q(0.5)}, 90th percentile ${q(0.9)} tokens`)
console.log(`  sessions ever compacted          ${compacted} of ${sessions.length}`)
for (let i = 0; i < CAPS.length; i++)
  console.log(`  re-reading past ${(CAPS[i] / 1000 + 'k').padEnd(5)}           ${share(beyond[i])} of the cost — the most a cut there could save`)
