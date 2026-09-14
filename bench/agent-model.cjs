#!/usr/bin/env node
/**
 * What the model hook is worth, on your own launches.
 *
 *   node bench/agent-model.cjs             the last 30 days of ~/.claude/projects
 *   node bench/agent-model.cjs --days 7
 *
 * Every subagent launched from a conversation is matched to the Agent call
 * that launched it (the call's result names the agent), so the call says
 * whether a model was asked for and the agent's own transcript says which one
 * it ran on and what it cost, at list price. Launches without a model are the
 * hook's target: what they cost on the model they inherited, and what the
 * same requests would have cost on Sonnet — a ceiling, since the orchestrator
 * may choose Opus again, and rightly. Then the hook's own log: how often it
 * refused, which model was chosen after, how often none was.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const args = process.argv.slice(2)
const DAYS = Number(args.includes('--days') ? args[args.indexOf('--days') + 1] : 30)
const SINCE = Date.now() - DAYS * 864e5
const ROOT = path.join(os.homedir(), '.claude', 'projects')

// List prices per million tokens by family: input, cache write (an hour), cache read, output.
const PRICES = {
  fable: { input: 10, write: 20, read: 0.25, output: 50 },
  opus: { input: 5, write: 10, read: 0.5, output: 25 },
  sonnet: { input: 2, write: 4, read: 0.2, output: 10 },
  haiku: { input: 1, write: 2, read: 0.1, output: 5 },
}
const family = (m) => (/fable|mythos/.test(m || '') ? 'fable' : /opus/.test(m || '') ? 'opus' : /sonnet/.test(m || '') ? 'sonnet' : /haiku/.test(m || '') ? 'haiku' : null)

const mains = []
const agents = new Map()
;(function walk(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!/(?:pugi|squint)-bench/.test(e.name)) walk(p)
    } else if (e.name.endsWith('.jsonl')) {
      try {
        if (fs.statSync(p).mtimeMs < SINCE) continue
      } catch {
        continue
      }
      if (e.name.startsWith('agent-')) agents.set(e.name.slice(6, -6), p)
      else mains.push(p)
    }
  }
})(ROOT)

/** An agent's transcript: the model it ran on, its requests, its cost at list price and on Sonnet. */
function usageOf(file) {
  let model = null
  const calls = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    let m
    try {
      m = JSON.parse(line)
    } catch {
      continue
    }
    const u = m.type === 'assistant' && m.message && m.message.usage
    const id = u && (m.message.id || m.requestId)
    if (!id) continue
    if (m.message.model && m.message.model !== '<synthetic>') model = m.message.model
    calls.set(id, { input: u.input_tokens || 0, read: u.cache_read_input_tokens || 0, write: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0 })
  }
  const fam = family(model)
  if (!fam || !calls.size) return null
  const cost = (p) => [...calls.values()].reduce((s, c) => s + (c.input * p.input + c.read * p.read + c.write * p.write + c.output * p.output) / 1e6, 0)
  return { model, fam, requests: calls.size, cost: cost(PRICES[fam]), asSonnet: cost(PRICES.sonnet), asHaiku: cost(PRICES.haiku) }
}

const usage = new Map()
for (const [id, f] of agents) {
  const u = usageOf(f)
  if (u) usage.set(id, u)
}

// The launching call: the assistant's tool_use gives model asked and type; the result line names the agent.
const launches = [] // { asked, type, ...usage }
for (const f of mains) {
  const inputs = new Map()
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue
    let m
    try {
      m = JSON.parse(line)
    } catch {
      continue
    }
    const c = m.message && m.message.content
    if (!Array.isArray(c)) continue
    if (m.type === 'assistant') {
      for (const b of c) if (b && b.type === 'tool_use' && /^(Agent|Task)$/.test(b.name)) inputs.set(b.id, b.input || {})
    } else if (m.type === 'user' && m.toolUseResult && m.toolUseResult.agentId) {
      const u = usage.get(m.toolUseResult.agentId)
      if (!u || u.seen) continue
      const tr = c.find((b) => b && b.type === 'tool_result')
      const inp = tr && inputs.get(tr.tool_use_id)
      if (!inp) continue
      u.seen = true
      launches.push({ asked: inp.model ? String(inp.model) : null, type: inp.subagent_type || 'general-purpose', ...u })
    }
  }
}

const money = (x) => '$' + x.toFixed(2)
if (!launches.length) {
  console.log(`No subagent launches matched to their call in the last ${DAYS} days under ${ROOT}.`)
} else {
  const without = launches.filter((l) => !l.asked)
  console.log(`Last ${DAYS} days: ${launches.length} subagents matched to the call that launched them; ${without.length} launched without a model.\n`)
  const groups = {}
  for (const l of launches) {
    const k = l.asked ? 'asked: ' + l.asked : 'no model asked'
    const g = groups[k] || (groups[k] = { n: 0, cost: 0, ranOn: {} })
    g.n++
    g.cost += l.cost
    g.ranOn[l.fam] = (g.ranOn[l.fam] || 0) + 1
  }
  console.log('model in the call'.padEnd(22) + 'agents'.padStart(7) + 'cost'.padStart(10) + '   ran on')
  for (const [k, g] of Object.entries(groups).sort((a, b) => b[1].cost - a[1].cost))
    console.log(k.padEnd(22) + String(g.n).padStart(7) + money(g.cost).padStart(10) + '   ' + Object.entries(g.ranOn).map(([f, n]) => f + ' ' + n).join(', '))
  if (without.length) {
    const cost = without.reduce((s, l) => s + l.cost, 0)
    const sonnet = without.reduce((s, l) => s + l.asSonnet, 0)
    const haiku = without.reduce((s, l) => s + l.asHaiku, 0)
    const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]
    console.log(`\nThe ${without.length} without a model: ${money(cost)} on what they inherited, median ${med(without.map((l) => l.requests))} requests each; the same requests on Sonnet ${money(sonnet)}, on Haiku ${money(haiku)}.`)
    console.log('A ceiling: the orchestrator may choose Opus again, and rightly, for design and obscure debugging.')
  }
}

// The hook's log: refused, chosen after, insisted.
try {
  const counts = {}
  const chosen = {}
  for (const line of fs.readFileSync(path.join(os.homedir(), '.claude', 'pugi', 'log.jsonl'), 'utf8').split('\n')) {
    if (!line.includes('"model"')) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (r.hook !== 'model' || Date.parse(r.ts) < SINCE) continue
    counts[r.decision] = (counts[r.decision] || 0) + 1
    if (r.decision === 'chosen') chosen[r.model] = (chosen[r.model] || 0) + 1
  }
  const names = Object.keys(counts)
  if (names.length) {
    console.log('\nThe hook so far: ' + names.map((d) => `${d} ${counts[d]}`).join(', ') + '.')
    if (Object.keys(chosen).length) console.log('Chosen after a refusal: ' + Object.entries(chosen).map(([m, n]) => `${m} ${n}`).join(', ') + '.')
  }
} catch {}
