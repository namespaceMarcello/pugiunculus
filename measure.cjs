#!/usr/bin/env node
/**
 * squint measure — run this BEFORE installing anything.
 *
 * It reads your own Claude Code transcripts (~/.claude/projects) and replays
 * what squint would have done. No API calls, nothing leaves your machine,
 * nothing is written except an optional JSON summary.
 *
 * Usage:
 *   node measure.cjs                 replay at the default 8 KB threshold
 *   node measure.cjs --sweep         compare 4 / 8 / 16 / 32 / 64 KB
 *   node measure.cjs --json out.json also write the numbers to a file
 *
 * Caveat, stated up front: Read truncates its result around 16k tokens, so this
 * replay uses result size as a stand-in for file size. It therefore UNDERSTATES
 * how often squint would fire on very large files.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const readline = require('node:readline')

const ROOT = path.join(os.homedir(), '.claude', 'projects')
const args = process.argv.slice(2)
const SWEEP = args.includes('--sweep')
const JSON_OUT = args.includes('--json') ? args[args.indexOf('--json') + 1] : null
const THRESHOLDS_KB = SWEEP ? [4, 8, 16, 32, 64] : [8]

function walk(dir, acc = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (e.name.endsWith('.jsonl')) acc.push(p)
  }
  return acc
}

/** One pass over the logs; every threshold is then simulated in memory. */
const sessions = []

function collect(file) {
  return new Promise((res) => {
    const reads = []
    const pending = {}
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    rl.on('line', (line) => {
      if (!line) return
      let o
      try {
        o = JSON.parse(line)
      } catch {
        return
      }
      const content = o?.message?.content
      if (!Array.isArray(content)) return
      for (const item of content) {
        if (item.type === 'tool_use' && item.name === 'Read') {
          const i = item.input || {}
          const f = String(i.file_path || '').replace(/\\/g, '/').toLowerCase()
          if (!f) continue
          const ev = { f, slice: !!(i.offset || i.limit), tokens: 0 }
          pending[item.id] = ev
          reads.push(ev)
        } else if (item.type === 'tool_result') {
          const ev = pending[item.tool_use_id]
          if (!ev) continue
          const c = item.content
          const text =
            typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('\n') : ''
          ev.tokens = Math.ceil(text.length / 4)
          delete pending[item.tool_use_id]
        }
      }
    })
    rl.on('close', () => {
      if (reads.length) sessions.push(reads)
      res()
    })
  })
}

function simulate(thresholdTokens) {
  let blocked = 0
  let tokensAtStake = 0
  let reads = 0
  let slices = 0
  const perSession = []
  for (const list of sessions) {
    const seen = {}
    let n = 0
    for (const ev of list) {
      reads++
      if (ev.slice) {
        slices++
        continue
      }
      if (ev.tokens <= thresholdTokens) continue
      if ((seen[ev.f] || 0) >= 1) {
        seen[ev.f] = 0 // insisted: squint lets it through
        continue
      }
      seen[ev.f] = 1
      blocked++
      tokensAtStake += ev.tokens
      n++
    }
    if (n) perSession.push(n)
  }
  perSession.sort((a, b) => a - b)
  const q = (p) => (perSession.length ? perSession[Math.floor(perSession.length * p)] || 0 : 0)
  return {
    reads,
    slices,
    blocked,
    tokensAtStake,
    sessionsTouched: perSession.length,
    median: q(0.5),
    p90: q(0.9),
    worst: perSession[perSession.length - 1] || 0,
  }
}

;(async () => {
  if (!fs.existsSync(ROOT)) {
    console.log('No Claude Code transcripts found at ' + ROOT)
    console.log('Nothing to measure. Use Claude Code for a while, then run this again.')
    process.exit(0)
  }
  const files = walk(ROOT)
  process.stdout.write('reading ' + files.length + ' transcripts... ')
  const t0 = Date.now()
  for (const f of files) {
    try {
      await collect(f)
    } catch {}
  }
  console.log(((Date.now() - t0) / 1000).toFixed(1) + 's\n')

  const results = {}
  for (const kb of THRESHOLDS_KB) results[kb] = simulate(kb * 250)

  const main = results[THRESHOLDS_KB.includes(8) ? 8 : THRESHOLDS_KB[0]]
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '0%')

  if (SWEEP) {
    console.log('threshold   blocked   tokens at stake   share of reads   blocks/session (med · p90 · worst)')
    for (const kb of THRESHOLDS_KB) {
      const r = results[kb]
      console.log(
        String(kb + ' KB').padEnd(12) +
          String(r.blocked).padStart(7) +
          String(r.tokensAtStake.toLocaleString('en-US')).padStart(18) +
          String(pct(r.blocked, r.reads)).padStart(17) +
          String(`${r.median} · ${r.p90} · ${r.worst}`).padStart(36)
      )
    }
    console.log('\nPick the knee: the threshold that keeps most of the tokens for the fewest blocks.')
  } else {
    console.log('YOUR HISTORY, REPLAYED')
    console.log('  Read calls                 ' + main.reads)
    console.log('  already sliced             ' + main.slices + '  (' + pct(main.slices, main.reads) + ')')
    console.log('  squint would have blocked  ' + main.blocked + '  (' + pct(main.blocked, main.reads) + ')')
    console.log('  tokens at stake            ' + main.tokensAtStake.toLocaleString('en-US'))
    console.log('')
    console.log('FRICTION — what it would have cost you')
    console.log('  sessions with >=1 block    ' + main.sessionsTouched)
    console.log('  blocks per session         median ' + main.median + ' · p90 ' + main.p90 + ' · worst ' + main.worst)
    console.log('')
    const perBlock = main.blocked ? Math.round(main.tokensAtStake / main.blocked) : 0
    const costOfABlock = 85 // the refusal message
    if (perBlock) {
      const breakeven = ((100 * costOfABlock) / perBlock).toFixed(2)
      console.log('THE TRADE')
      console.log('  a blocked read is worth    ' + perBlock.toLocaleString('en-US') + ' tokens')
      console.log('  a pointless block costs    ' + costOfABlock + ' tokens (the refusal, then you read it anyway)')
      console.log('  => squint pays for itself if it is right more than ' + breakeven + '% of the time')
    }
    console.log('')
    console.log('Run with --sweep to tune the threshold to your own habits.')
  }

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ generated: new Date().toISOString(), results }, null, 2))
    console.log('\nwrote ' + JSON_OUT)
  }
})()
