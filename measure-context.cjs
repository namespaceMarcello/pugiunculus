#!/usr/bin/env node
/**
 * Where the tokens of a Claude Code session actually go.
 *
 *   node measure-context.cjs            the last 7 days of ~/.claude/projects
 *   node measure-context.cjs --days 30
 *   node measure-context.cjs --tools    which tools' results weigh most, and what the big Reads were
 *   node measure-context.cjs --fixed    what is listed to the model on every move and never used: skills, agents, MCP servers
 *   node measure-context.cjs --split    what a request carries, by category: the fixed part, your words, tool results, the model's text, calls and thinking
 *   node measure-context.cjs --agents   what a subagent pays before doing anything, and what they cost together
 *
 * Claude Code sends the whole conversation with every request. This reads your
 * own transcripts and splits what that costs: re-reading the conversation,
 * writing it into the cache, the model's output — and how much of all that is
 * the prompts you typed. Prices are relative (cache read 0.1x input, 5-minute
 * cache write 1.25x, 1-hour write 2x, output 5x). Every current model uses the
 * same ratios, so the shares hold whichever model you run. Interactive sessions
 * only: two typed prompts or more, subagents left out. Nothing leaves your machine.
 *
 * `bench/effort-score.cjs` requires this file for the transcript parsing;
 * running it directly does the measuring.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const args = process.argv.slice(2)
const DAYS = Number(args.includes('--days') ? args[args.indexOf('--days') + 1] : 7)
const HOME = os.homedir()
const ROOT = path.join(HOME, '.claude', 'projects')
const SINCE = Date.now() - DAYS * 864e5
const CHARS_PER_TOKEN = 3.3
const W = { input: 1, read: 0.1, write5m: 1.25, write1h: 2, output: 5 }
const CAPS = [150e3, 250e3, 400e3]
const NOISE = /^\s*(<command-|<local-command|Caveat:|\[Request interrupted|<system-reminder>|<task-notification|<bash-|This session is being continued)/

/** Interactive-session transcripts under `dir` touched since `since` (default: the --days window). */
function transcripts(dir, out = [], since = SINCE) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      // Subagents run in their own context; the benchmarks' sessions (cwd pugi-bench-* and, before the rename, squint-bench-*) are not your work.
      if (e.name !== 'subagents' && !/(?:pugi|squint)-bench/.test(e.name)) transcripts(p, out, since)
    } else if (e.name.endsWith('.jsonl') && !e.name.startsWith('agent-')) {
      try {
        if (fs.statSync(p).mtimeMs >= since) out.push(p)
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

/** Every line of a transcript as an object — or null when it is not an interactive session (two typed prompts or more). */
function messages(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const msgs = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      msgs.push(JSON.parse(line))
    } catch {}
  }
  let prompts = 0
  for (const m of msgs) if (typed(m)) prompts++
  return prompts >= 2 ? msgs : null
}

/** Characters of text in a tool result's content. Images and documents count zero. */
function chars(content) {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) return content.reduce((n, b) => n + (b && typeof b.text === 'string' ? b.text.length : 0), 0)
  return 0
}

/** Every text block of a user message, reminders included. */
function userText(m) {
  const c = m.message && m.message.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
  return ''
}

const k = (c) => Math.round(c / CHARS_PER_TOKEN / 1000) + 'k'
const tok = (c) => Math.round(c / CHARS_PER_TOKEN)
const fmt = (n) => Math.round(n).toLocaleString('en-US')

// ---------------------------------------------------------------------------
// Default: where the cost goes.

function cost() {
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
    return
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
}

// ---------------------------------------------------------------------------
// --tools: which tools' results weigh most, and what the big Reads were.

const BIG = 2000 * CHARS_PER_TOKEN // a result of 2k tokens or more

/** The Pugiunculus log, session -> file key -> the decisions taken on it, to say what a big whole-file Read was. */
function pugiLog() {
  const log = new Map()
  let text
  try {
    text = fs.readFileSync(path.join(HOME, '.claude', 'pugi', 'log.jsonl'), 'utf8')
  } catch {
    return log
  }
  for (const line of text.split('\n')) {
    if (!line) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (!r.file || !r.session) continue
    if (!log.has(r.session)) log.set(r.session, new Map())
    const files = log.get(r.session)
    if (!files.has(r.file)) files.set(r.file, new Set())
    files.get(r.file).add(r.decision)
  }
  return log
}

function readClass(input, files) {
  if (input.offset || input.limit) return 'a slice the agent asked for (offset/limit)'
  const key = path.resolve(input.file_path).split(path.sep).join('/').toLowerCase()
  const d = files && files.get(key)
  if (!d) return 'whole file, the hook did not see it (not installed, or not logging)'
  if (d.has('insisted')) return 'whole file, insisted (asked twice)'
  if (d.has('off')) return 'whole file, hook off'
  if (d.has('small')) return 'whole file, under the threshold'
  return 'whole file, logged as ' + [...d].join('+')
}

function tools() {
  const log = pugiLog()
  const byTool = new Map() // name -> { n, chars, big, bigChars }
  const reads = {} // class -> { n, chars }
  let sessions = 0
  let resultChars = 0
  let modelChars = 0
  for (const file of transcripts(ROOT)) {
    const msgs = messages(file)
    if (!msgs) continue
    sessions++
    const sid = path.basename(file, '.jsonl')
    const uses = new Map() // tool_use id -> the block
    for (const m of msgs) {
      if (m.isSidechain) continue
      const c = m.message && m.message.content
      if (!Array.isArray(c)) continue
      if (m.type === 'assistant') {
        for (const b of c) {
          if (!b) continue
          if (b.type === 'tool_use' && b.id) uses.set(b.id, b)
          else if (typeof b.text === 'string') modelChars += b.text.length
        }
      } else if (m.type === 'user') {
        for (const b of c) {
          if (!b || b.type !== 'tool_result') continue
          const use = uses.get(b.tool_use_id)
          const name = (use && use.name) || '?'
          const n = chars(b.content)
          resultChars += n
          const t = byTool.get(name) || { n: 0, chars: 0, big: 0, bigChars: 0 }
          t.n++
          t.chars += n
          if (n >= BIG) {
            t.big++
            t.bigChars += n
          }
          byTool.set(name, t)
          if (name === 'Read' && n >= BIG && use.input && use.input.file_path) {
            const cls = readClass(use.input, log.get(m.sessionId || sid))
            const r = reads[cls] || (reads[cls] = { n: 0, chars: 0 })
            r.n++
            r.chars += n
          }
        }
      }
    }
  }

  if (!sessions) {
    console.log(`No interactive sessions in the last ${DAYS} days under ${ROOT}.`)
    return
  }
  const pct = (x, of) => (of ? Math.round((100 * x) / of) : 0) + '%'
  const rows = [...byTool.entries()].sort((a, b) => b[1].chars - a[1].chars)
  const nAll = rows.reduce((s, [, t]) => s + t.n, 0)
  const nBig = rows.reduce((s, [, t]) => s + t.big, 0)
  const bigChars = rows.reduce((s, [, t]) => s + t.bigChars, 0)
  console.log(`Last ${DAYS} days: ${sessions} interactive sessions. Tool results ${k(resultChars)} tokens, the model's own text ${k(modelChars)}.`)
  console.log(`Results of 2k tokens or more: ${nBig} of ${nAll}, carrying ${pct(bigChars, resultChars)} of the tool-result tokens.\n`)
  console.log('tool'.padEnd(40) + 'calls'.padStart(7) + 'tokens'.padStart(8) + 'share'.padStart(7) + 'mean'.padStart(6) + '   2k+ (n, tokens)')
  for (const [name, t] of rows.slice(0, 15))
    console.log(
      name.slice(0, 39).padEnd(40) +
        String(t.n).padStart(7) +
        k(t.chars).padStart(8) +
        pct(t.chars, resultChars).padStart(7) +
        String(Math.round(t.chars / t.n / CHARS_PER_TOKEN)).padStart(6) +
        `   ${t.big}, ${k(t.bigChars)}`
    )
  const rr = Object.entries(reads).sort((a, b) => b[1].chars - a[1].chars)
  console.log(`\nRead results of 2k tokens or more, what they were${rr.length ? ':' : ': none.'}`)
  for (const [cls, r] of rr) console.log(String(r.n).padStart(5) + k(r.chars).padStart(7) + '  ' + cls)
}

// ---------------------------------------------------------------------------
// --fixed: what is listed to the model on every move and never used.
//
// At the start of a session the harness lists to the model every skill it can
// invoke, every agent type, the instructions of every MCP server and the names
// of every deferred tool. The listing is in the transcript, so it is measured
// as sent: one line per item, its tokens, and how often the window's sessions
// used it. What a plugin adds goes away when the plugin is disabled; what is
// yours can be removed; the rest is built into Claude Code and stays.

/** "- name: description" lines, a description spanning lines until the next item. */
function bullets(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    if (line.startsWith('- ')) {
      // The name carries its plugin as a prefix ("superpowers:brainstorming"); the description starts after ": ".
      const sep = line.indexOf(': ')
      out.push({ name: sep > 0 ? line.slice(2, sep).trim() : line.slice(2).trim(), chars: line.length + 1 })
    } else if (out.length && line.trim()) out[out.length - 1].chars += line.length + 1
  }
  return out
}

/**
 * What the harness listed to the model in a session, from the attachment
 * records of its transcript: the skills, the agent types, each MCP server's
 * instructions, the deferred tool names, and the context every hook added at
 * session start. Null when the transcript has no skill listing.
 */
function listings(msgs) {
  const out = { when: '', skills: null, agents: [], mcp: [], deferred: [], hooks: new Map(), system: 0, instructions: [] }
  for (const m of msgs) {
    if (m.type !== 'attachment' || !m.attachment) continue
    const a = m.attachment
    if (a.type === 'skill_listing' && typeof a.content === 'string') {
      out.skills = bullets(a.content)
      out.when = m.timestamp || ''
    } else if (a.type === 'prompt_snapshot') {
      out.system = Math.max(out.system, (a.systemPrompt || []).join('').length)
    } else if (a.type === 'instructions') {
      for (const f of a.files || []) out.instructions.push({ name: path.basename(String(f.path || '?')), chars: String(f.content || '').length })
    } else if (a.type === 'agent_listing_delta') {
      for (const line of a.addedLines || []) out.agents.push(...bullets(line))
    } else if (a.type === 'mcp_instructions_delta') {
      const blocks = a.addedBlocks || []
      ;(a.addedNames || []).forEach((name, i) => out.mcp.push({ name, chars: String(blocks[i] || '').length }))
    } else if (a.type === 'deferred_tools_delta') {
      out.deferred.push(...(a.addedNames || []))
    } else if (a.type === 'hook_additional_context' && a.hookName) {
      const chars = Array.isArray(a.content) ? a.content.join('\n').length : String(a.content || '').length
      out.hooks.set(a.hookName, (out.hooks.get(a.hookName) || 0) + chars)
    }
  }
  return out.skills ? out : null
}

/** How often each skill, typed command, agent type and MCP server appears in the window's interactive sessions. */
function uses() {
  const calls = new Map() // 'kind:name' -> count
  const bump = (id) => calls.set(id, (calls.get(id) || 0) + 1)
  let sessions = 0
  let latest = null
  for (const file of transcripts(ROOT)) {
    const msgs = messages(file)
    if (!msgs) continue
    sessions++
    const l = listings(msgs)
    if (l && (!latest || l.when > latest.when)) latest = l
    for (const m of msgs) {
      if (m.isSidechain) continue
      const c = m.message && m.message.content
      if (m.type === 'assistant' && Array.isArray(c)) {
        for (const b of c) {
          if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') continue
          if (b.name === 'Skill' && b.input && b.input.skill) bump('skill:' + b.input.skill)
          else if (b.name === 'Agent' && b.input && b.input.subagent_type) bump('agent:' + b.input.subagent_type)
          else if (b.name.startsWith('mcp__')) bump('mcp:' + b.name.split('__')[1])
        }
      } else if (m.type === 'user') {
        const cm = /<command-name>\/([^<]+)<\/command-name>/.exec(userText(m))
        if (cm) bump('skill:' + cm[1])
      }
    }
  }
  return { calls, sessions, latest }
}

function fixed() {
  const { calls, sessions, latest } = uses()
  if (!sessions) {
    console.log(`No interactive sessions in the last ${DAYS} days under ${ROOT}.`)
    return
  }
  if (!latest) {
    console.log(`Last ${DAYS} days: ${sessions} interactive sessions, none carrying the harness listings in its transcript.`)
    return
  }

  let enabled = {}
  try {
    enabled = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8')).enabledPlugins || {}
  } catch {}
  const plugins = new Set(Object.keys(enabled).filter((key) => enabled[key]).map((key) => key.split('@')[0]))
  const mine = (name) =>
    fs.existsSync(path.join(HOME, '.claude', 'skills', name, 'SKILL.md')) || fs.existsSync(path.join(HOME, '.claude', 'commands', name + '.md'))
  const short = (name) => name.slice(name.lastIndexOf(':') + 1)

  // A skill is used when a Skill call or a typed slash command names it, with or without its plugin prefix.
  for (const s of latest.skills) {
    s.n = 0
    for (const [id, n] of calls) {
      if (!id.startsWith('skill:')) continue
      const ref = id.slice(6)
      if (ref === s.name || ref === short(s.name) || short(ref) === short(s.name)) s.n += n
    }
    const prefix = s.name.includes(':') ? s.name.slice(0, s.name.indexOf(':')) : null
    s.group = prefix && plugins.has(prefix) ? prefix + ' (plugin)' : mine(s.name) ? 'yours' : 'built in'
  }
  for (const a of latest.agents) a.n = calls.get('agent:' + a.name) || 0
  const servers = new Map() // name as the tool prefix -> { instructions, names, tools, n }
  const slug = (name) => name.replace(/[^A-Za-z0-9_-]/g, '_')
  for (const s of latest.mcp) servers.set(slug(s.name), { name: s.name, instructions: s.chars, names: 0, tools: 0, n: 0 })
  let builtinDeferred = 0
  for (const t of latest.deferred) {
    const m = /^mcp__(.+?)__/.exec(t)
    if (!m) {
      builtinDeferred += t.length + 1
      continue
    }
    if (!servers.has(m[1])) servers.set(m[1], { name: m[1], instructions: 0, names: 0, tools: 0, n: 0 })
    const s = servers.get(m[1])
    s.names += t.length + 1
    s.tools++
  }
  for (const [id, n] of calls) if (id.startsWith('mcp:') && servers.has(id.slice(4))) servers.get(id.slice(4)).n += n

  const total = latest.skills.reduce((s, x) => s + x.chars, 0)
  const idle = latest.skills.filter((x) => !x.n)
  const idleChars = idle.reduce((s, x) => s + x.chars, 0)
  console.log(`Last ${DAYS} days: ${sessions} interactive sessions. Listing as sent at the start of the most recent one (${latest.when.slice(0, 10)}); use counted over the whole window.\n`)
  if (latest.system) console.log(`System prompt as sent, before any tool definition: ~${fmt(tok(latest.system))} tokens on every move. Built in.`)
  if (latest.instructions.length)
    console.log(
      `Instructions loaded with it: ~${fmt(tok(latest.instructions.reduce((s, f) => s + f.chars, 0)))} tokens (${latest.instructions.map((f) => `${f.name} ${fmt(tok(f.chars))}`).join(', ')}). Yours.`
    )
  console.log(`\nSkills listed on every move: ${latest.skills.length}, ~${fmt(tok(total))} tokens; ~${fmt(tok(idleChars))} of it for the ${idle.length} never used.\n`)

  const groups = new Map()
  for (const s of latest.skills) {
    if (!groups.has(s.group)) groups.set(s.group, [])
    groups.get(s.group).push(s)
  }
  const idleOf = (xs) => xs.filter((x) => !x.n).reduce((sum, x) => sum + x.chars, 0)
  const rows = [...groups.entries()].sort((a, b) => idleOf(b[1]) - idleOf(a[1]))
  console.log('group'.padEnd(30) + 'items'.padStart(6) + 'tokens/move'.padStart(13) + '   never used (n, tokens)   used (calls)')
  for (const [g, xs] of rows) {
    const off = xs.filter((x) => !x.n)
    const on = xs.filter((x) => x.n).sort((a, b) => b.n - a.n)
    console.log(
      g.padEnd(30) +
        String(xs.length).padStart(6) +
        fmt(tok(xs.reduce((s, x) => s + x.chars, 0))).padStart(13) +
        `   ${off.length} (${fmt(tok(idleOf(xs)))})`.padEnd(28) +
        on.map((x) => `${x.name} ×${x.n}`).join(', ')
    )
  }
  const switchable = rows.filter(([g]) => g !== 'built in')
  if (switchable.some(([, xs]) => xs.some((x) => !x.n))) {
    console.log('\nnever used, and yours to switch off:')
    for (const [g, xs] of switchable) {
      const off = xs.filter((x) => !x.n)
      if (off.length) console.log('  ' + g.padEnd(28) + off.map((x) => short(x.name)).join(', '))
    }
  }

  if (latest.agents.length) {
    const used = latest.agents.filter((a) => a.n).sort((a, b) => b.n - a.n)
    console.log(
      `\nAgent types listed: ${latest.agents.length}, ~${fmt(tok(latest.agents.reduce((s, a) => s + a.chars, 0)))} tokens/move` +
        (used.length ? `; used: ${used.map((a) => `${a.name} ×${a.n}`).join(', ')}.` : '; none used.')
    )
  }
  if (servers.size) {
    const list = [...servers.values()].sort((a, b) => b.instructions + b.names - (a.instructions + a.names))
    console.log(`\nMCP servers: instructions ~${fmt(tok(list.reduce((s, x) => s + x.instructions, 0)))} tokens/move, deferred tool names ~${fmt(tok(list.reduce((s, x) => s + x.names, 0)))} tokens/move.`)
    console.log('  server'.padEnd(40) + 'instructions'.padStart(13) + 'tools'.padStart(7) + 'names'.padStart(7) + '   calls')
    for (const s of list)
      console.log('  ' + s.name.slice(0, 37).padEnd(38) + fmt(tok(s.instructions)).padStart(13) + String(s.tools).padStart(7) + fmt(tok(s.names)).padStart(7) + `   ${s.n || 'never'}`)
    console.log('  A deferred tool costs its name until it is loaded; a tool that is not deferred costs its whole schema, which the transcript does not show.')
  }
  if (builtinDeferred) console.log(`\nBuilt-in deferred tools, names only: ~${fmt(tok(builtinDeferred))} tokens/move. Built-in items cannot be switched off.`)
  if (latest.hooks.size)
    console.log(
      '\nContext added by hooks at session start, carried on every move after: ' +
        [...latest.hooks.entries()].sort((a, b) => b[1] - a[1]).map(([h, c]) => `${h} ~${fmt(tok(c))} tokens`).join(', ') +
        '.'
    )
}

// ---------------------------------------------------------------------------
// --split: what a request carries, by category.
//
// Everything a session sent is in its transcript except the schemas of the
// tools loaded at startup and the model's thinking, which is stored empty. Two
// views: what the last request of each session carried, and what was re-read
// across all its requests — a piece that entered after request i is sent again
// by every request after it, so the fixed part weighs every move and a late
// tool result a few. The gap between the sum and what the API billed is what
// the transcript does not show.

const CATEGORIES = [
  ['fixed', 'fixed at session start: system prompt, tool schemas, CLAUDE.md, memory, skills, MCP'],
  ['carried', 'carried over from an earlier session (resumed or continued)'],
  ['typed', 'your words'],
  ['results', 'tool results'],
  ['text', "the model's text"],
  ['calls', "the model's tool calls, Edit and Write contents included"],
  ['thinking', "the model's thinking (billed output minus its visible text and calls)"],
  ['reminders', 'harness reminders and hook notes during the session'],
  ['summary', 'compaction summaries'],
]

function split() {
  const end = {}
  const reread = {}
  for (const [c] of CATEGORIES) {
    end[c] = 0
    reread[c] = 0
  }
  let sessions = 0
  let requests = 0
  let actualEnd = 0
  let actualReread = 0
  const finals = []
  const firsts = [] // { first: the first request's billed context, total: requests in the session }
  const T = (n) => n / CHARS_PER_TOKEN
  for (const file of transcripts(ROOT)) {
    const msgs = messages(file)
    if (!msgs) continue
    // The requests in order: the final usage of each (streaming writes one line per block; the last carries it) and its visible output.
    const index = new Map()
    const reqs = []
    for (const m of msgs) {
      if (m.isSidechain) continue
      const u = m.type === 'assistant' && m.message && m.message.usage
      const id = u && (m.message.id || m.requestId)
      if (!id) continue
      if (!index.has(id)) {
        index.set(id, reqs.length)
        reqs.push({ u, visible: 0 })
      }
      const r = reqs[index.get(id)]
      r.u = u
      const c = m.message.content
      if (Array.isArray(c))
        for (const b of c) {
          if (!b) continue
          if (b.type === 'text') r.visible += (b.text || '').length
          else if (b.type === 'tool_use') r.visible += JSON.stringify(b.input || {}).length + (b.name || '').length
        }
    }
    const total = reqs.length
    if (!total) continue
    sessions++
    requests += total
    const ctx = (u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
    actualEnd += ctx(reqs[total - 1].u)
    finals.push(ctx(reqs[total - 1].u))
    for (const r of reqs) actualReread += ctx(r.u)

    // A piece that entered after `at` requests is carried by the remaining total - at. Amounts in tokens.
    const add = (c, tokens, at) => {
      end[c] += tokens
      reread[c] += tokens * Math.max(0, total - at)
    }
    // The transcript stores thinking empty; what the API billed as output beyond the visible text and calls is the thinking, and it stays in the context.
    reqs.forEach((r, i) => add('thinking', Math.max(0, (r.u.output_tokens || 0) - T(r.visible)), i + 1))
    // Everything the first request carried is the fixed part — the system prompt and tool schemas the transcript never
    // records, and what was loaded at startup. It travels on every request of the session. Attributed after the loop.
    firsts.push({ first: ctx(reqs[0].u), total })

    let at = 0
    const seen = new Set()
    for (const m of msgs) {
      if (m.isSidechain || m.type === 'attachment') continue
      const c = m.message && m.message.content
      if (m.type === 'assistant') {
        const id = m.message && m.message.usage && (m.message.id || m.requestId)
        if (id && !seen.has(id)) {
          seen.add(id)
          at++
        }
        if (!Array.isArray(c)) continue
        for (const b of c) {
          if (!b) continue
          if (b.type === 'text') add('text', T((b.text || '').length), at)
          else if (b.type === 'tool_use') add('calls', T(JSON.stringify(b.input || {}).length + (b.name || '').length), at)
        }
      } else if (m.type === 'user' && at > 0) {
        // Before the first request everything is inside the fixed part above.
        if (m.isCompactSummary) {
          add('summary', T(userText(m).length), at)
          continue
        }
        if (typeof c === 'string') {
          add(m.isMeta || NOISE.test(c) ? 'reminders' : 'typed', T(c.length), at)
          continue
        }
        if (!Array.isArray(c)) continue
        const hasResult = c.some((b) => b && b.type === 'tool_result')
        for (const b of c) {
          if (!b) continue
          if (b.type === 'tool_result') add('results', T(chars(b.content)), at)
          else if (b.type === 'text') add(hasResult || m.isMeta || NOISE.test(b.text || '') ? 'reminders' : 'typed', T((b.text || '').length), at)
        }
      }
    }
  }

  if (!sessions) {
    console.log(`No interactive sessions in the last ${DAYS} days under ${ROOT}.`)
    return
  }
  // A session whose first request already carried more than twice the typical fixed part started on an earlier
  // conversation (resumed or continued): the typical part is fixed, the rest was carried over.
  const typical = firsts.length ? firsts.map((f) => f.first).sort((a, b) => a - b)[Math.floor(firsts.length / 2)] : 0
  for (const f of firsts) {
    const fixed = f.first > 2 * typical ? typical : f.first
    end.fixed += fixed
    reread.fixed += fixed * f.total
    end.carried += f.first - fixed
    reread.carried += (f.first - fixed) * f.total
  }
  const kt = (t) => Math.round(t / 1000) + 'k'
  const sumEnd = Object.values(end).reduce((s, x) => s + x, 0)
  const sumReread = Object.values(reread).reduce((s, x) => s + x, 0)
  const pct = (x, of) => (of ? Math.round((100 * x) / of) : 0) + '%'
  finals.sort((a, b) => a - b)
  const resumed = firsts.filter((f) => f.first > 2 * typical).length
  console.log(`Last ${DAYS} days: ${sessions} interactive sessions, ${requests} requests. Median context at the end of a session: ${kt(finals[Math.floor(finals.length / 2)])} tokens.`)
  console.log(`Typical fixed part, from the first request of a fresh session: ${kt(typical)} tokens; ${resumed} of ${sessions} sessions started on an earlier conversation instead.\n`)
  console.log('category'.padEnd(78) + 'at the end'.padStart(11) + 'share'.padStart(7) + 're-read'.padStart(10) + 'share'.padStart(7))
  for (const [c, label] of CATEGORIES) console.log(label.padEnd(78) + kt(end[c]).padStart(11) + pct(end[c], actualEnd).padStart(7) + kt(reread[c]).padStart(10) + pct(reread[c], actualReread).padStart(7))
  const gapEnd = actualEnd - sumEnd
  const gapReread = actualReread - sumReread
  console.log('not accounted for: images, message framing, the estimate\'s error'.padEnd(78) + kt(gapEnd).padStart(11) + pct(gapEnd, actualEnd).padStart(7) + kt(gapReread).padStart(10) + pct(gapReread, actualReread).padStart(7))
  console.log('what the API billed as context'.padEnd(78) + kt(actualEnd).padStart(11) + '100%'.padStart(7) + kt(actualReread).padStart(10) + '100%'.padStart(7))
  console.log(
    '\n"At the end": summed over the last request of every session. "Re-read": summed over every request, each piece counted once per request that carried it.\nText at 3.3 characters per token; thinking from the billed output tokens; the gap absorbs the estimate\'s error too.'
  )
}

// ---------------------------------------------------------------------------
// --agents: what a subagent pays before doing anything.
//
// A subagent starts a conversation of its own: system prompt, tool schemas,
// and whatever its type loads. Its first request is that price, paid before a
// single file is read. The transcripts under subagents/ carry the usage.

function subagentTranscripts(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!e.name.includes('pugi-bench')) subagentTranscripts(p, out)
    } else if (e.name.startsWith('agent-') && e.name.endsWith('.jsonl')) {
      try {
        if (fs.statSync(p).mtimeMs >= SINCE) out.push(p)
      } catch {}
    }
  }
  return out
}

const ktok = (t) => Math.round(t / 1000) + 'k'
const ctxOf = (u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)

function agents() {
  const rows = []
  for (const file of subagentTranscripts(ROOT)) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const index = new Map()
    const reqs = []
    for (const line of text.split('\n')) {
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
      if (!index.has(id)) {
        index.set(id, reqs.length)
        reqs.push(u)
      } else reqs[index.get(id)] = u
    }
    if (!reqs.length) continue
    rows.push({ first: ctxOf(reqs[0]), requests: reqs.length, total: reqs.reduce((s, u) => s + ctxOf(u), 0), output: reqs.reduce((s, u) => s + (u.output_tokens || 0), 0) })
  }
  if (!rows.length) {
    console.log(`No subagent transcripts in the last ${DAYS} days under ${ROOT}.`)
    return
  }
  const sorted = rows.map((r) => r.first).sort((a, b) => a - b)
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  const lean = rows.filter((r) => r.first < 15e3).length
  const reqMedian = rows.map((r) => r.requests).sort((a, b) => a - b)[Math.floor(rows.length / 2)]
  console.log(`Last ${DAYS} days: ${rows.length} subagents.`)
  console.log(`What one pays before doing anything, its first request with system prompt and tool schemas: median ${ktok(q(0.5))}, 90th percentile ${ktok(q(0.9))} tokens; ${lean} of ${rows.length} started under 15k, as a lean reader does.`)
  console.log(`All of them together: ${ktok(rows.reduce((s, r) => s + r.total, 0))} tokens of context sent, ${ktok(rows.reduce((s, r) => s + r.output, 0))} of output; ${reqMedian} requests per agent, median.`)
  console.log('The first request is paid once per agent. Its fixed part is cached across agents of the same type for the subagent cache TTL: five minutes by default, an hour with subagentPromptCacheTtl "1h".')
}

module.exports = { transcripts, typed, messages, chars, CHARS_PER_TOKEN, W, DAYS, ROOT, HOME }

if (require.main === module) {
  if (args.includes('--tools')) tools()
  else if (args.includes('--fixed')) fixed()
  else if (args.includes('--split')) split()
  else if (args.includes('--agents')) agents()
  else cost()
}
