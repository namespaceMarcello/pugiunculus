#!/usr/bin/env node
/**
 * pugi tests — feed each hook the JSON Claude Code would, check the decision.
 *
 *   node --test test.cjs
 *
 * Every call runs in a throwaway HOME and TEMP, so nothing here touches your
 * real log, your OFF switch or the state of a live session.
 */

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const HOOKS = path.join(__dirname, 'hooks')
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'pugi-test-'))
const HOME = path.join(SANDBOX, 'home')
const TEMP = path.join(SANDBOX, 'temp')
fs.mkdirSync(HOME, { recursive: true })
fs.mkdirSync(TEMP, { recursive: true })

const PUGI_DIR = path.join(HOME, '.claude', 'pugi')
const LOG = path.join(PUGI_DIR, 'log.jsonl')
const STATE = path.join(TEMP, 'pugi-state')

const BIG = path.join(SANDBOX, 'big.ts').split('\\').join('/')
const SMALL = path.join(SANDBOX, 'small.ts').split('\\').join('/')
fs.writeFileSync(BIG, 'const x = 1\n'.repeat(3000)) // ~36 KB
fs.writeFileSync(SMALL, 'const x = 1\n')

let n = 0
const fresh = () => 'test-' + process.pid + '-' + ++n

function env(extra) {
  const e = { ...process.env, HOME, USERPROFILE: HOME, TEMP, TMP: TEMP, TMPDIR: TEMP, ...extra }
  for (const k of Object.keys(e)) if (k.startsWith('PUGI_') && !(extra && k in extra)) delete e[k]
  return e
}

/** Run a hook synchronously; returns '' when it lets the call through. */
function call(hook, ev, extra) {
  const r = spawnSync(process.execPath, [path.join(HOOKS, hook)], {
    input: JSON.stringify(ev),
    encoding: 'utf8',
    env: env(extra),
  })
  return (r.stdout || '').trim()
}

/** Run several hook processes at the same instant, as Claude Code does for one turn. */
function callAll(hook, events) {
  return Promise.all(
    events.map(
      (ev) =>
        new Promise((res) => {
          const p = spawn(process.execPath, [path.join(HOOKS, hook)], { env: env() })
          let out = ''
          p.stdout.on('data', (d) => (out += d))
          p.on('close', () => res(out.trim()))
          p.stdin.end(JSON.stringify(ev))
        })
    )
  )
}

const denied = (out) => out.length > 0
const reason = (out) => JSON.parse(out).hookSpecificOutput.permissionDecisionReason

function decisions(session) {
  let text = ''
  try {
    text = fs.readFileSync(LOG, 'utf8')
  } catch {}
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.session === session)
    .map((r) => r.decision)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- pugi.cjs

describe('pugi.cjs — whole-file Read', () => {
  const read = (session, input, extra) => call('pugi.cjs', { session_id: session, tool_name: 'Read', tool_input: input }, extra)

  test('blocks a whole read of a big file, then lets the repeat through', () => {
    const s = fresh()
    const first = read(s, { file_path: BIG })
    assert.ok(denied(first))
    assert.match(reason(first), /up to ~9000 tokens/)
    assert.equal(read(s, { file_path: BIG }), '')
    assert.deepEqual(decisions(s), ['blocked', 'insisted'])
  })

  test('lets slices, small files, opaque files and missing files through', () => {
    const s = fresh()
    assert.equal(read(s, { file_path: BIG, offset: 100, limit: 30 }), '')
    assert.equal(read(s, { file_path: SMALL }), '')
    assert.equal(read(s, { file_path: BIG.replace(/\.ts$/, '.png') }), '')
    assert.equal(read(s, { file_path: '/no/such/file.ts' }), '')
    assert.deepEqual(decisions(s), ['slice', 'small'])
  })

  test('ignores other tools', () => {
    assert.equal(call('pugi.cjs', { session_id: fresh(), tool_name: 'Grep', tool_input: { file_path: BIG } }), '')
  })

  test('PUGI_OFF and the OFF file disable the block but keep the log', () => {
    const s = fresh()
    assert.equal(read(s, { file_path: BIG }, { PUGI_OFF: '1' }), '')
    fs.mkdirSync(PUGI_DIR, { recursive: true })
    fs.writeFileSync(path.join(PUGI_DIR, 'OFF'), '')
    assert.equal(read(s, { file_path: BIG }), '')
    fs.unlinkSync(path.join(PUGI_DIR, 'OFF'))
    assert.equal(read(s, { file_path: BIG }, { PUGI_READ_OFF: '1' }), '')
    assert.deepEqual(decisions(s), ['off', 'off', 'off'])
  })

  test('PUGI_LOG=0 writes nothing', () => {
    const s = fresh()
    assert.ok(denied(read(s, { file_path: BIG }, { PUGI_LOG: '0' })))
    assert.deepEqual(decisions(s), [])
  })
})

// --------------------------------------------------------- pugi-agents.cjs

describe('pugi-agents.cjs — fan-out', () => {
  const spawnEv = (session, chars, tool) => ({
    session_id: session,
    tool_name: tool || 'Agent',
    tool_input: { prompt: 'x'.repeat(chars || 400) },
  })
  const agent = (session, chars, extra, tool) => call('pugi-agents.cjs', spawnEv(session, chars, tool), extra)

  /** A finished batch on record: n spawns of `len` chars, `minutesAgo` back. */
  function seed(session, n, len, minutesAgo) {
    fs.mkdirSync(STATE, { recursive: true })
    const t = Date.now() - minutesAgo * 60000
    const lines = Array.from({ length: n }, (_, i) => JSON.stringify({ at: t + i * 500, len }))
    fs.writeFileSync(path.join(STATE, 'fanout-' + session + '.jsonl'), lines.join('\n') + '\n')
  }

  test('the first batch of a session is never blocked', () => {
    const s = fresh()
    for (let i = 0; i < 5; i++) assert.equal(agent(s), '')
    assert.deepEqual(decisions(s), ['pass', 'pass', 'pass', 'pass', 'pass'])
  })

  test('blocks the batch after a wasteful one, and quotes the evidence', () => {
    const s = fresh()
    seed(s, 6, 400, 5)
    const out = agent(s)
    assert.ok(denied(out))
    assert.match(reason(out), /last batch was 6 subagents with a median prompt of 400 characters/)
  })

  test('quotes the measured entry cost when toll.json exists', () => {
    const s = fresh()
    seed(s, 4, 400, 5)
    fs.mkdirSync(PUGI_DIR, { recursive: true })
    fs.writeFileSync(path.join(PUGI_DIR, 'toll.json'), JSON.stringify({ toll: 29584 }))
    const out = agent(s)
    fs.unlinkSync(path.join(PUGI_DIR, 'toll.json'))
    assert.match(reason(out), /29,584 tokens before doing any work, so that batch spent at least 118,336/)
  })

  test('a whole wave issued at once is refused together, not one of five', async () => {
    const s = fresh()
    seed(s, 5, 400, 5)
    const outs = await callAll('pugi-agents.cjs', Array.from({ length: 5 }, () => spawnEv(s)))
    assert.equal(outs.filter(denied).length, 5)
    assert.deepEqual(decisions(s), ['blocked', 'blocked', 'blocked', 'blocked', 'blocked'])
  })

  test('the same shape is refused again; a prompt twice the median passes as "rebatched"', async () => {
    const s = fresh()
    seed(s, 5, 400, 5)
    const out = agent(s)
    assert.ok(denied(out))
    assert.match(reason(out), /a prompt of at least 800 characters goes through/)
    await sleep(1600)
    assert.ok(denied(agent(s, 400)))
    assert.ok(denied(agent(s, 799)))
    assert.equal(agent(s, 800), '')
    assert.equal(agent(s, 800), '')
    // the wasteful batch is still the last closed one: small prompts stay refused
    assert.ok(denied(agent(s, 400)))
    assert.deepEqual(decisions(s), ['blocked', 'blocked', 'blocked', 'rebatched', 'rebatched', 'blocked'])
  })

  test('the median sets the bar, capped at PUGI_FANOUT_CHARS', () => {
    const s = fresh()
    seed(s, 5, 1200, 5)
    assert.match(reason(agent(s, 400)), /at least 1500 characters/)
  })

  test('[separate context] goes through as "escaped" only when PUGI_FANOUT_ESCAPE=1', () => {
    const s = fresh()
    seed(s, 5, 400, 5)
    const ev = spawnEv(s, 300)
    ev.tool_input.prompt = 'Audit this module. [separate context] ' + ev.tool_input.prompt
    // default: not a way through, and the message does not offer it
    const out = call('pugi-agents.cjs', ev)
    assert.ok(denied(out))
    assert.doesNotMatch(reason(out), /separate context/)
    // opted in: offered, and honoured
    const r = fresh()
    seed(r, 5, 400, 5)
    ev.session_id = r
    assert.match(reason(agent(r, 400, { PUGI_FANOUT_ESCAPE: '1' })), /write \[separate context\]/)
    assert.equal(call('pugi-agents.cjs', ev, { PUGI_FANOUT_ESCAPE: '1' }), '')
    assert.deepEqual(decisions(r), ['blocked', 'escaped'])
  })

  test('the valve: after three refused waves the next one passes as "insisted"', async () => {
    const s = fresh()
    seed(s, 5, 400, 5)
    for (let wave = 1; wave <= 3; wave++) {
      const outs = await callAll('pugi-agents.cjs', [spawnEv(s), spawnEv(s)])
      assert.equal(outs.filter(denied).length, 2, 'wave ' + wave)
      await sleep(1600)
    }
    const outs = await callAll('pugi-agents.cjs', [spawnEv(s), spawnEv(s)])
    assert.equal(outs.filter(denied).length, 0)
    const d = decisions(s)
    assert.equal(d.filter((x) => x === 'blocked').length, 6)
    assert.equal(d.filter((x) => x === 'insisted').length, 2)
    // and the valve closes again behind them
    await sleep(1600)
    assert.ok(denied(agent(s, 400)))
  })

  test('a batch of two, or a batch of long prompts, is not wasteful', () => {
    const s = fresh()
    seed(s, 2, 400, 5)
    assert.equal(agent(s), '')
    const r = fresh()
    seed(r, 6, 4000, 5)
    assert.equal(agent(r), '')
  })

  test('a first batch still in progress is never cut in half', () => {
    const s = fresh()
    seed(s, 6, 400, 0)
    assert.equal(agent(s), '')
  })

  test('after a good batch, the next fan-out starts fresh', () => {
    const s = fresh()
    seed(s, 6, 400, 10) // wasteful, long ago
    fs.appendFileSync(
      path.join(STATE, 'fanout-' + s + '.jsonl'),
      [JSON.stringify({ at: Date.now() - 5 * 60000, len: 3000 }), JSON.stringify({ at: Date.now() - 5 * 60000 + 500, len: 3000 })].join('\n') + '\n'
    )
    assert.equal(agent(s, 400), '')
  })

  test('ignores other tools, honours the OFF switches', () => {
    const s = fresh()
    seed(s, 6, 400, 5)
    assert.equal(agent(s, 400, null, 'Bash'), '')
    assert.equal(agent(s, 400, { PUGI_OFF: '1' }), '')
    const r = fresh()
    seed(r, 6, 400, 5)
    assert.equal(agent(r, 400, { PUGI_FANOUT_OFF: '1' }), '')
    assert.deepEqual(decisions(s), ['off'])
    assert.deepEqual(decisions(r), ['off'])
  })
})

// ----------------------------------------------------------- pugi-bash.cjs

describe('pugi-bash.cjs — the shell back door', () => {
  const sh = (command, session, tool, extra) =>
    call('pugi-bash.cjs', { session_id: session || fresh(), tool_name: tool || 'Bash', tool_input: { command } }, extra)
  const blocks = (command, tool) => assert.ok(denied(sh(command, null, tool)), 'expected a block: ' + command)
  const passes = (command, tool) => assert.equal(sh(command, null, tool), '', 'expected a pass: ' + command)

  test('cat of a big file: blocked once, then through', () => {
    const s = fresh()
    const out = sh('cat ' + BIG, s)
    assert.ok(denied(out))
    assert.match(reason(out), /`cat` on .*big\.ts is up to ~9000 tokens/)
    assert.equal(sh('cat ' + BIG, s), '')
    assert.deepEqual(decisions(s), ['blocked', 'insisted'])
  })

  test('the other printers', () => {
    for (const v of ['type', 'nl', 'tac', 'more', 'less', 'bat', '/usr/bin/cat']) blocks(v + ' ' + BIG)
    blocks('Get-Content ' + BIG, 'PowerShell')
    blocks('gc ' + BIG, 'PowerShell')
  })

  test('small files, pipes and stdout redirects pass', () => {
    passes('cat ' + SMALL)
    passes('cat ' + BIG + ' | grep const')
    passes('cat ' + BIG + ' > out.txt')
    passes('cat ' + BIG + ' &> out.txt')
    passes('cat ' + BIG + ' 1>/dev/null')
  })

  test('a stderr redirect is not a diversion', () => {
    blocks('cat ' + BIG + ' 2>/dev/null')
    blocks('cat ' + BIG + ' 2>&1')
  })

  test('chains are checked one command at a time', () => {
    blocks('cd ' + path.dirname(BIG) + ' && cat ' + BIG)
    blocks('echo start; cat ' + BIG)
    blocks('ls || cat ' + BIG)
    blocks('cd x; type ' + BIG, 'PowerShell')
    passes('cat ' + BIG + ' | head -20 && echo done')
  })

  test('head and tail: small counts pass, big counts and +offsets block', () => {
    passes('head ' + BIG)
    passes('head -n 20 ' + BIG)
    passes('head -n20 ' + BIG)
    passes('head -20 ' + BIG)
    passes('tail --lines=40 ' + BIG)
    passes('head -c 200 ' + BIG)
    blocks('head -n 5000 ' + BIG)
    blocks('head -5000 ' + BIG)
    blocks('head -c 100000 ' + BIG)
    blocks('tail -n +1 ' + BIG)
  })

  test('sed: narrow ranges pass, wide ranges and $ block', () => {
    passes("sed -n '100,140p' " + BIG)
    passes("sed -n '/x/p' " + BIG)
    blocks("sed -n '1,4000p' " + BIG)
    blocks('sed -n 1,4000p ' + BIG)
    blocks("sed -n '1,$p' " + BIG)
  })

  test('PowerShell slices pass', () => {
    passes('Get-Content ' + BIG + ' -TotalCount 20', 'PowerShell')
    passes('Get-Content ' + BIG + ' -Tail 20', 'PowerShell')
    passes('gc ' + BIG + ' -Head 5', 'PowerShell')
    blocks('Get-Content ' + BIG + ' -TotalCount 5000', 'PowerShell')
  })

  test('what it does not catch, on purpose', () => {
    passes("awk '{print}' " + BIG)
    passes("grep '' " + BIG)
  })

  test('missing files, other tools, the OFF switch', () => {
    passes('cat /no/such/file.ts')
    passes('npm run build')
    passes('cat ' + BIG, 'Read')
    const s = fresh()
    assert.equal(sh('cat ' + BIG, s, 'Bash', { PUGI_OFF: '1' }), '')
    assert.equal(sh('cat ' + BIG, s, 'Bash', { PUGI_BASH_OFF: '1' }), '')
    assert.deepEqual(decisions(s), ['off', 'off'])
  })
})

// ---------------------------------------------------------- pugi-effort.cjs

describe('pugi-effort.cjs — the effort router', () => {
  const EF = 'pugi-effort.cjs'
  const IT = { PUGI_EFFORT_WORDS: path.join(HOOKS, 'effort-words.it.json') }
  const ask = (session, prompt, extra) => call(EF, { session_id: session, hook_event_name: 'UserPromptSubmit', prompt }, extra)
  const suggested = (out) => JSON.parse(out).hookSpecificOutput.additionalContext
  const { build } = require(path.join(HOOKS, EF))
  const score = build(path.join(SANDBOX, 'no-such-words.json')).score // the English defaults alone, whatever this machine has installed
  const it = build(IT.PUGI_EFFORT_WORDS).score
  const DESIGN = "progetta l'architettura del potatore: perché un hook non basta? cosa cambia con un proxy?"

  test('the English defaults: mechanical goes low, design goes max, a plain question stays high, "in short" pulls down', () => {
    assert.equal(score('commit and push').level, 'low')
    assert.equal(score("design the pruner's architecture: why is a hook not enough? what changes with a proxy?").level, 'max')
    assert.equal(score('why does the cache expire after an hour?').level, 'high')
    assert.equal(score('where does the cache live?').level, 'medium')
    assert.equal(score('in short, why is the pruner useless').level, 'low')
    assert.equal(score('go', 'max').level, 'max')
    assert.equal(score('go').level, 'high')
  })

  test('a word pack adds its language: the same prompts in Italian, and the Italian "vai"', () => {
    assert.equal(score(DESIGN).level, 'high') // English only: nothing counts but the two question marks
    assert.equal(it('commit e push').level, 'low')
    assert.equal(it(DESIGN).level, 'max')
    assert.equal(it('perché la cache scade dopo un\'ora?').level, 'high')
    assert.equal(it('spiegami in breve perché il potatore è inutile').level, 'low')
    assert.equal(it('vai', 'max').level, 'max')
    assert.equal(score('vai', 'max').level, 'medium')
  })

  test('the hook writes one line, a number out of ten and the signals, nothing else; and logs it', () => {
    const s = fresh()
    const low = ask(s, 'commit e push', IT)
    assert.equal(suggested(low), 'Effort suggested for this turn: 2/10 (mechanical, short).')
    assert.equal(JSON.parse(low).systemMessage, 'pugi: effort → 2/10 (mechanical, short)')
    assert.equal(suggested(ask(s, 'perché la cache scade dopo un\'ora?', IT)), 'Effort suggested for this turn: 6/10 (why).')
    assert.deepEqual(decisions(s), ['suggest', 'suggest'])
    assert.equal(score('commit and push').grade, 2)
    assert.equal(score(DESIGN).grade, 6) // English only: the two question marks
    assert.equal(it(DESIGN).grade, 9)
  })

  test('a bare "vai" keeps the suggestion of the previous turn', () => {
    const s = fresh()
    assert.match(suggested(ask(s, DESIGN, IT)), /: 9\/10 /)
    assert.equal(suggested(ask(s, 'vai', IT)), 'Effort suggested for this turn: 9/10 (continuation).')
  })

  test('off keeps the log; slash commands are ignored; a broken event goes through untouched', () => {
    const s = fresh()
    assert.equal(ask(s, 'commit e push', { PUGI_OFF: '1' }), '')
    assert.deepEqual(decisions(s), ['off'])
    assert.equal(ask(s, '/effort max'), '')
    assert.deepEqual(decisions(s), ['off'])
    assert.equal(call(EF, { session_id: s }), '')
  })
})

// ------------------------------------------------------ bench/effort-learn.cjs

describe('bench/effort-learn.cjs — learning the words', () => {
  const lib = require(path.join(__dirname, 'bench', 'effort-learn.cjs'))
  const { build } = require(path.join(HOOKS, 'pugi-effort.cjs'))

  test('words that go with heavy turns become hard signals, words of light turns mechanical, tiny repeated prompts continuations', () => {
    const turns = []
    for (let i = 0; i < 60; i++)
      turns.push(i % 2 ? { text: 'zorb the flumble for me', session: 's' + (i % 4), thinking: 9000 + i, calls: 4, requests: 3, effort: 'high' } : { text: 'plain request number ' + i, session: 's' + (i % 4), thinking: 300 + i, calls: 1, requests: 1, effort: 'high' })
    for (let i = 0; i < 6; i++) turns.push({ text: 'avanti', session: 's0', thinking: 100, calls: 0, requests: 1, effort: 'high' })
    const pack = lib.learn(turns, { min: 5 })
    assert.ok(pack.design.words.concat(pack.why.words).includes('zorb'))
    assert.ok(pack.mechanical.words.includes('plain'))
    assert.ok(!pack.mechanical.words.includes('zorb'))
    assert.ok(pack.continue.includes('avanti'))
    assert.ok(lib.separation(build(pack).score, turns.map((t) => ({ ...t }))) > 0.9)
    assert.ok(['xhigh', 'max'].includes(build(pack).score('could you zorb the flumble for me today, and take the time it needs to come out right').level))
  })

  test('the language of the prompts, by the words no language can do without', () => {
    assert.equal(lib.detectLanguage(Array(6).fill('che cosa non va con questo file e come mai non funziona per te')).lang, 'it')
    assert.equal(lib.detectLanguage(Array(6).fill('what is the plan and how do you do it for this file')).lang, 'en')
    assert.equal(lib.detectLanguage(['zorb']), null)
  })

  test('with no history there is nothing to learn, and nothing is written', () => {
    const r = lib.learnAndJudge({ days: 30, file: path.join(SANDBOX, 'words.json'), mark: 'x', write: true, root: path.join(SANDBOX, 'no-projects') })
    assert.equal(r.verdict, 'not enough history')
    assert.ok(!fs.existsSync(path.join(SANDBOX, 'words.json')))
  })
})

// ------------------------------------------------------------ pugi-cold.cjs

describe('pugi-cold.cjs — the cold cache', () => {
  const CO = 'pugi-cold.cjs'
  const HOUR = 3600e3
  let t = 0
  /** A transcript whose last request ended `ago` ms ago with `ctx` tokens of context; `after` lines follow it. */
  const transcript = (ago, ctx, model, after = []) => {
    const file = path.join(SANDBOX, 'transcript-' + ++t + '.jsonl')
    const at = new Date(Date.now() - ago).toISOString()
    const lines = [
      { type: 'user', message: { role: 'user', content: 'hello' } },
      // The first request carries the fixed part alone: 55k.
      { type: 'assistant', timestamp: new Date(Date.now() - ago - 60e3).toISOString(), message: { id: 'msg_0', model, usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 54995, output_tokens: 100 } } },
      { type: 'assistant', timestamp: at, message: { id: 'msg_1', model, usage: { input_tokens: 5, cache_read_input_tokens: ctx - 1005, cache_creation_input_tokens: 1000, output_tokens: 300 } } },
      ...after,
    ]
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    return file
  }
  const ask = (session, file, prompt, extra) => call(CO, { session_id: session, hook_event_name: 'UserPromptSubmit', transcript_path: file, prompt }, { PUGI_COLOR: '0', ...extra })
  const why = (out) => JSON.parse(out).reason

  test('after an hour the prompt is blocked once with the numbers, and the same prompt sent again passes', () => {
    const s = fresh()
    const file = transcript(2 * HOUR + 15 * 60e3, 265e3, 'claude-opus-5')
    const out = ask(s, file, 'commit')
    assert.equal(JSON.parse(out).decision, 'block')
    assert.match(why(out), /away 2h 15m; the cache keeps the conversation for an hour, so it is cold\. Your prompt is on hold\./)
    assert.match(why(out), /for an hour, so it is cold\./)
    assert.match(why(out), /Model in use: Opus 5 \(claude-opus-5\)\. The conversation is 265,000 tokens; the last request read 99\.6% of it from the cache, this one would read 0%\./)
    assert.match(why(out), /List price per million tokens: input \$5, cache write \$10, cache read \$0\.50, output \$25\./)
    // Continuing writes 265k back into the cache at $10 per million: $2.65; every later request reads 265k at $0.50: $0.133.
    // /compact: the cold read at $5 plus 10k of summary at $25: $1.57, then 90k a request (fixed 55k + 35k put back): $0.045.
    // /clear: nothing now, then the fixed 55k: $0.028.
    assert.match(why(out), /┌─+┬─+┬─+┬─+┐\n.*│ if you…\s+│ you pay now, tokens\s+│ then, on every request, tokens\s+│ and you lose\s+│/)
    assert.match(why(out), /│ continue\s+│ 265,000 cache write \(\$2\.65\)\s+│ 265,000 cache read \(\$0\.133\)\s+│ nothing\s+│/)
    assert.match(why(out), /│ \/compact first\s+│ 265,000 in \+ 10,000 out \(\$1\.57, −41%\)\s+│ 90,000 cache read \(\$0\.045, −66%\)\s+│ detail: a summary replaces the history │/)
    assert.match(why(out), /│ \/clear\s+│ 0 \(\$0\.00, −100%\)\s+│ 55,000 cache read \(\$0\.028, −79%\)\s+│ the history\s+│/)
    assert.match(why(out), /↑ brings your prompt back/)
    // The blocked prompt went to the prompt history, once; the same prompt sent again passes.
    const HISTORY = path.join(HOME, '.claude', 'history.jsonl')
    const history = () => fs.readFileSync(HISTORY, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(history().filter((h) => h.sessionId === s).map((h) => h.display), ['commit'])
    assert.equal(ask(s, file, 'commit'), '')
    assert.deepEqual(decisions(s), ['blocked', 'insisted'])
    assert.equal(history().filter((h) => h.sessionId === s).length, 1)
    // Fable 5.1: the cache write costs $20, the read $0.25 per million — the rewrite $5.30, every later request $0.07.
    const fable = why(ask(fresh(), transcript(2 * HOUR, 265e3, 'claude-fable-5-1'), 'commit'))
    assert.match(fable, /Model in use: Fable 5\.1 \(claude-fable-5-1\)/)
    assert.match(fable, /│ continue\s+│ 265,000 cache write \(\$5\.30\)\s+│ 265,000 cache read \(\$0\.066\)\s+│/)
    // Colours are on unless NO_COLOR or PUGI_COLOR=0.
    assert.match(why(ask(fresh(), file, 'commit', { PUGI_COLOR: '1' })), /\x1b\[31m/)
  })

  test('within the TTL nothing happens; the TTL follows the settings and PUGI_COLD_MINUTES', () => {
    const s = fresh()
    const file = transcript(10 * 60e3, 200e3, 'claude-opus-5')
    assert.equal(ask(s, file, 'go on'), '')
    assert.deepEqual(decisions(s), ['warm'])
    assert.equal(JSON.parse(ask(fresh(), file, 'go on', { PUGI_COLD_MINUTES: '5' })).decision, 'block')
    const SETTINGS = path.join(HOME, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true })
    fs.writeFileSync(SETTINGS, JSON.stringify({ promptCacheTtl: '5m' }))
    assert.match(why(ask(fresh(), file, 'go on')), /keeps the conversation for 5 minutes/)
    assert.equal(ask(fresh(), file, 'go on', { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }), '')
    fs.unlinkSync(SETTINGS)
  })

  test('next to the effort hook on the same prompt, at the same instant, it still remembers it blocked', async () => {
    const s = fresh()
    const file = transcript(3 * HOUR, 300e3, 'claude-opus-5')
    const ev = { session_id: s, hook_event_name: 'UserPromptSubmit', transcript_path: file, prompt: 'go on' }
    const both = () =>
      Promise.all(
        ['pugi-effort.cjs', CO].map(
          (h) =>
            new Promise((res) => {
              const p = spawn(process.execPath, [path.join(HOOKS, h)], { env: env() })
              let out = ''
              p.stdout.on('data', (d) => (out += d))
              p.on('close', () => res(out.trim()))
              p.stdin.end(JSON.stringify(ev))
            })
        )
      )
    assert.equal(JSON.parse((await both())[1]).decision, 'block')
    assert.equal((await both())[1], '')
    assert.deepEqual(decisions(s).filter((d) => d !== 'suggest'), ['blocked', 'insisted'])
  })

  test('a compaction after the last request passes: the cache is rebuilt anyway', () => {
    const s = fresh()
    const file = transcript(3 * HOUR, 400e3, 'claude-opus-5', [{ type: 'system', subtype: 'compact_boundary', timestamp: new Date().toISOString() }])
    assert.equal(ask(s, file, 'go on'), '')
    assert.deepEqual(decisions(s), ['compacted'])
  })

  test('slash commands, a missing transcript, a fresh session, the OFF switches and a broken event all go through', () => {
    const s = fresh()
    const file = transcript(3 * HOUR, 400e3, 'claude-opus-5')
    assert.equal(ask(s, file, '/compact'), '')
    assert.equal(ask(s, path.join(SANDBOX, 'no-such.jsonl'), 'go on'), '')
    const empty = path.join(SANDBOX, 'fresh.jsonl')
    fs.writeFileSync(empty, JSON.stringify({ type: 'user', message: { role: 'user', content: 'first' } }) + '\n')
    assert.equal(ask(s, empty, 'go on'), '')
    assert.equal(ask(s, file, 'go on', { PUGI_OFF: '1' }), '')
    assert.equal(ask(s, file, 'go on', { PUGI_COLD_OFF: '1' }), '')
    assert.deepEqual(decisions(s), ['none', 'none', 'off', 'off'])
    assert.equal(call(CO, { session_id: s, prompt: 'go on' }), '')
    assert.equal(call(CO, { session_id: s }), '')
  })
})

describe('install.cjs', () => {
  const SETTINGS = path.join(HOME, '.claude', 'settings.json')
  const install = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'install.cjs'), ...args], { encoding: 'utf8', env: env() })
  const count = (re) =>
    Object.values(JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).hooks || {})
      .flat()
      .filter((e) => (e.hooks || []).some((h) => re.test(h.command))).length
  const MINE = { hooks: [{ type: 'command', command: 'echo mine' }] }

  test('the effort router is opt-in, writes no skill, removes the skills an earlier version wrote, and leaves one that is not ours', () => {
    const SKILLS = path.join(HOME, '.claude', 'skills')
    const theirs = '---\nname: effort-low\n---\nmine\n'
    const ours = '---\nname: effort-max\neffort: max\n---\n<!-- written by pugi install.cjs; node install.cjs --no-effort removes it -->\n'
    fs.writeFileSync(SETTINGS, JSON.stringify({ hooks: {} }))
    fs.mkdirSync(path.join(SKILLS, 'effort-low'), { recursive: true })
    fs.writeFileSync(path.join(SKILLS, 'effort-low', 'SKILL.md'), theirs)
    fs.mkdirSync(path.join(SKILLS, 'effort-max'), { recursive: true })
    fs.writeFileSync(path.join(SKILLS, 'effort-max', 'SKILL.md'), ours)
    install('--effort')
    assert.equal(count(/pugi-effort/), 1)
    assert.equal(count(/pugi-cold/), 1) // the cold-cache hook comes with the blockers
    assert.ok(!fs.existsSync(path.join(SKILLS, 'effort-max')))
    for (const l of ['medium', 'xhigh']) assert.ok(!fs.existsSync(path.join(SKILLS, 'effort-' + l)))
    assert.equal(fs.readFileSync(path.join(SKILLS, 'effort-low', 'SKILL.md'), 'utf8'), theirs)
    install()
    assert.equal(count(/pugi-effort/), 1)
    install('--no-effort')
    assert.equal(count(/pugi-effort/), 0)
    assert.equal(fs.readFileSync(path.join(SKILLS, 'effort-low', 'SKILL.md'), 'utf8'), theirs)
  })

  test('--lang writes the word pack where the hook looks, and --no-effort takes it out; an unknown language changes nothing', () => {
    const WORDS = path.join(HOME, '.claude', 'pugi', 'effort-words.json')
    fs.writeFileSync(SETTINGS, JSON.stringify({ hooks: {} }))
    assert.match(install('--effort').stdout, /not enough history/) // a sandbox has no transcripts: nothing detected, nothing learned
    assert.ok(!fs.existsSync(WORDS))
    install('--effort', '--lang', 'xx')
    assert.ok(!fs.existsSync(WORDS))
    install('--effort', '--lang', 'it')
    const pack = JSON.parse(fs.readFileSync(WORDS, 'utf8'))
    assert.equal(pack._lang, 'it')
    assert.ok(pack.continue.includes('vai'))
    install()
    assert.ok(fs.existsSync(WORDS))
    install('--no-effort')
    assert.ok(!fs.existsSync(WORDS))
  })

  test('the reader agent is opt-in: its definition and the subagent cache setting come and go together', () => {
    const AGENT = path.join(HOME, '.claude', 'agents', 'lettore.md')
    const read = () => JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))
    fs.writeFileSync(SETTINGS, JSON.stringify({ hooks: {} }))
    install('--lettore')
    assert.match(fs.readFileSync(AGENT, 'utf8'), /^name: lettore$/m)
    assert.equal(read().subagentPromptCacheTtl, '1h')
    install()
    assert.ok(fs.existsSync(AGENT))
    assert.equal(read().subagentPromptCacheTtl, '1h')
    install('--no-lettore')
    assert.ok(!fs.existsSync(AGENT))
    assert.equal(read().subagentPromptCacheTtl, undefined)
    fs.writeFileSync(SETTINGS, JSON.stringify({ hooks: {}, subagentPromptCacheTtl: '5m' }))
    install('--lettore')
    assert.equal(read().subagentPromptCacheTtl, '5m')
    install('--uninstall')
    assert.ok(!fs.existsSync(AGENT))
    assert.equal(read().subagentPromptCacheTtl, '5m')
  })
})
