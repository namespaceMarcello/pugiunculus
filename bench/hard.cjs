#!/usr/bin/env node
/**
 * bench/hard.cjs — does pugi change what the model gets RIGHT, not only what it costs?
 *
 * The README's read benchmark asks for one literal in one file: a lookup. This
 * one asks questions that need a chain — find a function, read its body and the
 * file's imports, then follow one name into another file — because that is
 * where a cheap model is said to "lose the thread", and where a whole-file Read
 * of an 80 KB file silently truncates the half that held the answer.
 *
 * Two question classes, both generated from source, never written by hand:
 *   A  function G in file F calls exactly one function defined in another file.
 *      Where is it defined?                       answer: path:LINE
 *   B  function G in file F uses exactly one constant imported from another
 *      file. What literal is it assigned there?   answer: the literal
 *
 * Each group of questions goes to a fresh headless session; the control arm
 * differs in one thing only, PUGI_OFF=1, which keeps the hooks logging.
 *
 *   node bench/hard.cjs --src <codebase> --model haiku            # pugi on
 *   node bench/hard.cjs --src <codebase> --model haiku --off      # pugi off
 *   node bench/hard.cjs --list --src <codebase>                   # print the questions
 *   node bench/hard.cjs --report                                  # the table
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

const argv = process.argv.slice(2)
const opt = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def
}
const flag = (name) => argv.includes('--' + name)
const LOG = path.join(os.homedir(), '.claude', 'pugi', 'log.jsonl')
const OUT = opt('out', path.join(__dirname, 'hard-results.jsonl'))

// ------------------------------------------------------------------ report

function report() {
  // Every arm writes its own file (--out), so two arms can run at once; the report reads them all.
  const files = argv.includes('--out') ? [OUT] : fs.readdirSync(__dirname).filter((f) => /^hard-results.*\.jsonl$/.test(f)).map((f) => path.join(__dirname, f))
  const rows = files
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => !r.error)
  const arms = {}
  const count = (r, re) => Object.entries(r.decisions || {}).filter(([k]) => re.test(k)).reduce((a, [, v]) => a + v, 0)
  for (const r of rows) {
    const k = `${r.model} | ${r.per || r.total} per session | ${r.off ? 'off' : 'on'}`
    const a = (arms[k] = arms[k] || { n: 0, correct: 0, total: 0, A: [0, 0], B: [0, 0], near: 0, tokens: 0, cost: 0, ms: 0, blocked: 0, insisted: 0, wholeOff: 0, turns: 0, groups: {} })
    // With PUGI_OFF the hooks still log every whole-file read they would have refused, as `off`.
    a.wholeOff += count(r, /:off$/)
    // Agent is not in --allowedTools, but spawning needs no permission, so some sessions delegate;
    // their subagents' tokens are in the total and inherit the same hooks and the same PUGI_OFF.
    if (Object.keys(r.decisions || {}).some((k) => k.startsWith('Agent:'))) a.delegated = (a.delegated || 0) + 1
    a.n++
    a.correct += r.correct
    a.total += r.total
    a.near += r.nearA || 0
    for (const d of r.answers) {
      a[d.cls][1]++
      if (d.ok) a[d.cls][0]++
    }
    a.tokens += r.tokens
    a.cost += r.cost
    a.ms += r.durationMs
    a.turns += r.turns || 0
    a.blocked += r.blocked || 0
    a.insisted += r.insisted || 0
    const g = (a.groups[r.group] = a.groups[r.group] || { sum: 0, n: 0 })
    g.sum += r.correct
    g.n++
  }
  const pct = (c, t) => (t ? ((100 * c) / t).toFixed(0) + '%' : '-')
  console.log('arm | sessions | correct | A (callee) | B (const) | tokens/session | $/session | min/session | whole-file reads: blocked / insisted / let through (off) | sessions that delegated')
  console.log('---|---|---|---|---|---|---|---|---|---')
  for (const [k, a] of Object.entries(arms).sort()) {
    console.log(
      `${k} | ${a.n} | ${a.correct}/${a.total} (${pct(a.correct, a.total)}) | ${a.A[0]}/${a.A[1]} | ${a.B[0]}/${a.B[1]} | ${Math.round(a.tokens / a.n).toLocaleString('en')} | ${(a.cost / a.n).toFixed(3)} | ${(a.ms / a.n / 60000).toFixed(1)} | ${a.blocked} / ${a.insisted} / ${a.wholeOff} | ${a.delegated || 0}`
    )
  }
  // Paired by group: same questions, hook on vs off.
  const shapes = [...new Set(rows.map((r) => `${r.model} | ${r.per || r.total} per session`))]
  for (const m of shapes) {
    const on = arms[m + ' | on']
    const off = arms[m + ' | off']
    if (!on || !off) continue
    let better = 0,
      worse = 0,
      same = 0
    const mean = (g) => g.sum / g.n
    const detail = []
    for (const g of Object.keys(on.groups)) {
      if (!(g in off.groups)) continue
      const a = mean(on.groups[g])
      const b = mean(off.groups[g])
      detail.push(`group ${Number(g) + 1}: on ${a.toFixed(1)} vs off ${b.toFixed(1)} (${on.groups[g].n}+${off.groups[g].n} runs)`)
      if (a > b) better++
      else if (a < b) worse++
      else same++
    }
    console.log(`\n${m}, paired by group (same questions, mean correct per run): pugi on was more correct in ${better}, less in ${worse}, equal in ${same}.\n  ${detail.join('\n  ')}`)
  }
  // Class A answers that hit the right file but the wrong line.
  const wrongLine = rows.flatMap((r) => r.answers.filter((d) => d.cls === 'A' && !d.ok && d.fileOk).map((d) => `${r.model}${r.off ? ' off' : ' on'}: expected ${d.expected}, got ${d.got}`))
  if (wrongLine.length) console.log('\nClass A, right file, wrong line:\n  ' + wrongLine.join('\n  '))
}

if (flag('report')) {
  report()
  process.exit(0)
}

// --------------------------------------------------------------- questions

const SRC = opt('src')
if (!SRC) {
  console.error('need --src <path to a TypeScript codebase> (or --report)')
  process.exit(1)
}
const MODEL = opt('model', 'haiku')
const OFF = flag('off')
const GROUPS = Number(opt('groups', 10))
const PER = Number(opt('per', 5))
const REPS = Number(opt('reps', 1))
const PARALLEL = Number(opt('parallel', 3))
const CLAUDE = opt('claude', process.platform === 'win32' ? 'claude.exe' : 'claude')
const MIN_BYTES = Number(opt('min-bytes', 12000))

function tsFiles(d, acc = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && !e.name.startsWith('.')) tsFiles(p, acc)
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) acc.push(p)
  }
  return acc
}

const FILES = tsFiles(SRC).map((abs) => {
  const raw = fs.readFileSync(abs, 'utf8')
  // CRLF would leave a `\r` at the end of every line, and `(.+?)$` never matches it.
  return { abs, rel: path.relative(SRC, abs).split('\\').join('/'), text: raw.replace(/\r\n/g, '\n'), bytes: Buffer.byteLength(raw) }
})
const BY_REL = Object.fromEntries(FILES.map((f) => [f.rel, f]))

/** Comments blanked, line count preserved, so scans do not see prose. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

/** Named imports: local name -> the file it resolves to (relative), or null if not a local .ts file.
 *  Namespace imports (`import * as P`) come back under `ns`, so a body that calls `P.x()` can be skipped. */
function imports(file) {
  const out = { ns: [] }
  const resolve = (spec) => {
    if (!spec.startsWith('.')) return null
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file.rel), spec))
    return BY_REL[base + '.ts'] ? base + '.ts' : BY_REL[base + '/index.ts'] ? base + '/index.ts' : null
  }
  for (const m of file.text.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/gm)) {
    if (m[1]) continue
    const target = resolve(m[3])
    for (let name of m[2].split(',')) {
      name = name.trim()
      if (!name || name.startsWith('type ')) continue
      const as = name.match(/^(\w+)\s+as\s+(\w+)$/)
      out[as ? as[2] : name] = target
    }
  }
  for (const m of file.text.matchAll(/^import\s+\*\s+as\s+(\w+)\s+from/gm)) out.ns.push(m[1])
  return out
}

/** Top-level function declarations with a body: the lines up to the first `}` at column 0. */
function functions(file) {
  const lines = stripComments(file.text).split('\n')
  const out = []
  lines.forEach((line, i) => {
    const m = line.match(/^(?:export )?(?:async )?function (\w+)\(/)
    if (!m) return
    let end = i
    for (let j = i; j < lines.length; j++) {
      if (j > i && /^(?:export )?(?:async )?(?:function|const|let|var|class|interface|type|enum|import|export)\b/.test(lines[j])) break
      end = j
      if (/^\}/.test(lines[j])) break
    }
    out.push({ name: m[1], line: i + 1, body: lines.slice(i, end + 1).join('\n') })
  })
  return out
}

// Where each name is declared at top level, across the project.
const DECLS = {}
for (const f of FILES) {
  f.text.split('\n').forEach((line, i) => {
    const m = line.match(/^(?:export )?(?:async )?(?:function|const|let|var|class|enum) (\w+)\b/)
    if (m) (DECLS[m[1]] = DECLS[m[1]] || []).push({ file: f.rel, line: i + 1, text: line })
  })
}
const uniqueDecl = (name) => (DECLS[name] || []).length === 1 && DECLS[name][0]
const LITERAL = /^(-?\d+(\.\d+)?( ?\/ ?\d+(\.\d+)?)?|'[^']{1,30}'|true|false)$/

const STAGES = {}
const stage = (k) => (STAGES[k] = (STAGES[k] || 0) + 1)

function questions() {
  const A = []
  const B = []
  for (const f of FILES) {
    if (f.bytes < MIN_BYTES) continue
    const { ns, ...imp } = imports(f)
    const names = Object.keys(imp)
    for (const g of functions(f)) {
      if (!uniqueDecl(g.name)) continue
      stage('functions in big files')
      // A body that calls a method on an imported object or namespace (`P.ciotola()`,
      // `scene.add()`) is skipped: whether that counts as "a function defined in another
      // file" is a judgement call, and the question must not have one.
      if ([...names, ...ns].some((n) => new RegExp('(?<![.\\w$])' + n + '\\.\\w+\\(').test(g.body))) {
        stage('skipped: method call on an import')
        continue
      }
      // A: exactly one imported name is called in the body.
      const called = names.filter((n) => new RegExp('(?<!new\\s)(?<![.\\w$])' + n + '\\(').test(g.body))
      if (called.length === 1 && imp[called[0]]) {
        const h = called[0]
        const d = uniqueDecl(h)
        if (d && d.file === imp[h] && d.file !== f.rel && /^(?:export )?(?:async )?function /.test(d.text)) {
          A.push({ cls: 'A', file: f.rel, fn: g.name, fnLine: g.line, target: h, value: d.file + ':' + d.line })
        } else stage('A dropped: callee not a unique top-level function in the imported file')
      }
      // B: exactly one imported UPPER_CASE constant is used in the body.
      const used = names.filter((n) => /^[A-Z][A-Z0-9_]{2,}$/.test(n) && new RegExp('(?<![.\\w$])' + n + '\\b(?!\\()').test(g.body))
      if (used.length === 1 && imp[used[0]]) {
        stage('B: one imported constant used')
        const c = used[0]
        const d = uniqueDecl(c)
        if (!d) stage('B dropped: name declared more than once')
        else if (d.file !== imp[c]) stage('B dropped: declared elsewhere than the import says')
        const m = d && d.file === imp[c] && d.file !== f.rel && d.text.match(/^(?:export )?const \w+ = (.+?)$/)
        if (m) {
          const value = m[1].replace(/\s*(\/\/.*)?$/, '').replace(/;$/, '').trim()
          if (LITERAL.test(value)) B.push({ cls: 'B', file: f.rel, fn: g.name, fnLine: g.line, target: c, value })
          else stage('B dropped: not a simple literal')
        }
      }
    }
  }
  let s = 12345
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return arr
  }
  // At most two questions per source file per class, and each answer only once, so
  // one file cannot carry the result and no answer can be reused inside a group.
  const spread = (arr) => {
    const perFile = {}
    const perAnswer = {}
    const key = (q) => (q.cls === 'A' ? q.value : q.target)
    return shuffle(arr).filter((q) => (perFile[q.file] = (perFile[q.file] || 0) + 1) <= 2 && (perAnswer[key(q)] = (perAnswer[key(q)] || 0) + 1) <= 1)
  }
  const a = spread(A)
  const b = spread(B)
  const out = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) out.push(a[i])
    if (b[i]) out.push(b[i])
  }
  return { pool: out, candidates: { A: A.length, B: B.length } }
}

const { pool: POOL, candidates } = questions()
const NEED = GROUPS * PER
if (POOL.length < NEED) {
  console.error(`only ${POOL.length} usable questions in ${SRC} (A ${candidates.A}, B ${candidates.B}); need ${NEED}`)
  process.exit(1)
}

const SRC_ABS = path.resolve(SRC).split('\\').join('/')

function ask(q, label) {
  const where = `Function \`${q.fn}\` in ${SRC_ABS}/${q.file}`
  if (q.cls === 'A')
    return `${label}. ${where} calls exactly one function that is defined in a different file of this codebase. In which file, and on which line, is that function defined? Answer as \`path:LINE\` — the path relative to ${SRC_ABS}, the line of its \`function\` keyword.`
  return `${label}. ${where} uses exactly one constant that is imported from a different file of this codebase. What is the literal value assigned to that constant where it is defined? Answer with the value exactly as written in the source (keep the quotes if it is a string).`
}

function prompt(qs) {
  return [
    `Answer ${qs.length} questions about the TypeScript codebase at ${SRC_ABS}. Every answer is a fact in the source: find it, do not guess.`,
    '',
    ...qs.map((q, i) => ask(q, 'Q' + (i + 1))),
    '',
    `When finished, print the ${qs.length} answers, one per line, in the form \`Q1: answer\`. Nothing else.`,
  ].join('\n')
}

if (flag('list')) {
  console.log(`${POOL.length} questions (candidates: A ${candidates.A}, B ${candidates.B}); using ${NEED}`)
  console.log(STAGES)
  POOL.slice(0, NEED).forEach((q, i) => console.log(`${i + 1}. [${q.cls}] ${q.file} ${q.fn}()@${q.fnLine} -> ${q.target} = ${q.value}`))
  process.exit(0)
}

// -------------------------------------------------------------------- runs

const norm = (v) => String(v || '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ')

function grade(q, got) {
  if (got == null) return { ok: false, fileOk: false, near: false }
  // `ALT = 16` is accepted as `16`; the question asked for the value, not the name.
  if (q.cls === 'B') return { ok: norm(norm(got).replace(/^[A-Za-z_]\w*\s*=\s*/, '')) === norm(q.value), fileOk: null, near: null }
  const [expFile, expLine] = q.value.split(':')
  const g = norm(got).replace(/\\/g, '/').replace(/^\.\//, '')
  // `src/x.ts:12`, `src/x.ts, line 12`, `src/x.ts (L12)` all count; the file and the number are what matter.
  const m = g.match(/([\w./-]+\.ts)\D{0,12}(\d+)/)
  if (!m) return { ok: false, fileOk: false, near: false }
  let file = m[1]
  if (file.startsWith(SRC_ABS + '/')) file = file.slice(SRC_ABS.length + 1)
  const fileOk = file === expFile || file.endsWith('/' + expFile) || expFile.endsWith('/' + file)
  const diff = Math.abs(Number(m[2]) - Number(expLine))
  return { ok: fileOk && diff === 0, fileOk, near: fileOk && diff <= 2 }
}

function score(text, qs) {
  const answers = {}
  for (const m of String(text).matchAll(/\bQ(\d+)\s*[:：]\s*(.+)/g)) answers['Q' + m[1]] = m[2].trim()
  const detail = qs.map((q, i) => {
    const got = answers['Q' + (i + 1)] ?? null
    const g = grade(q, got)
    return { q: 'Q' + (i + 1), cls: q.cls, expected: q.value, got, ...g }
  })
  return { correct: detail.filter((d) => d.ok).length, nearA: detail.filter((d) => d.cls === 'A' && d.near).length, total: qs.length, detail }
}

function hookDecisions(sessionId) {
  let text = ''
  try {
    text = fs.readFileSync(LOG, 'utf8')
  } catch {}
  const counts = {}
  for (const l of text.split('\n')) {
    if (!l) continue
    let r
    try {
      r = JSON.parse(l)
    } catch {
      continue
    }
    if (r.session !== sessionId) continue
    const k = (r.tool || '?') + ':' + r.decision
    counts[k] = (counts[k] || 0) + 1
  }
  return counts
}

function runOne(group, rep) {
  const qs = POOL.slice(group * PER, group * PER + PER)
  const cwd = path.join(os.tmpdir(), 'pugi-bench-hard')
  fs.mkdirSync(cwd, { recursive: true })
  const env = { ...process.env }
  delete env.CLAUDECODE
  if (OFF) env.PUGI_OFF = '1'
  else delete env.PUGI_OFF
  const t0 = Date.now()
  return new Promise((resolve) => {
    const p = spawn(
      CLAUDE,
      ['-p', prompt(qs), '--model', MODEL, '--output-format', 'json', '--allowedTools', 'Read,Grep,Glob,Bash', '--max-turns', '80'],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    const timer = setTimeout(() => p.kill(), 20 * 60 * 1000)
    p.on('close', () => {
      clearTimeout(timer)
      let res = null
      try {
        res = JSON.parse(out)
      } catch {
        return resolve({ model: MODEL, off: OFF, group, error: 'no JSON result', stderr: err.slice(-2000), stdout: out.slice(-2000) })
      }
      const usage = res.modelUsage || {}
      const tokens = Object.values(usage).reduce(
        (a, u) => a + (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadInputTokens || 0) + (u.cacheCreationInputTokens || 0),
        0
      )
      const decisions = hookDecisions(res.session_id)
      const sum = (re) => Object.entries(decisions).filter(([k]) => re.test(k)).reduce((a, [, v]) => a + v, 0)
      const sc = score(res.result, qs)
      resolve({
        model: MODEL,
        off: OFF,
        per: PER,
        group,
        rep,
        session: res.session_id,
        durationMs: Date.now() - t0,
        cost: res.total_cost_usd || 0,
        tokens,
        turns: res.num_turns ?? null,
        spawned: res.subagent_stats?.spawned ?? null,
        usage,
        decisions,
        blocked: sum(/:blocked$/),
        insisted: sum(/:insisted$/),
        correct: sc.correct,
        nearA: sc.nearA,
        total: sc.total,
        answers: sc.detail,
        questions: qs,
        result: String(res.result || '').slice(0, 2000),
      })
    })
  })
}

;(async () => {
  console.log(`${MODEL}, pugi ${OFF ? 'OFF' : 'on'}: ${GROUPS} groups x ${PER} questions${REPS > 1 ? ` x ${REPS} reps` : ''}, ${PARALLEL} at a time -> ${OUT}`)
  const jobs = GROUPS * REPS
  let next = 0
  const worker = async () => {
    while (next < jobs) {
      const job = next++
      const g = job % GROUPS
      const rep = Math.floor(job / GROUPS)
      const row = await runOne(g, rep)
      fs.appendFileSync(OUT, JSON.stringify(row) + '\n')
      const tag = `group ${g + 1}${REPS > 1 ? ` rep ${rep + 1}` : ''}`
      if (row.error) console.log(`${tag}: ERROR ${row.error}`)
      else
        console.log(
          `${tag}: ${row.correct}/${row.total} correct  ${row.tokens.toLocaleString('en')} tok  $${row.cost.toFixed(3)}  ${(row.durationMs / 60000).toFixed(1)} min  turns ${row.turns}  blocked ${row.blocked} insisted ${row.insisted}`
        )
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs) }, worker))
})()
