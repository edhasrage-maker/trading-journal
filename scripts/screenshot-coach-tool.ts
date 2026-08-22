/** The Coach — one page for the whole workstream.
 *
 *   npx tsx scripts/screenshot-coach-tool.ts
 *   npx tsx scripts/screenshot-coach-tool.ts --port=5178 --in=<jsonl>
 *
 *  The screenshot collection, one trade's verdict, the coach's answer to what
 *  the trader himself said about it, the read across whatever set is on screen,
 *  and a conversation about that set — in one place instead of four scripts and
 *  three output files. The page is served rather than written to disk because
 *  the chat and the commentary replies are model calls, and the key cannot live
 *  in a static file.
 *
 *  COST SHAPE: image calls are NEVER spent here, by construction — this file
 *  contains no image plumbing at all. Screenshots go to the browser as signed
 *  URLs, for the trader's eyes; the coach talks from bar-derived truth, the
 *  cached per-trade reads, and deterministic stats. Signed URLs expire ~7 days
 *  after the harness pull — re-run the harness to refresh them.
 *
 *  Pieces folded in: read.ts (the per-trade verdict, read from its cache),
 *  board.ts (aggregate + chat), review-sheet.ts (the tape/context strip),
 *  lens.ts (the one shared voice). This coach never calls /api/coach — it is
 *  independent of the site's EOD coach by design.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs'
import { join, dirname } from 'path'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import Anthropic from '@anthropic-ai/sdk'
import { XY_LENS, COMMENTARY_ENGAGEMENT } from './screenshot-coach-lens'

const argv = process.argv.slice(2)
const argVal = (n: string): string | null => argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? null
const IN_PATH = argVal('in') ?? join(process.cwd(), 'evals', 'screenshot-coach', 'unlabelled-trades.jsonl')
const PORT = Number(argVal('port') ?? 5178)
const MODEL = argVal('model') ?? 'claude-sonnet-5'
const OUT_DIR = dirname(IN_PATH)
const CACHE_PATH = join(OUT_DIR, 'tool-commentary.json')
const CHAT_LOG = join(OUT_DIR, 'tool-chat.md')

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
const anthropic = new Anthropic()

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>

const rows: Row[] = readFileSync(IN_PATH, 'utf8').split(/\r?\n/).filter(Boolean)
  .map(l => JSON.parse(l)).filter(r => r.frame?.signed_url)
rows.sort((a, b) => String(b.entry_pt).localeCompare(String(a.entry_pt)))

// Cached per-trade coach reads — the current file plus the pre-XY backup, so
// older verdicts still show on their cards, marked with their vintage.
type Cached = { verdict: string; read: string; on_your_read: string | null; vintage: string }
const readsBy = new Map<string, Cached>()
for (const [file, vintage] of [['reads-v4-preXY.jsonl.bak', 'v4'], ['reads.jsonl', 'current']] as const) {
  const p = join(OUT_DIR, file)
  if (!existsSync(p)) continue
  for (const l of readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const o = JSON.parse(l)
    if (o.write?.verdict) readsBy.set(o.trade_id, { verdict: o.write.verdict, read: o.write.read, on_your_read: o.write.on_your_read ?? null, vintage })
  }
}
const anchoredSet = new Set<string>(existsSync(join(OUT_DIR, 'anchored-ids.json'))
  ? JSON.parse(readFileSync(join(OUT_DIR, 'anchored-ids.json'), 'utf8')) : [])

// Commentary replies are cached to disk — the same trade should not cost a
// second call just because the page was reloaded.
const commentaryCache: Record<string, { text: string; at: string }> =
  existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {}

const ctx = (r: Row) => r.truth?.context ?? {}
const ex = (r: Row) => r.truth?.exit ?? {}
const pnlOf = (r: Row): number => r.truth?.exit?.pnl ?? 0
function weekOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  const mon = new Date(dt); mon.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7))
  return mon.toISOString().slice(0, 10)
}
const tagsOf = (r: Row): string[] => {
  const c = r.claim ?? {}
  if (Array.isArray(c.tags)) return c.tags
  return ['setups', 'confluences', 'order_flow', 'entry_model', 'trade_management', 'mistakes', 'emotions']
    .flatMap(k => Array.isArray(c[k]) ? c[k] : [])
}
const noteOf = (r: Row): string => String(r.claim?.read ?? r.claim?.notes ?? '').trim()

// ── what the page gets ────────────────────────────────────────────────────
function pageRow(r: Row) {
  const m = ctx(r).session_momentum
  const p = ctx(r).session_profile_at_entry
  const cached = readsBy.get(r.trade_id)
  return {
    id: r.trade_id, date: r.date, week: weekOf(r.date),
    time: String(r.entry_pt ?? '').slice(11, 16),
    direction: r.direction, symbol: r.symbol, url: r.frame.signed_url,
    pnl: pnlOf(r), r_multiple: ex(r).r_multiple ?? null, capture_pct: ex(r).capture_pct ?? null,
    mfe_atr: ex(r).mfe_atr ?? null, mae_atr: ex(r).mae_atr ?? null,
    post_exit_favorable_atr: ex(r).post_exit_favorable_atr ?? null,
    post_exit_against_atr: ex(r).post_exit_against_atr ?? null,
    entry_price: r.truth?.entry_price ?? null, exit_price: r.truth?.exit_price ?? null,
    stop_price: r.truth?.stop_price ?? null, tp1_price: r.truth?.tp1_price ?? null,
    nearest: r.truth?.location?.nearest ?? null,
    chase_atr: r.truth?.chase?.run_before_entry_atr ?? null,
    momentum: m ? { trade_is: m.trade_is, label: m.label, why_not: m.not_offsides_because ?? null } : null,
    profile: p ? { zone: p.zone, node: p.node } : null,
    htf: ctx(r).htf_alignment ?? null,
    runway: ctx(r).runway ?? [],
    swings: ctx(r).swing_structure_5m ? { label: ctx(r).swing_structure_5m.label, trade_is: ctx(r).swing_structure_5m.trade_is } : null,
    atr_vs_typical: ctx(r).atr_vs_typical ?? null,
    ib: [ctx(r).ib_regime, ctx(r).ib_size_band].filter(Boolean).join(' / ') || null,
    attempts: ctx(r).attempts_before?.count ?? 0,
    tp_vs_reference: ex(r).tp1_vs_reference ?? null, tp_missed_by_pts: ex(r).tp1_missed_by_pts ?? null,
    stop_terrain: ex(r).stop_terrain ?? null,
    tags: tagsOf(r), note: noteOf(r),
    coach: cached ? { verdict: cached.verdict, read: cached.read, on_your_read: cached.on_your_read, vintage: cached.vintage } : null,
    commentary: commentaryCache[r.trade_id]?.text ?? null,
    anchored: anchoredSet.has(r.trade_id),
  }
}

// ── the digest the model talks from ───────────────────────────────────────
function digest(r: Row): Record<string, unknown> {
  const m = ctx(r).session_momentum
  const cached = readsBy.get(r.trade_id)
  return {
    key: r.entry_pt, direction: r.direction, symbol: r.symbol, pnl: pnlOf(r),
    r_multiple: ex(r).r_multiple, capture_pct: ex(r).capture_pct, mfe_atr: ex(r).mfe_atr,
    post_exit_favorable_atr: ex(r).post_exit_favorable_atr,
    momentum: m ? { trade_is: m.trade_is, label: m.label } : null,
    profile: ctx(r).session_profile_at_entry ? { zone: ctx(r).session_profile_at_entry.zone, node: ctx(r).session_profile_at_entry.node } : null,
    htf: ctx(r).htf_alignment ?? null,
    attempts_before: ctx(r).attempts_before?.count ?? 0,
    chase_atr: r.truth?.chase?.run_before_entry_atr ?? null,
    nearest_level: r.truth?.location?.nearest ?? null,
    runway: (ctx(r).runway ?? [])[0] ?? null,
    tp: { vs_reference: ex(r).tp1_vs_reference, missed_by_pts: ex(r).tp1_missed_by_pts, terrain: ex(r).tp_terrain },
    stop_terrain: ex(r).stop_terrain,
    coach_verdict: cached ? { verdict: cached.verdict, vintage: cached.vintage } : null,
    trader_tags: tagsOf(r), trader_note: noteOf(r) || null,
  }
}

const midNode = (r: Row) => {
  const p = ctx(r).session_profile_at_entry
  return p?.node === 'HVN' && String(p?.zone ?? '').startsWith('inside value')
}
function stats(list: Row[]): Record<string, string> {
  const n = list.length
  if (!n) return {}
  const wins = list.filter(r => pnlOf(r) > 0).length
  const pnl = list.reduce((s, r) => s + pnlOf(r), 0)
  const wr = (xs: Row[]) => xs.length ? `${xs.filter(r => pnlOf(r) > 0).length}/${xs.length}` : '0/0'
  const rep = list.filter(r => (ctx(r).attempts_before?.count ?? 0) >= 2)
  const hvn = list.filter(midNode)
  const caps = list.map(r => ex(r).capture_pct).filter((x: any) => x != null).sort((a: number, b: number) => a - b)
  const zeroCap = list.filter(r => ex(r).capture_pct === 0 && (ex(r).mfe_atr ?? 0) >= 1).length
  const tpParked = list.filter(r => ['parked_at', 'near'].includes(ex(r).tp1_vs_reference?.band)).length
  const stopInNode = list.filter(r => ex(r).stop_terrain?.inside_entry_node === true).length
  const off = list.filter(r => ctx(r).session_momentum?.trade_is === 'offsides')
  const weak = list.filter(r => ctx(r).session_momentum?.trade_is === 'against_weak').length
  const withM = list.filter(r => ctx(r).session_momentum?.trade_is === 'with').length
  return {
    'trades': `${n} — ${wins}/${n} won, ${pnl >= 0 ? '+' : ''}$${Math.round(pnl)}`,
    'median capture': caps.length ? `${caps[Math.floor(caps.length / 2)]}%  ·  ${zeroCap} took 0% of a ≥1 ATR move` : '—',
    'mid-node entries': `${hvn.length} of ${n} (won ${wr(hvn)})`,
    'repeat attempts (2nd+)': `${rep.length} of ${n} (won ${wr(rep)})`,
    'stop inside entry node': `${stopInNode} of ${n}`,
    'TP parked at/near a reference': `${tpParked} of ${n}`,
    'momentum': `${withM} with · ${off.length} offsides (won ${wr(off)}) · ${weak} against a read too weak to call`,
  }
}

// ── the coach's two text-only voices ──────────────────────────────────────
const NUMBERS_RULE = `Every number you state must come from the DATA block; counts must be countable from it. Talk about trades by their key (date and time). Never narrate orderflow the bars cannot show — no absorption, delta, exhaustion or trapped-order stories.`

const AGG_SYSTEM = `You are this trader's screenshot coach, looking across a SET of his trades to find the patterns one trade cannot show. You have NOT seen these charts here — you have each trade's bar-derived truth, context, his own tags and notes, and (for some) your own earlier per-trade verdict. ${NUMBERS_RULE}

${XY_LENS}

If an input is not a question about these trades (a shell command, a stray paste), say so in ONE sentence and suggest a question he could ask — do not speculate about tools or ask him to paste anything.

For an aggregate read: lead with the ONE pattern that most costs (or makes) him money in this set, with its count and dollars/R. Then two or three more, each with counts, in weight order. Compare against the baseline only where the difference is the point. End with the single thing you would have him do differently next week — concrete, checkable, from the data.

OFFSIDES IS NEVER THE HEADLINE. Going against session momentum is a placement observation, not this trader's leak: across his whole book the offsides trades win at the same rate and make the same money as the rest. Give it at most ONE line, never the lead, and only when this set's own numbers make it worth a line. It has to earn its place against capture, stop placement, repeat attempts and TP placement — which are where his dollars actually move.

His account of a trade (trader_tags, trader_note) is input, not truth: where the set shows he keeps blaming one thing and the bars keep showing another, that gap is worth a line.

Plain, direct, second person, his register — one sharp line at most, never mockery. Outcome is never a reason a trade was good or bad.`

const COMMENTARY_SYSTEM = `You are this trader's screenshot coach, answering what HE said about ONE of his trades. You have not seen the chart here — you have the bar-derived truth for the trade, and (when it exists) the verdict you already wrote on it. ${NUMBERS_RULE}

${XY_LENS}

${COMMENTARY_ENGAGEMENT}

Write two to four sentences. No preamble, no headers, no bullets, and do not restate the verdict — it is already on the page above your reply. Answer him.`

async function say(system: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>, maxTokens = 4000): Promise<string> {
  const msg = await anthropic.messages.create({
    model: MODEL, max_tokens: maxTokens, system,
    output_config: { effort: 'medium' },
    messages,
  })
  const t = msg.content.find(b => b.type === 'text')
  if (t && t.type === 'text') return t.text
  return msg.stop_reason === 'max_tokens'
    ? '(the reply ran out of room before any text came back — narrow the set with a filter and ask again)'
    : `(no text: ${msg.stop_reason})`
}

function dataBlock(ids: string[]): string {
  const set = ids.length ? rows.filter(r => ids.includes(r.trade_id)) : rows
  return [
    `THE SET ON SCREEN: ${set.length} trades.`,
    `SET STATS (deterministic):`, JSON.stringify(stats(set), null, 1),
    `BASELINE — ALL ${rows.length} TRADES:`, JSON.stringify(stats(rows), null, 1),
    `TRADES (bar-derived truth is the only source of numbers; trader_tags and trader_note are HIS account, not truth):`,
    JSON.stringify(set.map(digest), null, 1),
  ].join('\n')
}

// ── server ────────────────────────────────────────────────────────────────
function body(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let b = ''
    req.on('data', c => { b += c })
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}) } catch (e) { reject(e) } })
  })
}
const json = (res: ServerResponse, code: number, o: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o))
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/?'))) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page()); return
    }
    if (req.method === 'POST' && req.url === '/api/aggregate') {
      const { ids } = await body(req)
      const text = await say(AGG_SYSTEM + '\n\n' + dataBlock(ids ?? []), [{ role: 'user', content: 'Give the aggregate read for this set.' }])
      json(res, 200, { text }); return
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      const { ids, messages } = await body(req)
      const text = await say(AGG_SYSTEM + '\n\n' + dataBlock(ids ?? []), messages ?? [])
      const last = (messages ?? []).filter((m: any) => m.role === 'user').pop()
      appendFileSync(CHAT_LOG, `\n**you:** ${last?.content ?? ''}\n\n**coach:** ${text}\n`, 'utf8')
      json(res, 200, { text }); return
    }
    if (req.method === 'POST' && req.url === '/api/commentary') {
      const { id, regenerate } = await body(req)
      const r = rows.find(x => x.trade_id === id)
      if (!r) { json(res, 404, { error: 'no such trade' }); return }
      if (!regenerate && commentaryCache[id]) { json(res, 200, { text: commentaryCache[id].text, cached: true }); return }
      const cached = readsBy.get(id)
      const prompt = [
        `TRADE: ${r.direction} ${r.symbol}, entered ${r.entry_pt}, exited ${r.exit_pt ?? 'unknown'}.`,
        ``, `TRUTH (bar-derived; the only source of numbers):`, JSON.stringify(digest(r), null, 1),
        ``, `YOUR VERDICT ON THIS TRADE (already written, already on his screen):`,
        cached ? `${cached.verdict} — ${cached.read}` : '(none yet — judge his account against the truth above)',
        ``, `HIS OWN ACCOUNT — tags: ${JSON.stringify(tagsOf(r))}`,
        `his note: ${noteOf(r) || '(none)'}`,
        ``, `Answer him.`,
      ].join('\n')
      const text = await say(COMMENTARY_SYSTEM, [{ role: 'user', content: prompt }], 1500)
      commentaryCache[id] = { text, at: new Date().toISOString() }
      writeFileSync(CACHE_PATH, JSON.stringify(commentaryCache, null, 1), 'utf8')
      json(res, 200, { text, cached: false }); return
    }
    res.writeHead(404); res.end('not found')
  } catch (e: any) {
    console.error(e)
    json(res, 500, { error: String(e?.message ?? e) })
  }
})

server.listen(PORT, () => {
  console.log(`
The Coach — http://localhost:${PORT}
  ${rows.length} trades  ·  ${readsBy.size} with a cached verdict  ·  ${Object.keys(commentaryCache).length} with a commentary reply
  model ${MODEL}, text-only — this tool makes no image calls.
  chat is appended to ${CHAT_LOG}
Ctrl+C to stop.
`)
})

// ── the page ──────────────────────────────────────────────────────────────
function page(): string {
  // Embedded rather than fetched: the set is small, and one payload means the
  // grid, the filters and the detail view can never disagree about a trade.
  const data = JSON.stringify(rows.map(pageRow)).replace(/</g, '\u003c')
  return `<!doctype html><html><head><meta charset="utf-8"><title>The Coach</title>
<style>
:root{--bg:#0f1115;--card:#161a22;--line:#242a35;--fg:#e6e8ee;--mute:#8b93a7;--blue:#4c8dff;--green:#3ddc84;--red:#ff5d5d;--amber:#f5b342}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,Segoe UI,Inter,sans-serif}
h1{font-size:16px;margin:0}
.bar{position:sticky;top:0;z-index:20;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
select,input,button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 9px;font:inherit}
button{cursor:pointer}button:hover{border-color:var(--blue)}
button.primary{background:var(--blue);border-color:var(--blue);color:#06101f;font-weight:600}
button:disabled{opacity:.5;cursor:default}
.count{color:var(--mute);margin-left:auto}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px;padding:14px 18px}
.stats div{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:9px 11px;font-size:12.5px}
.stats b{color:var(--mute);font-weight:600;display:block;margin-bottom:2px;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.agg{margin:0 18px 14px;background:var(--card);border:1px solid var(--line);border-left:3px solid var(--blue);border-radius:8px;padding:14px 16px;white-space:pre-wrap}
.agg h3{margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--mute)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;padding:0 18px 40px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden;cursor:pointer}
.card:hover{border-color:var(--blue)}
.card img{width:100%;height:150px;object-fit:cover;object-position:top left;display:block;background:#0a0c10}
.card .m{padding:8px 10px;font-size:12.5px}
.card .t{display:flex;gap:8px;align-items:baseline}
.chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}
.chip{font-size:10.5px;padding:2px 6px;border-radius:4px;background:#1e2430;color:var(--mute);border:1px solid var(--line)}
.chip.off{background:#3a1d22;color:#ffb3b3;border-color:#5a2a30}
.chip.weak{background:#2a2418;color:#e3c98a;border-color:#453a22}
.chip.good{background:#16301f;color:var(--green);border-color:#24512f}
.chip.bad{background:#331a1a;color:var(--red);border-color:#552626}
.chip.mixed{background:#2c2716;color:var(--amber);border-color:#4a411f}
.win{color:var(--green)}.loss{color:var(--red)}.mute{color:var(--mute)}
#detail{position:fixed;inset:0;background:rgba(6,8,12,.94);z-index:40;display:none;overflow:auto;padding:20px}
#detail .inner{display:grid;grid-template-columns:minmax(0,1fr) minmax(330px,420px);gap:16px;max-width:2200px;margin:0 auto;align-items:start}
.vtools{display:flex;gap:7px;align-items:center;margin-bottom:9px;flex-wrap:wrap}
.vtools button{padding:5px 10px}
.vtools .sep{width:1px;height:18px;background:var(--line)}
.vhint{font-size:11.5px}
/* The Sierra captures are two-pane and dense — fit the whole frame first,
   then let the wheel take it to native and beyond. */
#d-view{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:8px;background:#0a0c10;height:calc(100vh - 92px);cursor:zoom-in;touch-action:none}
#d-view.zoomed{cursor:grab}
#d-view.dragging{cursor:grabbing}
#d-img{position:absolute;top:0;left:0;transform-origin:0 0;max-width:none;user-select:none;-webkit-user-drag:none}
#loaderr{display:none;position:absolute;inset:0;margin:auto;height:fit-content;padding:0 40px;text-align:center;color:var(--mute);font-size:13px}
#loaderr code{color:var(--fg)}
#d-side{max-height:calc(100vh - 40px);overflow:auto;padding-right:4px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:14px}
.panel h4{margin:0 0 9px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--mute)}
table{width:100%;border-collapse:collapse;font-size:12.5px}
td{padding:3px 0;vertical-align:top}td:first-child{color:var(--mute);width:44%;padding-right:10px}
.verdict{font-size:13px;white-space:pre-wrap}
.reply{white-space:pre-wrap;border-left:3px solid var(--blue);padding-left:11px;margin-top:9px}
.note{white-space:pre-wrap;color:#cfd4e0;font-style:italic}
#chat{position:fixed;right:0;top:0;bottom:0;width:430px;background:var(--card);border-left:1px solid var(--line);z-index:50;display:none;flex-direction:column}
#chat header{padding:12px 14px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px}
#log{flex:1;overflow:auto;padding:14px}
#log .u{margin:0 0 5px;color:var(--mute);font-size:12px}
#log .a{white-space:pre-wrap;margin:0 0 18px;border-left:3px solid var(--blue);padding-left:11px}
#chat form{display:flex;gap:8px;padding:12px;border-top:1px solid var(--line)}
#chat input{flex:1;min-width:0}
.spin{color:var(--mute);font-style:italic}
.hint{color:var(--mute);font-size:12px;padding:0 18px 10px}
.empty{color:var(--mute);padding:30px 18px}
</style></head><body>
<div class="bar">
  <h1>The Coach</h1>
  <select id="f-momentum"><option value="">momentum: any</option><option value="offsides">offsides</option><option value="against_weak">against (weak)</option><option value="with">with</option></select>
  <select id="f-verdict"><option value="">verdict: any</option><option value="good">good</option><option value="mixed">mixed</option><option value="not_good">not good</option><option value="none">no read yet</option></select>
  <select id="f-week"><option value="">week: any</option></select>
  <select id="f-tag"><option value="">tag: any</option></select>
  <select id="f-shape"><option value="">shape: any</option><option value="zero">0% of a &#8805;1 ATR move</option><option value="midnode">mid-node entry</option><option value="repeat">2nd+ attempt</option><option value="tpparked">TP parked at a reference</option><option value="stopnode">stop inside entry node</option></select>
  <select id="f-outcome"><option value="">result: any</option><option value="win">winners</option><option value="loss">losers</option></select>
  <button id="reset">reset</button>
  <button id="read" class="primary">Read the set</button>
  <button id="openchat">Chat</button>
  <span class="count" id="count"></span>
</div>
<div class="stats" id="stats"></div>
<div id="aggwrap"></div>
<div class="hint">Click a screenshot to open the trade. Every number comes from the 1-minute bars — the coach never sees these images.</div>
<div class="grid" id="grid"></div>

<div id="detail"><div class="inner">
  <div>
    <div class="vtools">
      <button id="close">&#8592; back</button>
      <button id="prev" title="previous trade (&#8592;)">&#8249;</button>
      <span class="mute" id="pos"></span>
      <button id="next" title="next trade (&#8594;)">&#8250;</button>
      <span class="sep"></span>
      <button id="zoomout" title="zoom out (&#8722;)">&#8722;</button>
      <button id="zoomfit" title="fit the whole frame (0)">fit</button>
      <button id="zoomin" title="zoom in (+)">+</button>
      <span class="mute" id="zoomlvl"></span>
      <span class="mute vhint">scroll to zoom &#183; drag to pan &#183; click for the next &#183; &#8592;/&#8594; to flip</span>
    </div>
    <div id="d-view"><img id="d-img" alt="">
      <div id="loaderr">This screenshot did not load — its signed URL has most likely expired.
      Re-run <code>npx tsx scripts/screenshot-coach-harness.ts --unlabelled</code> and reload this page.</div>
    </div>
  </div>
  <div id="d-side"></div>
</div></div>

<div id="chat">
  <header><b>Coach</b><span class="mute" id="chat-scope"></span><button id="closechat" style="margin-left:auto">close</button></header>
  <div id="log"></div>
  <form id="chatform"><input id="q" placeholder="ask about the trades on screen&#8230;" autocomplete="off"><button class="primary">send</button></form>
</div>

<script id="data" type="application/json">${data}</script>
<script>
const T = JSON.parse(document.getElementById('data').textContent)
const $ = s => document.querySelector(s)
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))
const n1 = v => v == null ? '\u2014' : (Math.round(v * 100) / 100)
const money = v => (v >= 0 ? '+$' : '\u2212$') + Math.abs(Math.round(v))

for (const w of [...new Set(T.map(t => t.week))].sort().reverse())
  $('#f-week').insertAdjacentHTML('beforeend', '<option value="' + w + '">week of ' + w + '</option>')
for (const g of [...new Set(T.flatMap(t => t.tags))].sort())
  $('#f-tag').insertAdjacentHTML('beforeend', '<option value="' + esc(g) + '">' + esc(g) + '</option>')

const shapes = {
  zero: t => t.capture_pct === 0 && (t.mfe_atr || 0) >= 1,
  midnode: t => t.profile && t.profile.node === 'HVN' && String(t.profile.zone).startsWith('inside value'),
  repeat: t => t.attempts >= 2,
  tpparked: t => t.tp_vs_reference && ['parked_at','near'].includes(t.tp_vs_reference.band),
  stopnode: t => t.stop_terrain && t.stop_terrain.inside_entry_node === true,
}
function current() {
  const m = $('#f-momentum').value, v = $('#f-verdict').value, w = $('#f-week').value
  const g = $('#f-tag').value, s = $('#f-shape').value, o = $('#f-outcome').value
  return T.filter(t =>
    (!m || (t.momentum && t.momentum.trade_is === m)) &&
    (!v || (v === 'none' ? !t.coach : t.coach && t.coach.verdict === v)) &&
    (!w || t.week === w) && (!g || t.tags.includes(g)) &&
    (!s || shapes[s](t)) &&
    (!o || (o === 'win' ? t.pnl > 0 : t.pnl <= 0)))
}
function statsOf(list) {
  const n = list.length; if (!n) return {}
  const wins = list.filter(t => t.pnl > 0).length
  const pnl = list.reduce((s, t) => s + t.pnl, 0)
  const wr = xs => xs.length ? xs.filter(t => t.pnl > 0).length + '/' + xs.length : '0/0'
  const caps = list.map(t => t.capture_pct).filter(x => x != null).sort((a,b) => a-b)
  const off = list.filter(t => t.momentum && t.momentum.trade_is === 'offsides')
  const weak = list.filter(t => t.momentum && t.momentum.trade_is === 'against_weak').length
  const withM = list.filter(t => t.momentum && t.momentum.trade_is === 'with').length
  const of_ = xs => xs.length + ' of ' + n + ' (won ' + wr(xs) + ')'
  return {
    'trades': n + ' \u2014 ' + wins + '/' + n + ' won, ' + money(pnl),
    'median capture': caps.length ? caps[Math.floor(caps.length/2)] + '%  \u00b7  ' + list.filter(shapes.zero).length + ' took 0% of a \u22651 ATR move' : '\u2014',
    'mid-node entries': of_(list.filter(shapes.midnode)),
    'repeat attempts (2nd+)': of_(list.filter(shapes.repeat)),
    'stop inside entry node': list.filter(shapes.stopnode).length + ' of ' + n,
    'TP parked at/near a reference': list.filter(shapes.tpparked).length + ' of ' + n,
    'momentum': withM + ' with \u00b7 ' + off.length + ' offsides (won ' + wr(off) + ') \u00b7 ' + weak + ' against a read too weak to call',
  }
}
function card(t) {
  const v = t.coach ? t.coach.verdict : null
  const vc = v === 'good' ? 'good' : v === 'not_good' ? 'bad' : v === 'mixed' ? 'mixed' : ''
  const mo = t.momentum && t.momentum.trade_is
  return '<div class="card" data-id="' + t.id + '">' +
    '<img loading="lazy" alt="" src="' + t.url + '">' +
    '<div class="m"><div class="t"><b>' + esc(t.date) + ' ' + esc(t.time) + '</b>' +
    '<span class="mute">' + esc(t.direction) + '</span>' +
    '<span class="' + (t.pnl > 0 ? 'win' : 'loss') + '" style="margin-left:auto">' + money(t.pnl) +
      (t.r_multiple != null ? ' \u00b7 ' + n1(t.r_multiple) + 'R' : '') + '</span></div>' +
    '<div class="chips">' +
      (v ? '<span class="chip ' + vc + '">' + esc(v.replace('_',' ')) + (t.coach.vintage === 'v4' ? ' (v4)' : '') + '</span>'
         : '<span class="chip">no read</span>') +
      (mo === 'offsides' ? '<span class="chip off">offsides</span>' : mo === 'against_weak' ? '<span class="chip weak">against (weak)</span>' : '') +
      (t.capture_pct != null ? '<span class="chip">' + t.capture_pct + '% captured</span>' : '') +
      (t.attempts >= 2 ? '<span class="chip">attempt ' + (t.attempts + 1) + '</span>' : '') +
      (t.commentary || (t.coach && t.coach.on_your_read) ? '<span class="chip">answered</span>' : '') +
    '</div></div></div>'
}
function render() {
  const list = current()
  $('#count').textContent = list.length + ' of ' + T.length + ' trades'
  $('#stats').innerHTML = Object.entries(statsOf(list)).map(([k,v]) => '<div><b>' + esc(k) + '</b>' + esc(v) + '</div>').join('')
  $('#grid').innerHTML = list.length ? list.map(card).join('') : '<div class="empty">Nothing matches those filters.</div>'
  $('#aggwrap').innerHTML = ''
  if ($('#chat').style.display === 'flex') $('#chat-scope').textContent = list.length + ' on screen'
}
for (const el of document.querySelectorAll('.bar select')) el.addEventListener('change', render)
$('#reset').onclick = () => { for (const el of document.querySelectorAll('.bar select')) el.value = ''; render() }

// ── one trade ────────────────────────────────────────────────────────────
function row(k, v) { return '<tr><td>' + k + '</td><td>' + v + '</td></tr>' }
function side(t) {
  const c = t.coach
  const tape = [
    row('entry / exit', n1(t.entry_price) + ' \u2192 ' + n1(t.exit_price)),
    row('stop / TP1', n1(t.stop_price) + ' / ' + n1(t.tp1_price)),
    row('capture / R', (t.capture_pct == null ? '\u2014' : t.capture_pct) + '% / ' + n1(t.r_multiple) + 'R'),
    row('MFE / MAE', n1(t.mfe_atr) + ' / ' + n1(t.mae_atr) + ' ATR'),
    row('post-exit 15m', '+' + n1(t.post_exit_favorable_atr) + ' / \u2212' + n1(t.post_exit_against_atr) + ' ATR'),
    row('nearest level', t.nearest ? esc(t.nearest.name) + ' ' + t.nearest.price + ' \u00b7 ' + t.nearest.dist_pts + ' pts ' + esc(t.nearest.side) : '\u2014'),
    row('run before entry', n1(t.chase_atr) + ' ATR'),
    row('TP vs reference', t.tp_vs_reference ? esc(t.tp_vs_reference.band) + ' ' + esc(t.tp_vs_reference.level) + (t.tp_missed_by_pts != null ? ' \u00b7 missed by ' + t.tp_missed_by_pts + ' pts' : '') : '\u2014'),
    row('stop terrain', t.stop_terrain ? (t.stop_terrain.inside_entry_node ? '<b>inside entry node</b>' : 'beyond node edge') : '\u2014'),
  ].join('')
  const context = [
    row('momentum', t.momentum
      ? (t.momentum.trade_is === 'offsides' ? '<b>OFFSIDES</b>' : t.momentum.trade_is === 'against_weak' ? 'against (weak)' : esc(t.momentum.trade_is)) + ' \u00b7 ' + esc(t.momentum.label)
      : '\u2014'),
    row('session profile', t.profile ? esc(t.profile.zone) + ' \u00b7 ' + esc(t.profile.node) : '\u2014'),
    row('5m swings', t.swings ? esc(t.swings.label) + ' \u00b7 trade is ' + esc(t.swings.trade_is || '\u2014') : '\u2014'),
    row('week value', t.htf ? 'prior: ' + esc(t.htf.prior_week_value || '\u2014') + ' \u00b7 developing: ' + esc(t.htf.developing_week_value || '\u2014') : '\u2014'),
    row('runway', t.runway.length ? t.runway.map(r => esc(r.level) + ' ' + r.dist_pts + ' pts').join(' \u00b7 ') : '\u2014'),
    row('ATR vs typical \u00b7 IB', n1(t.atr_vs_typical) + '\u00d7 \u00b7 ' + esc(t.ib || '\u2014')),
    row('attempts before', t.attempts),
  ].join('')
  const noRead = 'No read cached for this trade. A verdict costs two image calls, so it is never generated from this page \u2014 run read.ts for it.'
  return '<div class="panel"><h4>' + esc(t.date + ' ' + t.time) + ' \u00b7 ' + esc(t.direction) + ' ' + esc(t.symbol) +
      ' \u00b7 ' + money(t.pnl) + (t.anchored ? ' \u00b7 anchored' : '') + '</h4><table>' + tape + '</table></div>' +
    '<div class="panel"><h4>Context</h4><table>' + context + '</table></div>' +
    '<div class="panel"><h4>Coach \u2014 the verdict</h4>' + (c
      ? '<div class="verdict"><b>' + esc(c.verdict.replace('_',' ')) + '</b>' +
        (c.vintage === 'v4' ? ' <span class="mute">(v4, before the XY lens)</span>' : '') + String.fromCharCode(10,10) + esc(c.read) + '</div>'
      : '<div class="mute">' + noRead + '</div>') + '</div>' +
    '<div class="panel"><h4>What you said</h4>' +
      (t.tags.length ? '<div class="chips">' + t.tags.map(g => '<span class="chip">' + esc(g) + '</span>').join('') + '</div>' : '<div class="mute">no tags</div>') +
      (t.note ? '<div class="note" style="margin-top:9px">' + esc(t.note) + '</div>' : '') +
      (c && c.on_your_read ? '<div class="reply">' + esc(c.on_your_read) + '</div>' : '') +
      '<div id="replywrap">' + (t.commentary ? '<div class="reply">' + esc(t.commentary) + '</div>' : '') + '</div>' +
      ((t.tags.length || t.note)
        ? '<div style="margin-top:11px"><button id="gen" data-id="' + t.id + '">' + (t.commentary ? 'Answer again' : 'Coach, answer that') + '</button></div>'
        : '') +
    '</div>'
}
// ── the viewer ───────────────────────────────────────────────────────────
//  These are two-pane Sierra captures: the whole frame is the orientation and
//  the detail only shows up past native size, so the wheel zooms, a drag pans,
//  and the zoom level SURVIVES flipping to the next trade — his screenshots
//  share a layout, so holding the zoom is what makes two of them comparable.
const view = $('#d-view'), img = $('#d-img')
let vlist = [], vidx = 0, z = 1, panX = 0, panY = 0, baseW = 0, baseH = 0
const MAXZ = 12
function apply() {
  const w = baseW * z, h = baseH * z
  const vw = view.clientWidth, vh = view.clientHeight
  panX = w <= vw ? (vw - w) / 2 : Math.min(0, Math.max(vw - w, panX))
  panY = h <= vh ? (vh - h) / 2 : Math.min(0, Math.max(vh - h, panY))
  img.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + z + ')'
  view.classList.toggle('zoomed', z > 1)
  $('#zoomlvl').textContent = Math.round(z * 100) + '%'
}
function fitTo(natW, natH) {
  const vw = view.clientWidth, vh = view.clientHeight
  const f = Math.min(vw / natW, vh / natH)
  baseW = natW * f; baseH = natH * f
  img.style.width = baseW + 'px'; img.style.height = baseH + 'px'
}
function zoomAt(cx, cy, factor) {
  const nz = Math.min(MAXZ, Math.max(1, z * factor))
  const k = nz / z
  panX = cx - k * (cx - panX); panY = cy - k * (cy - panY)
  z = nz; apply()
}
function openAt(i) {
  if (!vlist.length) return
  vidx = (i + vlist.length) % vlist.length
  const t = vlist[vidx]
  img.style.visibility = 'hidden'
  $('#loaderr').style.display = 'none'
  img.onload = () => { fitTo(img.naturalWidth, img.naturalHeight); apply(); img.style.visibility = 'visible' }
  // Signed URLs expire about a week after the harness pull, and a dead image
  // is otherwise an empty black box with no explanation.
  img.onerror = () => { baseW = baseH = 0; $('#loaderr').style.display = 'block' }
  img.src = t.url
  $('#d-side').innerHTML = side(t)
  $('#d-side').scrollTop = 0
  $('#pos').textContent = (vidx + 1) + ' / ' + vlist.length
  $('#detail').style.display = 'block'
}
$('#grid').addEventListener('click', e => {
  const el = e.target.closest('.card'); if (!el) return
  vlist = current()
  openAt(vlist.findIndex(x => x.id === el.dataset.id))
})
$('#close').onclick = () => { $('#detail').style.display = 'none' }
$('#prev').onclick = () => openAt(vidx - 1)
$('#next').onclick = () => openAt(vidx + 1)
$('#zoomin').onclick = () => zoomAt(view.clientWidth / 2, view.clientHeight / 2, 1.4)
$('#zoomout').onclick = () => zoomAt(view.clientWidth / 2, view.clientHeight / 2, 1 / 1.4)
$('#zoomfit').onclick = () => { z = 1; apply() }
view.addEventListener('wheel', e => {
  e.preventDefault()
  const r = view.getBoundingClientRect()
  zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.18 : 1 / 1.18)
}, { passive: false })
// A press that does not travel is a click (next trade); one that travels pans.
let down = null
view.addEventListener('pointerdown', e => {
  if (e.button !== 0) return
  down = { x: e.clientX, y: e.clientY, px: panX, py: panY, moved: 0 }
  try { view.setPointerCapture(e.pointerId) } catch { /* no capture, drag still works */ }
})
view.addEventListener('pointermove', e => {
  if (!down) return
  const dx = e.clientX - down.x, dy = e.clientY - down.y
  down.moved = Math.max(down.moved, Math.abs(dx) + Math.abs(dy))
  if (down.moved > 4 && z > 1) {
    view.classList.add('dragging')
    panX = down.px + dx; panY = down.py + dy; apply()
  }
})
view.addEventListener('pointerup', e => {
  if (!down) return
  const wasClick = down.moved <= 4
  down = null; view.classList.remove('dragging')
  if (wasClick) openAt(vidx + 1)
})
document.addEventListener('keydown', e => {
  const el = e.target
  if (el && el.closest && el.closest('input, textarea')) return
  if (e.key === 'Escape') { $('#detail').style.display = 'none'; return }
  if ($('#detail').style.display !== 'block') return
  if (e.key === 'ArrowRight') { e.preventDefault(); openAt(vidx + 1) }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); openAt(vidx - 1) }
  else if (e.key === '+' || e.key === '=') zoomAt(view.clientWidth / 2, view.clientHeight / 2, 1.4)
  else if (e.key === '-') zoomAt(view.clientWidth / 2, view.clientHeight / 2, 1 / 1.4)
  else if (e.key === '0') { z = 1; apply() }
})
window.addEventListener('resize', () => {
  if ($('#detail').style.display !== 'block' || !img.naturalWidth) return
  fitTo(img.naturalWidth, img.naturalHeight); apply()
})
$('#d-side').addEventListener('click', async e => {
  if (e.target.id !== 'gen') return
  const btn = e.target, id = btn.dataset.id, t = T.find(x => x.id === id)
  btn.disabled = true
  $('#replywrap').innerHTML = '<div class="spin">the coach is reading what you wrote\u2026</div>'
  try {
    const res = await fetch('/api/commentary', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ id: id, regenerate: !!t.commentary }) })
    const r = await res.json()
    if (r.error) throw new Error(r.error)
    t.commentary = r.text
    $('#replywrap').innerHTML = '<div class="reply">' + esc(r.text) + '</div>'
    btn.textContent = 'Answer again'
    render()
  } catch (err) {
    $('#replywrap').innerHTML = '<div class="reply">' + esc(String(err.message || err)) + '</div>'
  }
  btn.disabled = false
})

// ── the set, and the conversation about it ───────────────────────────────
$('#read').onclick = async () => {
  const ids = current().map(t => t.id)
  if (!ids.length) return
  const head = '<div class="agg"><h3>Coach \u2014 across these ' + ids.length + '</h3>'
  $('#aggwrap').innerHTML = head + '<span class="spin">reading\u2026</span></div>'
  try {
    const res = await fetch('/api/aggregate', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ ids: ids }) })
    const r = await res.json()
    $('#aggwrap').innerHTML = head + esc(r.text || r.error) + '</div>'
  } catch (err) {
    $('#aggwrap').innerHTML = head + esc(String(err.message || err)) + '</div>'
  }
}
const hist = []
$('#openchat').onclick = () => {
  $('#chat').style.display = 'flex'
  $('#chat-scope').textContent = current().length + ' on screen'
  $('#q').focus()
}
$('#closechat').onclick = () => { $('#chat').style.display = 'none' }
$('#chatform').onsubmit = async e => {
  e.preventDefault()
  const q = $('#q').value.trim(); if (!q) return
  $('#q').value = ''
  hist.push({ role: 'user', content: q })
  $('#log').insertAdjacentHTML('beforeend', '<p class="u">' + esc(q) + '</p><p class="a spin">\u2026</p>')
  $('#log').scrollTop = $('#log').scrollHeight
  const ids = current().map(t => t.id)
  let text
  try {
    const res = await fetch('/api/chat', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ ids: ids, messages: hist }) })
    const r = await res.json()
    text = r.text || r.error
  } catch (err) { text = String(err.message || err) }
  hist.push({ role: 'assistant', content: text })
  const last = $('#log').lastElementChild
  last.className = 'a'; last.textContent = text
  $('#log').scrollTop = $('#log').scrollHeight
}
render()
</script>
</body></html>`
}
