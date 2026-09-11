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

// ---------------------------------------------------------- pugi-notebook.cjs

describe('pugi-notebook.cjs — the session notebook', () => {
  const NB = 'pugi-notebook.cjs'
  const BOOK = path.join(PUGI_DIR, 'notebook')
  const KITTEN = path.join(SANDBOX, 'KittenCare')
  const ev = (session, event, extra, cwd = KITTEN) => ({ session_id: session, cwd, hook_event_name: event, ...extra })
  const say = (s, prompt, extra) => call(NB, ev(s, 'UserPromptSubmit', { prompt }), extra)
  const edit = (s, rel) => call(NB, ev(s, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(KITTEN, rel) } }))
  const stop = (s, text) => call(NB, ev(s, 'Stop', { last_assistant_message: text, stop_hook_active: false }))
  const start = (s, source, cwd) => call(NB, ev(s, 'SessionStart', { source }, cwd))
  const injected = (out) => (out ? JSON.parse(out).hookSpecificOutput.additionalContext : '')

  test('your words come back verbatim after a compaction', () => {
    const s = fresh()
    say(s, 'quando un gattino mangia deve fare un verso. Non toccare arena.ts')
    assert.match(injected(start(s, 'compact')), /quando un gattino mangia deve fare un verso\. Non toccare arena\.ts/)
  })

  test('a new session gets nothing; an empty notebook injects nothing', () => {
    const s = fresh()
    assert.equal(start(s, 'compact'), '')
    say(s, 'ciao')
    assert.equal(start(s, 'startup'), '')
  })

  test('the files Claude changed: relative to the project, each once, latest last', () => {
    const s = fresh()
    say(s, 'aggiungi il verso')
    edit(s, 'src/audio.ts')
    edit(s, 'src/cat.ts')
    edit(s, 'src/audio.ts')
    assert.match(injected(start(s, 'compact')), /src\/cat\.ts, src\/audio\.ts/)
  })

  test('a turn that changed files leaves one line of what it did; a chat turn leaves none', () => {
    const s = fresh()
    say(s, 'aggiungi il verso')
    stop(s, 'Solo una risposta, nessuna modifica.')
    edit(s, 'src/audio.ts')
    stop(s, '**Aggiunto il verso quando il gattino mangia.**\n\nCome provarlo: premi T.')
    const ctx = injected(start(s, 'compact'))
    assert.match(ctx, /Aggiunto il verso quando il gattino mangia\./)
    assert.doesNotMatch(ctx, /Solo una risposta|Come provarlo|\*\*/)
  })

  test('/clear hands the notebook to the session it starts', () => {
    const a = fresh()
    const b = fresh()
    say(a, 'usa miao2.wav, non miao1')
    call(NB, ev(a, 'SessionEnd', { reason: 'clear' }))
    assert.match(injected(start(b, 'clear')), /usa miao2\.wav, non miao1/)
    say(b, 'ora abbassa il volume')
    assert.match(injected(start(b, 'compact')), /usa miao2\.wav, non miao1[\s\S]*ora abbassa il volume/)
  })

  test('/clear in another project does not pick it up', () => {
    const a = fresh()
    const b = fresh()
    const other = path.join(SANDBOX, 'Altro')
    call(NB, ev(a, 'UserPromptSubmit', { prompt: 'solo per Altro' }, other))
    call(NB, ev(a, 'SessionEnd', { reason: 'clear' }, other))
    assert.equal(start(b, 'clear'), '')
  })

  test('it fits in what Claude Code will inject, newest requests kept', () => {
    const s = fresh()
    for (let i = 0; i < 40; i++) say(s, `richiesta ${i} ` + 'x'.repeat(1400))
    say(s, 'ultima richiesta')
    const ctx = injected(start(s, 'compact'))
    assert.ok(ctx.length <= 10000, 'too long: ' + ctx.length)
    assert.match(ctx, /ultima richiesta/)
    assert.match(ctx, /left out/)
  })

  test('a readable .md named after the project', () => {
    const s = fresh()
    say(s, 'aggiungi il verso')
    const md = path.join(BOOK, 'KittenCare-' + s.slice(-8) + '.md')
    assert.ok(fs.existsSync(md), 'missing ' + md)
    assert.match(fs.readFileSync(md, 'utf8'), /aggiungi il verso/)
  })

  test('a commit suggests /clear', () => {
    const s = fresh()
    const out = call(NB, ev(s, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git add -A && git commit -m "verso"' } }))
    assert.match(JSON.parse(out).systemMessage, /\/clear/)
    assert.equal(call(NB, ev(s, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git status' } })), '')
  })

  test('the OFF switch keeps it silent', () => {
    const s = fresh()
    say(s, 'non segnarlo', { PUGI_OFF: '1' })
    assert.equal(start(s, 'compact'), '')
  })
})

// ------------------------------------------------------------------ install.cjs

describe('install.cjs', () => {
  const SETTINGS = path.join(HOME, '.claude', 'settings.json')
  const install = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'install.cjs'), ...args], { encoding: 'utf8', env: env() })
  const count = (re) =>
    Object.values(JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).hooks || {})
      .flat()
      .filter((e) => (e.hooks || []).some((h) => re.test(h.command))).length
  const MINE = { hooks: [{ type: 'command', command: 'echo mine' }] }

  test('the notebook is opt-in, stays once chosen, and never touches other hooks', () => {
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true })
    fs.writeFileSync(SETTINGS, JSON.stringify({ hooks: { Stop: [MINE] } }))
    install()
    assert.equal(count(/pugi-notebook/), 0)
    assert.equal(count(/pugi(-bash|-agents)?\.cjs/), 3)
    install('--notebook')
    install('--notebook')
    assert.equal(count(/pugi-notebook/), 7)
    install()
    assert.equal(count(/pugi-notebook/), 7)
    install('--no-notebook')
    assert.equal(count(/pugi-notebook/), 0)
    install('--uninstall')
    assert.equal(count(/pugi/), 0)
    assert.deepEqual(JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).hooks.Stop, [MINE])
  })
})
