/**
 * The effort router's word lists, learned from the user's own transcripts.
 * A library: no side effects on require. `bench/effort-score.cjs` is the
 * command line for it, and `install.cjs` calls it at install time.
 *
 * Every typed prompt opened a turn, and the transcript says what that turn
 * cost: thinking tokens, tool calls, requests. Within each effort level the
 * session ran at, the top third of turns by thinking are "hard" and the bottom
 * third "easy". A word or pair of words that shows up in hard turns far more
 * often than its share is a hard signal; one that shows up in easy turns is a
 * mechanical one. No language is assumed: the words come out in whatever the
 * user writes. Prompts of a few characters that repeat are continuations.
 *
 * Nothing learned is trusted on the data it was learned from. Sessions are
 * split in two halves; the lists learned on one are judged on the other by
 * how often they rank a hard turn above an easy one (0.5 is a coin flip).
 */

const fs = require('node:fs')
const path = require('node:path')
const { transcripts, messages, typed, CHARS_PER_TOKEN, W, ROOT } = require(path.join(__dirname, '..', 'measure-context.cjs'))
const { build, LEVELS } = require(path.join(__dirname, '..', 'hooks', 'pugi-effort.cjs'))

const COMBINING = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g')
const strip = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(COMBINING, '')
    .toLowerCase()
const words = (text) => strip(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 3)

// ---------------------------------------------------------------------------
// The turns.

/** Every typed prompt of the last `days` days with what its turn cost, in session order. */
function collect(days, root = ROOT) {
  const since = Date.now() - days * 864e5
  const turns = []
  let totalCost = 0
  for (const file of transcripts(root, [], since)) {
    const msgs = messages(file)
    if (!msgs) continue
    const session = path.basename(file, '.jsonl')
    const mine = []
    let turn = null
    const close = () => {
      if (!turn) return
      for (const rec of turn.reqs.values()) {
        const u = rec.u
        const counted = u.output_tokens_details && u.output_tokens_details.thinking_tokens
        turn.thinking += typeof counted === 'number' ? counted : Math.max(0, (u.output_tokens || 0) - rec.visible / CHARS_PER_TOKEN)
        turn.calls += rec.calls
        turn.requests++
        const w1h = (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0
        totalCost += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) * W.read + w1h * W.write1h + Math.max(0, (u.cache_creation_input_tokens || 0) - w1h) * W.write5m + (u.output_tokens || 0) * W.output
      }
      delete turn.reqs
      mine.push(turn)
      turn = null
    }
    for (const m of msgs) {
      if (m.isSidechain) continue
      const t = typed(m)
      if (t) {
        close()
        turn = { text: t, session, when: Date.parse(m.timestamp || '') || 0, thinking: 0, calls: 0, requests: 0, effort: null, reqs: new Map() }
        continue
      }
      if (!turn || m.type !== 'assistant' || !m.message) continue
      const u = m.message.usage
      const id = u && (m.message.id || m.requestId)
      if (!id) continue
      let rec = turn.reqs.get(id)
      if (!rec) {
        rec = { u, visible: 0, calls: 0 }
        turn.reqs.set(id, rec)
        turn.effort = turn.effort || m.effort || null
        if (!turn.sid) turn.sid = m.sessionId || m.session_id || session
      }
      // The effort the turn ended up running at: the last request's, after any skill the agent invoked.
      if (m.perTurnEffort) turn.perTurn = m.perTurnEffort
      rec.u = u // streaming: the last line carries the final usage
      const c = m.message.content
      if (Array.isArray(c))
        for (const b of c) {
          if (!b) continue
          if (b.type === 'text') rec.visible += (b.text || '').length
          else if (b.type === 'tool_use') {
            rec.visible += JSON.stringify(b.input || {}).length
            rec.calls++
          }
        }
    }
    close()
    // How many requests came after each turn in its session: what re-reads its thinking.
    const total = mine.reduce((s, t) => s + t.requests, 0)
    let done = 0
    for (const t of mine) {
      done += t.requests
      t.after = total - done
    }
    turns.push(...mine)
  }
  return { turns, totalCost }
}

/** Scores every turn in session order, so a continuation sees the previous turn's level. */
function scoreAll(score, turns) {
  let prev = null
  let last = null
  for (const t of turns) {
    if (t.session !== last) {
      prev = null
      last = t.session
    }
    const r = score(t.text, prev)
    prev = r.level
    t.level = r.level
    t.score = r.score
    t.signals = r.signals
  }
  return turns
}

// ---------------------------------------------------------------------------
// The language.

const STOPWORDS = {
  en: 'the and is are to of that it this with for you what how not can does do have but'.split(' '),
  it: 'che non per come questo questa della delle sono anche una con gli nel nella cosa perche quindi ora'.split(' '),
  es: 'que para como esto pero una con los las por del este esta hay tiene puedo'.split(' '),
  fr: 'que pour comme mais avec les des une est pas dans sur cette peux fait'.split(' '),
  de: 'und nicht das ist mit fur auch eine der die ich kann wie was aber'.split(' '),
  pt: 'que nao para como mas com uma isso este esta pode faz por dos das'.split(' '),
}
for (const k of Object.keys(STOPWORDS)) STOPWORDS[k] = new Set(STOPWORDS[k])

/** The language the prompts are written in, by the words no language can do without; null when there is too little to say. */
function detectLanguage(texts) {
  const counts = {}
  let total = 0
  for (const t of texts)
    for (const w of words(t))
      for (const [lang, set] of Object.entries(STOPWORDS))
        if (set.has(w)) {
          counts[lang] = (counts[lang] || 0) + 1
          total++
        }
  if (total < 20) return null
  const [lang, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  return { lang, share: n / total, prompts: texts.length }
}

// ---------------------------------------------------------------------------
// The learning.

/** Labels each turn hard (1), easy (0) or neither (null): thinking terciles within the effort level the session ran at. */
function label(turns) {
  const groups = {}
  for (const t of turns) (groups[t.effort || '?'] = groups[t.effort || '?'] || []).push(t)
  for (const g of Object.values(groups)) {
    const s = g.map((t) => t.thinking).sort((a, b) => a - b)
    const lo = s[Math.floor(s.length / 3)]
    const hi = s[Math.floor((2 * s.length) / 3)]
    for (const t of g) t.hard = g.length < 9 ? null : t.thinking >= hi ? 1 : t.thinking <= lo ? 0 : null
  }
  return turns
}

/** A word no language can do without says nothing about the request; the `long` signal already counts what they add up to. */
const isStop = (w) => Object.values(STOPWORDS).some((set) => set.has(w))
const terms = (text) => {
  const ws = words(text)
  const out = new Set(ws.filter((w) => !isStop(w)))
  for (let i = 0; i + 1 < ws.length; i++) if (!isStop(ws[i]) || !isStop(ws[i + 1])) out.add(ws[i] + ' ' + ws[i + 1])
  return out
}

/** Word lists learned from turns: hard words split in two tiers (design +2, why +1), easy words as mechanical (−2), repeated tiny prompts as continuations. */
function learn(turns, opts = {}) {
  label(turns)
  const labeled = turns.filter((t) => t.hard !== null)
  const min = opts.min || Math.max(5, Math.round(labeled.length / 60))
  const stat = new Map()
  let hardAll = 0
  for (const t of labeled) {
    hardAll += t.hard
    for (const term of terms(t.text)) {
      const s = stat.get(term) || { n: 0, hard: 0 }
      s.n++
      s.hard += t.hard
      stat.set(term, s)
    }
  }
  const base = (hardAll + 1) / (labeled.length + 2)
  const rows = []
  for (const [term, s] of stat) {
    if (s.n < min) continue
    const lift = Math.log((s.hard + 1) / (s.n + 2) / base)
    rows.push({ term, n: s.n, lift, conf: Math.abs(lift) * Math.sqrt(s.n) })
  }
  // A pair adds nothing when one of its words already made the list on its own.
  const pick = (list) => {
    const out = []
    for (const r of list) {
      if (out.length >= (opts.cap || 24)) break
      if (r.term.includes(' ') && r.term.split(' ').some((w) => out.some((o) => o.term === w))) continue
      out.push(r)
    }
    return out
  }
  const hard = pick(rows.filter((r) => r.lift > 0.4).sort((a, b) => b.conf - a.conf))
  const easy = pick(rows.filter((r) => r.lift < -0.4).sort((a, b) => b.conf - a.conf))
  // A tiny prompt that repeats is a continuation, unless it is already a word of another kind ("concise" asks for speed, not for more of the same).
  const known = build('/dev/null/none').words
  const taken = new Set([...known.fast.words, ...known.mechanical.words, ...(opts.taken || [])])
  const tiny = {}
  for (const t of turns) {
    const s = strip(t.text).trim()
    if (s.length <= 12 && /^[a-z][a-z ]*$/.test(s) && !taken.has(s)) tiny[s] = (tiny[s] || 0) + 1
  }
  const half = Math.ceil(hard.length / 2)
  return {
    design: { words: hard.slice(0, half).map((r) => r.term) },
    why: { words: hard.slice(half).map((r) => r.term) },
    mechanical: { words: easy.map((r) => r.term) },
    continue: Object.entries(tiny)
      .filter(([, n]) => n >= 5)
      .map(([s]) => s),
    _learned: { prompts: turns.length, labeled: labeled.length, min },
  }
}

/** How often a scorer ranks a hard turn above an easy one, 0.5 being a coin flip; null when there are no pairs to judge. */
function separation(score, turns) {
  label(turns)
  const num = { low: -2, medium: 0, high: 1, xhigh: 2, max: 3 }
  scoreAll(score, turns)
  const H = turns.filter((t) => t.hard === 1).map((t) => num[t.level])
  const E = turns.filter((t) => t.hard === 0).map((t) => num[t.level])
  if (!H.length || !E.length) return null
  let wins = 0
  let ties = 0
  for (const h of H)
    for (const e of E) {
      if (h > e) wins++
      else if (h === e) ties++
    }
  return (wins + ties / 2) / (H.length * E.length)
}

/** Sessions split in two halves by a hash of their id, deterministic and independent of order. */
function split(turns) {
  const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
  const a = turns.filter((t) => hash(t.session) % 2 === 0)
  const b = turns.filter((t) => hash(t.session) % 2 === 1)
  return [a, b]
}

/** Two packs as one: the second's words after the first's, each word once. */
function merge(a, b) {
  const out = JSON.parse(JSON.stringify(a || {}))
  const uniq = (xs) => [...new Set(xs)]
  for (const key of ['why', 'design', 'debug', 'mechanical', 'fast']) {
    if (!b || !b[key]) continue
    out[key] = out[key] || {}
    out[key].words = uniq((out[key].words || []).concat(b[key].words || []))
    if (typeof b[key].weight === 'number') out[key].weight = b[key].weight
  }
  if (b && b.continue) out.continue = uniq((out.continue || []).concat(b.continue))
  return out
}

/**
 * Learn on half the sessions, judge on the other half against the English
 * defaults and the current user file; report. With `write`, and only when the
 * learned lists win on the held-out half, learn again on everything and write
 * the user file (merged with the pack already there when that pack is ours).
 */
function learnAndJudge({ days = 30, file, mark, write = false, minPrompts = 100, root = ROOT } = {}) {
  const { turns } = collect(days, root)
  const out = { prompts: turns.length, days }
  if (turns.length < minPrompts) return { ...out, verdict: 'not enough history' }
  const [a, b] = split(turns)
  let current = null
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {}
  const ours = current && current._written_by === mark
  const baseline = ours ? current : null
  const taken = baseline ? [...((baseline.fast && baseline.fast.words) || []), ...((baseline.mechanical && baseline.mechanical.words) || [])] : []
  const learned = learn(a, { taken })
  out.defaults = separation(build('/dev/null/none').score, b)
  out.current = current ? separation(build(current).score, b) : null
  out.learned = separation(build(merge(baseline, learned)).score, b)
  out.words = learned.design.words.length + learned.why.words.length + learned.mechanical.words.length
  const best = Math.max(out.defaults || 0, out.current || 0)
  if (out.learned === null || out.learned < best + 0.02) return { ...out, verdict: 'kept: the learned words do not beat what is there on held-out sessions' }
  if (!write) return { ...out, verdict: 'learned words win on held-out sessions; not written' }
  if (current && !ours) return { ...out, verdict: 'learned words win, but ' + file + ' was not written by us: left alone' }
  const all = learn(turns, { taken })
  const full = merge(baseline, all)
  full._written_by = mark
  full._learned = { ...all._learned, heldout: out.learned, defaults: out.defaults, when: new Date().toISOString().slice(0, 10) }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(full, null, 2) + '\n')
  return { ...out, verdict: 'written: ' + file }
}

/** Learn on one set, judge on another: the defaults alone against the defaults plus what was learned. */
function judgeSplit(train, test, baseline, taken) {
  const learned = learn(train, { taken })
  return {
    train: train.length,
    test: test.length,
    defaults: separation(build('/dev/null/none').score, test),
    learned: separation(build(merge(baseline, learned)).score, test),
    words: learned.design.words.length + learned.why.words.length + learned.mechanical.words.length,
  }
}

/**
 * Three harder checks than one split: k folds by session, so every session is
 * judged once by words that never saw it; a split by time, learning on the
 * first three quarters and judging on the last; and a learning curve, the last
 * n prompts before the time cut judged on what came after.
 */
function checks({ days = 30, file, mark, root = ROOT, folds = 5 } = {}) {
  const { turns } = collect(days, root)
  let current = null
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {}
  // The words already learned on this very history would leak into the judgement: the baseline is the language pack alone, if any.
  let baseline = null
  if (current && current._written_by === mark) {
    const pack = current._lang && path.join(__dirname, '..', 'hooks', 'effort-words.' + current._lang + '.json')
    if (pack && fs.existsSync(pack)) baseline = JSON.parse(fs.readFileSync(pack, 'utf8'))
    else if (!current._learned) baseline = current
  }
  const taken = baseline ? [...((baseline.fast && baseline.fast.words) || []), ...((baseline.mechanical && baseline.mechanical.words) || [])] : []
  const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
  const out = { prompts: turns.length, days, folds: [], temporal: null, curve: [] }
  if (turns.length < 100) return out
  for (let i = 0; i < folds; i++) {
    const test = turns.filter((t) => hash(t.session) % folds === i)
    const train = turns.filter((t) => hash(t.session) % folds !== i)
    if (test.length >= 20) out.folds.push(judgeSplit(train, test, baseline, taken))
  }
  const sorted = [...turns].sort((a, b) => a.when - b.when)
  const cut = Math.floor(sorted.length * 0.75)
  out.temporal = judgeSplit(sorted.slice(0, cut), sorted.slice(cut), baseline, taken)
  for (const n of [50, 100, 200, 400, 800]) if (n <= cut) out.curve.push({ n, ...judgeSplit(sorted.slice(cut - n, cut), sorted.slice(cut), baseline, taken) })
  return out
}

module.exports = { collect, scoreAll, detectLanguage, label, learn, separation, split, merge, learnAndJudge, checks, LEVELS }
