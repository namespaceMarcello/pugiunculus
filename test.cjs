#!/usr/bin/env node
/**
 * squint tests — feed each hook the JSON Claude Code would, check the decision.
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
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'squint-test-'))
const HOME = path.join(SANDBOX, 'home')
const TEMP = path.join(SANDBOX, 'temp')
fs.mkdirSync(HOME, { recursive: true })
fs.mkdirSync(TEMP, { recursive: true })

const SQUINT_DIR = path.join(HOME, '.claude', 'squint')
const LOG = path.join(SQUINT_DIR, 'log.jsonl')
const STATE = path.join(TEMP, 'squint-state')

const BIG = path.join(SANDBOX, 'big.ts').split('\\').join('/')
const SMALL = path.join(SANDBOX, 'small.ts').split('\\').join('/')
fs.writeFileSync(BIG, 'const x = 1\n'.repeat(3000)) // ~36 KB
fs.writeFileSync(SMALL, 'const x = 1\n')

let n = 0
const fresh = () => 'test-' + process.pid + '-' + ++n

function env(extra) {
  const e = { ...process.env, HOME, USERPROFILE: HOME, TEMP, TMP: TEMP, TMPDIR: TEMP, ...extra }
  for (const k of Object.keys(e)) if (k.startsWith('SQUINT_') && !(extra && k in extra)) delete e[k]
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

// ---------------------------------------------------------------- squint.cjs

describe('squint.cjs — whole-file Read', () => {
  const read = (session, input, extra) => call('squint.cjs', { session_id: session, tool_name: 'Read', tool_input: input }, extra)

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
    assert.equal(call('squint.cjs', { session_id: fresh(), tool_name: 'Grep', tool_input: { file_path: BIG } }), '')
  })

  test('SQUINT_OFF and the OFF file disable the block but keep the log', () => {
    const s = fresh()
    assert.equal(read(s, { file_path: BIG }, { SQUINT_OFF: '1' }), '')
    fs.mkdirSync(SQUINT_DIR, { recursive: true })
    fs.writeFileSync(path.join(SQUINT_DIR, 'OFF'), '')
    assert.equal(read(s, { file_path: BIG }), '')
    fs.unlinkSync(path.join(SQUINT_DIR, 'OFF'))
    assert.equal(read(s, { file_path: BIG }, { SQUINT_READ_OFF: '1' }), '')
    assert.deepEqual(decisions(s), ['off', 'off', 'off'])
  })

  test('SQUINT_LOG=0 writes nothing', () => {
    const s = fresh()
    assert.ok(denied(read(s, { file_path: BIG }, { SQUINT_LOG: '0' })))
    assert.deepEqual(decisions(s), [])
  })
})

// --------------------------------------------------------- squint-agents.cjs

describe('squint-agents.cjs — fan-out', () => {
  const spawnEv = (session, chars, tool) => ({
    session_id: session,
    tool_name: tool || 'Agent',
    tool_input: { prompt: 'x'.repeat(chars || 400) },
  })
  const agent = (session, chars, extra, tool) => call('squint-agents.cjs', spawnEv(session, chars, tool), extra)

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
    fs.mkdirSync(SQUINT_DIR, { recursive: true })
    fs.writeFileSync(path.join(SQUINT_DIR, 'toll.json'), JSON.stringify({ toll: 29584 }))
    const out = agent(s)
    fs.unlinkSync(path.join(SQUINT_DIR, 'toll.json'))
    assert.match(reason(out), /29,584 tokens before doing any work, so that batch spent at least 118,336/)
  })

  test('a whole wave issued at once is refused together, not one of five', async () => {
    const s = fresh()
    seed(s, 5, 400, 5)
    const outs = await callAll('squint-agents.cjs', Array.from({ length: 5 }, () => spawnEv(s)))
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

  test('the median sets the bar, capped at SQUINT_FANOUT_CHARS', () => {
    const s = fresh()
    seed(s, 5, 1200, 5)
    assert.match(reason(agent(s, 400)), /at least 1500 characters/)
  })

  test('[separate context] goes through as "escaped" only when SQUINT_FANOUT_ESCAPE=1', () => {
    const s = fresh()
    seed(s, 5, 400, 5)
    const ev = spawnEv(s, 300)
    ev.tool_input.prompt = 'Audit this module. [separate context] ' + ev.tool_input.prompt
    // default: not a way through, and the message does not offer it
    const out = call('squint-agents.cjs', ev)
    assert.ok(denied(out))
    assert.doesNotMatch(reason(out), /separate context/)
    // opted in: offered, and honoured
    const r = fresh()
    seed(r, 5, 400, 5)
    ev.session_id = r
    assert.match(reason(agent(r, 400, { SQUINT_FANOUT_ESCAPE: '1' })), /write \[separate context\]/)
    assert.equal(call('squint-agents.cjs', ev, { SQUINT_FANOUT_ESCAPE: '1' }), '')
    assert.deepEqual(decisions(r), ['blocked', 'escaped'])
  })

  test('the valve: after three refused waves the next one passes as "insisted"', async () => {
    const s = fresh()
    seed(s, 5, 400, 5)
    for (let wave = 1; wave <= 3; wave++) {
      const outs = await callAll('squint-agents.cjs', [spawnEv(s), spawnEv(s)])
      assert.equal(outs.filter(denied).length, 2, 'wave ' + wave)
      await sleep(1600)
    }
    const outs = await callAll('squint-agents.cjs', [spawnEv(s), spawnEv(s)])
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
    assert.equal(agent(s, 400, { SQUINT_OFF: '1' }), '')
    const r = fresh()
    seed(r, 6, 400, 5)
    assert.equal(agent(r, 400, { SQUINT_FANOUT_OFF: '1' }), '')
    assert.deepEqual(decisions(s), ['off'])
    assert.deepEqual(decisions(r), ['off'])
  })
})

// ----------------------------------------------------------- squint-bash.cjs

describe('squint-bash.cjs — the shell back door', () => {
  const sh = (command, session, tool, extra) =>
    call('squint-bash.cjs', { session_id: session || fresh(), tool_name: tool || 'Bash', tool_input: { command } }, extra)
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
    assert.equal(sh('cat ' + BIG, s, 'Bash', { SQUINT_OFF: '1' }), '')
    assert.equal(sh('cat ' + BIG, s, 'Bash', { SQUINT_BASH_OFF: '1' }), '')
    assert.deepEqual(decisions(s), ['off', 'off'])
  })
})
