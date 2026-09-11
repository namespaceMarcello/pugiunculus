#!/usr/bin/env node
/**
 * bench/notebook.cjs — does cutting the context pay, and does the notebook
 * keep what the cut drops?
 *
 * One long session per job, the same turns in every arm:
 *   1. an opening request with two things that must last the whole session —
 *      a tag every answer starts with, and a codename asked for at the very
 *      end — plus a big read, the way a real session starts by following its
 *      CLAUDE.md map into the docs;
 *   2. one exact-value question per turn (from bench/hard.cjs), which keeps
 *      the context growing past the cut;
 *   3. the codename.
 *
 * Arms:
 *   today     Claude Code as it ships: compaction only near the end of the window
 *   cut       --autocompact 100k: compaction whenever the context passes 100k
 *   notebook  the same cut, plus hooks/pugi-notebook.cjs putting the notebook back
 *
 *   node bench/notebook.cjs --src <codebase> --models haiku,sonnet,opus \
 *        --efforts low,medium,high,xhigh,max --sessions 1 --parallel 4
 *   node bench/notebook.cjs --report
 *
 * Haiku 4.5 has no effort levels, so it runs once per arm at its default.
 * Finished jobs are skipped, so an interrupted run resumes where it stopped.
 * The questions are frozen in notebook-questions.json on the first run.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn, spawnSync } = require('node:child_process')

const argv = process.argv.slice(2)
const opt = (k, d) => {
  const i = argv.indexOf('--' + k)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d
}
const flag = (k) => argv.includes('--' + k)
const csv = (k, d) => String(opt(k, d)).split(',').map((s) => s.trim()).filter(Boolean)

const OUT = opt('out', path.join(__dirname, 'notebook-results.jsonl'))
const QFILE = path.join(__dirname, 'notebook-questions.json')
const CLAUDE = opt('claude', process.platform === 'win32' ? 'claude.exe' : 'claude')
const HOOK = path.join(__dirname, '..', 'hooks', 'pugi-notebook.cjs').split('\\').join('/')
const WINDOW = opt('window', '100k')
const PER = Number(opt('per', 14))
const STREAMS = opt('keep-streams', '') // a directory: each job's raw stream-json is saved there

function rowsOf(file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
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
    .filter(Boolean)
}

// ------------------------------------------------------------------ report

const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '—')

function report() {
  const rows = rowsOf(OUT).filter((r) => r.turnsDone === r.turnsPlanned)
  if (!rows.length) return console.log('no finished jobs in ' + OUT)
  const cells = new Map()
  for (const r of rows) {
    const k = `${r.model}|${r.effort}|${r.arm}`
    if (!cells.has(k)) cells.set(k, [])
    cells.get(k).push(r)
  }
  const sum = (a, f) => a.reduce((x, r) => x + f(r), 0)
  const agg = {}
  console.log('model   effort   arm        n  cost $   correct   tag, 2nd half   codename   cuts')
  for (const [k, a] of [...cells].sort()) {
    const [model, effort, arm] = k.split('|')
    const cell = {
      cost: sum(a, (r) => r.cost) / a.length,
      correct: [sum(a, (r) => r.correct), sum(a, (r) => r.total)],
      tag: [sum(a, (r) => r.ruleLate[0]), sum(a, (r) => r.ruleLate[1])],
      recall: [a.filter((r) => r.recall).length, a.length],
      cuts: sum(a, (r) => r.compactions.length) / a.length,
    }
    agg[k] = cell
    console.log(
      [
        model.padEnd(7),
        effort.padEnd(8),
        arm.padEnd(9),
        String(a.length).padStart(2),
        cell.cost.toFixed(2).padStart(7),
        pct(...cell.correct).padStart(9),
        `${pct(...cell.tag)} (${cell.tag[0]}/${cell.tag[1]})`.padStart(15),
        pct(...cell.recall).padStart(10),
        cell.cuts.toFixed(1).padStart(6),
      ].join(' ')
    )
  }
  console.log('\nnotebook against today, same model and effort:')
  for (const k of Object.keys(agg).filter((k) => k.endsWith('|notebook'))) {
    const today = agg[k.replace(/notebook$/, 'today')]
    const cut = agg[k.replace(/notebook$/, 'cut')]
    if (!today) continue
    const nb = agg[k]
    const d = (100 * (nb.cost - today.cost)) / today.cost
    const cell = k.split('|').slice(0, 2).join(' ')
    console.log(
      `  ${cell.padEnd(15)} cost ${d >= 0 ? '+' : ''}${d.toFixed(0)}%   correct ${pct(...nb.correct)} vs ${pct(...today.correct)}` +
        `   tag ${pct(...nb.tag)} vs ${pct(...today.tag)}   codename ${pct(...nb.recall)} vs ${pct(...today.recall)}` +
        (cut ? `   (cut alone: tag ${pct(...cut.tag)}, codename ${pct(...cut.recall)})` : '')
    )
  }
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
const SRC_ABS = path.resolve(SRC).split('\\').join('/')
const READ = csv('read', 'docs/STATO.md,docs/GAMEPLAY.md')
for (const f of READ) {
  if (!fs.existsSync(path.join(SRC_ABS, f))) {
    console.error(`--read: ${f} is not in ${SRC_ABS}`)
    process.exit(1)
  }
}

function loadQuestions() {
  if (fs.existsSync(QFILE)) {
    const saved = JSON.parse(fs.readFileSync(QFILE, 'utf8'))
    if (saved.src === SRC_ABS) return saved.questions
  }
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, 'hard.cjs'), '--src', SRC_ABS, '--list', '--groups', opt('groups', '11'), '--per', '5'],
    { encoding: 'utf8' }
  )
  const questions = []
  for (const line of String(r.stdout).split('\n')) {
    const m = line.match(/^(\d+)\. \[([AB])\] (\S+) (\S+)\(\)@(\d+) -> (\S+) = (.*)$/)
    if (m) questions.push({ cls: m[2], file: m[3], fn: m[4], fnLine: Number(m[5]), target: m[6], value: m[7] })
  }
  if (!questions.length) {
    console.error('bench/hard.cjs --list gave no questions:\n' + r.stdout + r.stderr)
    process.exit(1)
  }
  fs.writeFileSync(QFILE, JSON.stringify({ src: SRC_ABS, questions }, null, 1) + '\n')
  return questions
}
const QUESTIONS = loadQuestions()

// Same wording and grading as bench/hard.cjs, so the two benchmarks compare.
function ask(q, label) {
  const where = `Function \`${q.fn}\` in ${SRC_ABS}/${q.file}`
  if (q.cls === 'A')
    return `${label}. ${where} calls exactly one function that is defined in a different file of this codebase. In which file, and on which line, is that function defined? Answer as \`path:LINE\` — the path relative to ${SRC_ABS}, the line of its \`function\` keyword.`
  return `${label}. ${where} uses exactly one constant that is imported from a different file of this codebase. What is the literal value assigned to that constant where it is defined? Answer with the value exactly as written in the source (keep the quotes if it is a string).`
}

const norm = (v) => String(v || '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ')

function grade(q, got) {
  if (got == null) return false
  if (q.cls === 'B') return norm(norm(got).replace(/^[A-Za-z_]\w*\s*=\s*/, '')) === norm(q.value)
  const [expFile, expLine] = q.value.split(':')
  const g = norm(got).replace(/\\/g, '/').replace(/^\.\//, '')
  const m = g.match(/([\w./-]+\.ts)\D{0,12}(\d+)/)
  if (!m) return false
  let file = m[1]
  if (file.startsWith(SRC_ABS + '/')) file = file.slice(SRC_ABS.length + 1)
  const fileOk = file === expFile || file.endsWith('/' + expFile) || expFile.endsWith('/' + file)
  return fileOk && Number(m[2]) === Number(expLine)
}

// -------------------------------------------------------------------- turns

const CODENAMES = ['Gattopardo Viola', 'Faro Nero', 'Cometa Lenta', 'Volpe di Carta', 'Ancora Blu', 'Ponte di Sale']
const probes = (set) => ({ tag: 'ZAFFIRO-' + (317 + 101 * set), codename: CODENAMES[set % CODENAMES.length] })

function turns(set) {
  const qs = QUESTIONS.slice(set * PER, set * PER + PER)
  if (qs.length < PER) {
    console.error(`only ${QUESTIONS.length} questions: session ${set} would be short`)
    process.exit(1)
  }
  const { tag, codename } = probes(set)
  return [
    {
      kind: 'open',
      text: [
        'Two rules for this whole session:',
        `1. Begin every answer with the tag ${tag}.`,
        `2. The codename of this job is "${codename}". I will ask for it at the end.`,
        '',
        `First task: read ${READ.map((f) => SRC_ABS + '/' + f).join(' and ')}, then tell me in three lines how the project is organized.`,
      ].join('\n'),
    },
    // "Include the line", not "Reply as": a per-turn format that reads as the whole reply
    // overrides the opening rule on Sonnet, and then the tag measures obedience, not memory.
    ...qs.map((q, i) => ({ kind: 'q', q, text: `${ask(q, 'Q' + (i + 1))} Include the line \`Q${i + 1}: <answer>\` in your reply.` })),
    { kind: 'recall', text: 'What is the codename of this job? Include the line `CODENAME: <codename>` in your reply.' },
  ]
}

// --------------------------------------------------------------------- jobs

function notebookSettings() {
  const hook = { type: 'command', command: `node "${HOOK}"`, timeout: 5 }
  return {
    hooks: {
      UserPromptSubmit: [{ hooks: [hook] }],
      PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [hook] }],
      Stop: [{ hooks: [hook] }],
      SessionStart: [{ matcher: 'compact|clear|resume', hooks: [hook] }],
      SessionEnd: [{ matcher: 'clear', hooks: [hook] }],
    },
  }
}

const key = (j) => [j.model, j.effort, j.arm, j.set].join('|')

function runJob(job) {
  const t = turns(job.set)
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-hook-events',
    '--model', job.model,
    '--allowedTools', 'Read,Grep,Glob',
    '--disallowedTools', 'Agent,Task,Bash,PowerShell,Edit,Write,NotebookEdit',
    '--max-turns', '300',
  ]
  if (job.effort !== 'default') args.push('--effort', job.effort)
  if (job.arm !== 'today') args.push('--autocompact', WINDOW)
  if (job.arm === 'notebook') args.push('--settings', JSON.stringify(notebookSettings()))
  const cwd = path.join(os.tmpdir(), 'pugi-bench-notebook')
  fs.mkdirSync(cwd, { recursive: true })
  const env = { ...process.env }
  delete env.CLAUDECODE
  delete env.PUGI_OFF
  const t0 = Date.now()
  const x = { compactions: [], cuts: [], injected: 0, session: null, model: null, code: null, err: '' }
  const results = []
  let turn = 0
  let buf = ''
  const raw = STREAMS ? fs.createWriteStream(path.join(STREAMS, key(job).replace(/\|/g, '_') + '.jsonl')) : null

  return new Promise((resolve) => {
    const p = spawn(CLAUDE, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    const send = () => {
      if (turn >= t.length) return p.stdin.end()
      p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: t[turn].text } }) + '\n')
    }
    p.stdout.on('data', (d) => {
      if (raw) raw.write(d)
      buf += d
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let ev
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (ev.session_id) x.session = ev.session_id
        if (ev.type === 'assistant' && ev.message && ev.message.model) x.model = ev.message.model
        if (ev.type === 'system' && ev.subtype === 'compact_boundary') {
          const m = ev.compact_metadata || {}
          x.compactions.push(turn)
          x.cuts.push({ turn, trigger: m.trigger, pre: m.pre_tokens, post: m.post_tokens, ms: m.duration_ms })
        }
        // Hook events carry the event name and the output, not the command: the notebook is recognized by its title.
        if (ev.type === 'system' && ev.subtype === 'hook_response' && /^SessionStart:/.test(String(ev.hook_name)) && line.includes('Session notebook'))
          x.injected++
        if (ev.type === 'result') {
          results.push({ turn, text: String(ev.result || ''), cost: ev.total_cost_usd || 0, usage: ev.modelUsage || null, subtype: ev.subtype })
          turn++
          send()
        }
      }
    })
    p.stderr.on('data', (d) => (x.err += d))
    p.on('error', (e) => (x.err += String(e)))
    const timer = setTimeout(() => p.kill(), 90 * 60 * 1000)
    p.on('close', (code) => {
      clearTimeout(timer)
      if (raw) raw.end()
      x.code = code
      resolve(summarize(job, t, results, x, t0))
    })
    send()
  })
}

function summarize(job, t, results, x, t0) {
  const { tag, codename } = probes(job.set)
  const firstCut = x.compactions.length ? x.compactions[0] : Infinity
  const tagged = (text) => new RegExp('^[^A-Za-z0-9]*' + tag + '\\b').test(text.trim())
  const ruleBefore = [0, 0]
  const ruleAfter = [0, 0]
  const ruleLate = [0, 0]
  let correct = 0
  let total = 0
  let recall = false
  const answers = []
  for (const r of results) {
    const kept = tagged(r.text)
    for (const [bucket, on] of [[r.turn >= firstCut ? ruleAfter : ruleBefore, true], [ruleLate, r.turn >= t.length / 2]]) {
      if (!on) continue
      bucket[1]++
      if (kept) bucket[0]++
    }
    const step = t[r.turn]
    if (step.kind === 'q') {
      const m = r.text.match(/\bQ\d+\s*[:：]\s*(.+)/)
      const got = m ? m[1].trim() : null
      const ok = grade(step.q, got)
      total++
      if (ok) correct++
      answers.push({ turn: r.turn, expected: step.q.value, got: got && got.slice(0, 120), ok, tag: kept })
    } else if (step.kind === 'recall') {
      recall = r.text.toLowerCase().includes(codename.toLowerCase())
    }
  }
  const costs = results.map((r) => r.cost)
  return {
    model: job.model,
    effort: job.effort,
    arm: job.arm,
    set: job.set,
    window: job.arm === 'today' ? 'auto' : WINDOW,
    modelId: x.model,
    session: x.session,
    turnsDone: results.length,
    turnsPlanned: t.length,
    compactions: x.compactions,
    cuts: x.cuts,
    notebookInjected: x.injected,
    correct,
    total,
    ruleBefore,
    ruleAfter,
    ruleLate,
    recall,
    cost: costs.length ? Math.max(...costs) : 0, // total_cost_usd is cumulative: the largest is the session's

    usage: results.length ? results[results.length - 1].usage : null,
    durationMs: Date.now() - t0,
    exit: x.code,
    stderr: x.err.slice(-1500),
    answers,
    lastText: results.length ? results[results.length - 1].text.slice(0, 400) : '',
  }
}

async function pool(jobs, n, fn) {
  let i = 0
  const worker = async () => {
    while (i < jobs.length) await fn(jobs[i++])
  }
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker))
}

const MODELS = csv('models', 'haiku')
const EFFORTS = csv('efforts', 'default')
const ARMS = csv('arms', 'today,cut,notebook')
const SESSIONS = Number(opt('sessions', 1))
const PARALLEL = Number(opt('parallel', 3))

const finished = new Set(rowsOf(OUT).filter((r) => r.turnsDone === r.turnsPlanned).map(key))
const jobs = []
for (let set = 0; set < SESSIONS; set++)
  for (const model of MODELS)
    for (const effort of model === 'haiku' ? ['default'] : EFFORTS)
      for (const arm of ARMS) {
        const j = { model, effort, arm, set }
        if (!finished.has(key(j))) jobs.push(j)
      }

if (flag('dry')) {
  jobs.forEach((j) => console.log(key(j)))
  console.log(jobs.length + ' jobs')
  process.exit(0)
}

;(async () => {
  if (STREAMS) fs.mkdirSync(STREAMS, { recursive: true })
  console.log(`${jobs.length} jobs, ${PARALLEL} at a time -> ${OUT}`)
  let n = 0
  await pool(jobs, PARALLEL, async (j) => {
    const row = await runJob(j)
    fs.appendFileSync(OUT, JSON.stringify(row) + '\n')
    n++
    console.log(
      `[${n}/${jobs.length}] ${key(j)}  turns ${row.turnsDone}/${row.turnsPlanned}  cuts ${row.compactions.length}` +
        `  correct ${row.correct}/${row.total}  tag late ${row.ruleLate[0]}/${row.ruleLate[1]}  codename ${row.recall ? 'yes' : 'no'}` +
        `  $${row.cost.toFixed(2)}  ${Math.round(row.durationMs / 60000)} min`
    )
  })
  report()
})()
