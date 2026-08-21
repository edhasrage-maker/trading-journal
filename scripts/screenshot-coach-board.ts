/** Pattern board — many screenshots side by side, the aggregate patterns
 *  across them, and a conversation with the coach about the set.
 *
 *   npx tsx scripts/screenshot-coach-board.ts --bucket=offsides
 *   npx tsx scripts/screenshot-coach-board.ts --bucket=week=2026-08-10 --chat
 *
 *  Buckets: offsides | week=YYYY-MM-DD (any date in the week) | zero-capture
 *  | mid-node | repeat | tag=<substring> | all.   --limit=N caps (newest
 *  first). --no-agg skips the aggregate coach read. --chat opens a terminal
 *  Q&A loop with the coach over the set (type your question, enter; Ctrl+C
 *  or "exit" to leave; the exchange is appended to board-chat-<bucket>.md).
 *
 *  COST SHAPE: image calls are NEVER spent here. The coach talks from the
 *  bar-derived truth, the cached per-trade reads, and deterministic stats —
 *  text-only calls. Screenshots are for the trader's eyes (signed URLs,
 *  which expire ~7 days after the harness pull; re-run the harness to
 *  refresh them).
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { createInterface } from 'readline'
import Anthropic from '@anthropic-ai/sdk'
import { XY_LENS } from './screenshot-coach-lens'

const argv = process.argv.slice(2)
const has = (n: string) => argv.includes(`--${n}`)
const argVal = (n: string): string | null => argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? null

const IN_PATH = argVal('in') ?? join(process.cwd(), 'evals', 'screenshot-coach', 'unlabelled-trades.jsonl')
const BUCKET = argVal('bucket') ?? 'all'
const LIMIT = argVal('limit') ? Number(argVal('limit')) : null
const MODEL = argVal('model') ?? 'claude-sonnet-5'
const NO_AGG = has('no-agg')
const CHAT = has('chat')

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
const anthropic = new Anthropic()

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>

const rows: Row[] = readFileSync(IN_PATH, 'utf8').split(/\r?\n/).filter(Boolean)
  .map(l => JSON.parse(l)).filter(r => r.frame?.signed_url)

// Cached per-trade coach reads — current file plus the pre-XY backup, so v4-era
// verdicts still show on their cards (marked with their vintage).
const readsBy = new Map<string, { verdict: string; read: string; vintage: string }>()
for (const [file, vintage] of [['reads-v4-preXY.jsonl.bak', 'v4'], ['reads.jsonl', 'current']] as const) {
  const p = join(dirname(IN_PATH), file)
  if (!existsSync(p)) continue
  for (const l of readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const o = JSON.parse(l)
    if (o.write?.verdict) readsBy.set(o.trade_id, { verdict: o.write.verdict, read: o.write.read, vintage })
  }
}

// ── bucket ────────────────────────────────────────────────────────────────
function weekOf(date: string): [string, string] {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  const mon = new Date(dt); mon.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7))
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6)
  const iso = (x: Date) => x.toISOString().slice(0, 10)
  return [iso(mon), iso(sun)]
}
const ctx = (r: Row) => r.truth?.context ?? {}
const pnlOf = (r: Row): number => r.truth?.exit?.pnl ?? 0
const ex = (r: Row) => r.truth?.exit ?? {}
const filters: Record<string, (r: Row) => boolean> = {
  'all': () => true,
  'offsides': r => ctx(r).session_momentum?.trade_is === 'offsides',
  'zero-capture': r => ex(r).capture_pct === 0 && (ex(r).mfe_atr ?? 0) >= 1,
  'mid-node': r => {
    const p = ctx(r).session_profile_at_entry
    return p?.node === 'HVN' && String(p?.zone ?? '').startsWith('inside value')
  },
  'repeat': r => (ctx(r).attempts_before?.count ?? 0) >= 2,
}
let filter: (r: Row) => boolean
let bucketLabel = BUCKET
if (filters[BUCKET]) filter = filters[BUCKET]
else if (BUCKET.startsWith('week=')) {
  const [a, b] = weekOf(BUCKET.slice(5))
  bucketLabel = `week of ${a}`
  filter = r => r.date >= a && r.date <= b
} else if (BUCKET.startsWith('tag=')) {
  const t = BUCKET.slice(4).toLowerCase()
  filter = r => (r.claim?.tags ?? []).some((x: string) => x.toLowerCase().includes(t))
} else {
  console.error(`unknown bucket "${BUCKET}" — use ${Object.keys(filters).join(' | ')} | week=YYYY-MM-DD | tag=<substr>`)
  process.exit(1)
}

let set = rows.filter(filter)
set.sort((a, b) => String(b.entry_pt).localeCompare(String(a.entry_pt)))
if (LIMIT) set = set.slice(0, LIMIT)
if (!set.length) { console.error(`bucket "${bucketLabel}" matched 0 trades`); process.exit(1) }

// ── deterministic aggregate stats ─────────────────────────────────────────
const round1 = (x: number) => Math.round(x * 10) / 10
function stats(list: Row[]): Record<string, string> {
  const n = list.length
  const wins = list.filter(r => pnlOf(r) > 0).length
  const pnl = list.reduce((s, r) => s + pnlOf(r), 0)
  const off = list.filter(r => ctx(r).session_momentum?.trade_is === 'offsides').length
  const withM = list.filter(r => ctx(r).session_momentum?.trade_is === 'with').length
  const rep = list.filter(r => (ctx(r).attempts_before?.count ?? 0) >= 2)
  const hvnMid = list.filter(r => filters['mid-node'](r))
  const caps = list.map(r => ex(r).capture_pct).filter((x: any) => x != null).sort((a: number, b: number) => a - b)
  const zeroCap = list.filter(r => ex(r).capture_pct === 0 && (ex(r).mfe_atr ?? 0) >= 1).length
  const tpParked = list.filter(r => ['parked_at', 'near'].includes(ex(r).tp1_vs_reference?.band)).length
  const tpMissedTight = list.filter(r => ex(r).tp1_missed_by_pts != null && ex(r).tp1_missed_by_pts <= 1).length
  const stopInNode = list.filter(r => ex(r).stop_terrain?.inside_entry_node === true).length
  const wr = (xs: Row[]) => xs.length ? `${xs.filter(r => pnlOf(r) > 0).length}/${xs.length}` : '0/0'
  return {
    'trades': `${n} — ${wins}/${n} won, ${pnl >= 0 ? '+' : ''}$${Math.round(pnl)}`,
    'momentum': `${withM} with · ${off} offsides (offsides won ${wr(list.filter(r => ctx(r).session_momentum?.trade_is === 'offsides'))})`,
    'repeat attempts (2nd+)': `${rep.length} of ${n} (won ${wr(rep)})`,
    'mid-node entries': `${hvnMid.length} of ${n} (won ${wr(hvnMid)})`,
    'median capture': caps.length ? `${caps[Math.floor(caps.length / 2)]}%  ·  ${zeroCap} took 0% of a ≥1 ATR move` : '—',
    'TP parked at/near a reference': `${tpParked} of ${n}  ·  missed by ≤1 pt: ${tpMissedTight}`,
    'stop inside entry node': `${stopInNode} of ${n}`,
  }
}
const bucketStats = stats(set)
const baseline = stats(rows)

// ── per-trade digest the coach talks from ─────────────────────────────────
function digest(r: Row): Record<string, unknown> {
  const m = ctx(r).session_momentum
  const cached = readsBy.get(r.trade_id)
  return {
    key: r.entry_pt, direction: r.direction, symbol: r.symbol, pnl: r.truth?.exit?.pnl ?? null,
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
    trader_tags: r.claim?.tags ?? [],
  }
}
const digests = set.map(digest)

const DATA = [
  `BUCKET: ${bucketLabel} (${set.length} trades)`,
  `BUCKET STATS (deterministic):`, JSON.stringify(bucketStats, null, 1),
  `BASELINE — ALL ${rows.length} TRADES:`, JSON.stringify(baseline, null, 1),
  `TRADES (bar-derived truth; the only source of numbers):`, JSON.stringify(digests, null, 1),
].join('\n')

const AGG_SYSTEM = `You are this trader's screenshot coach, looking across a SET of their trades to find the patterns one trade can't show. You have NOT seen these charts here — you have each trade's bar-derived truth, context, and (for some) your own earlier per-trade verdict. Every number you state must come from the DATA block; counts must be countable from it. Talk about the trades by their key (date and time). No invented orderflow — no absorption, delta or trap stories.

${XY_LENS}

If an input is not a question about these trades (a shell command, a stray paste), say so in ONE sentence and suggest a question they could ask — do not speculate about tools or ask them to paste anything.

For an aggregate read: lead with the ONE pattern that most costs (or makes) this trader money in this set, with its count and dollars/R. Then two or three more, each with counts, in weight order. Compare against the baseline only where the difference is the point. Plain, direct, second person, his register — one sharp line at most. End with the single thing you'd have them do differently next week — concrete, checkable, from the data.`

async function say(messages: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<string> {
  const msg = await anthropic.messages.create({
    model: MODEL, max_tokens: 1500, system: AGG_SYSTEM + '\n\n' + DATA,
    output_config: { effort: 'medium' },
    messages,
  })
  const t = msg.content.find(b => b.type === 'text')
  return t && t.type === 'text' ? t.text : `(no text: ${msg.stop_reason})`
}

// ── board html ────────────────────────────────────────────────────────────
const esc = (x: unknown) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function card(r: Row): string {
  const m = ctx(r).session_momentum
  const cached = readsBy.get(r.trade_id)
  const chip = cached ? `<span class="chip v-${esc(cached.verdict)}">${esc(cached.verdict.replace('_', ' '))}${cached.vintage === 'v4' ? ' ·v4' : ''}</span>` : `<span class="chip v-none">unread</span>`
  const momo = m?.trade_is === 'offsides' ? `<b class="off">OFFSIDES</b>` : m?.trade_is === 'with' ? 'with' : '—'
  const tpBits = [
    ex(r).tp1_vs_reference ? `${ex(r).tp1_vs_reference.dist_pts}pts ${esc(ex(r).tp1_vs_reference.side)} ${esc(ex(r).tp1_vs_reference.level)}` : null,
    ex(r).tp1_missed_by_pts != null ? `missed by ${ex(r).tp1_missed_by_pts}` : null,
  ].filter(Boolean).join(' · ')
  return `<div class="card">
    <header><span>${esc(r.entry_pt)} · ${esc(r.direction)} ${esc(r.symbol)}</span>
    <span class="pnl ${pnlOf(r) >= 0 ? 'pos' : 'neg'}">${pnlOf(r) >= 0 ? '+' : ''}$${Math.round(pnlOf(r))}</span>${chip}</header>
    <a href="${esc(r.frame.signed_url)}" target="_blank"><img loading="lazy" src="${esc(r.frame.signed_url)}"></a>
    <table>
      <tr><td>momentum</td><td>${momo}</td></tr>
      <tr><td>where</td><td>${ctx(r).session_profile_at_entry ? `${esc(ctx(r).session_profile_at_entry.zone)} · ${esc(ctx(r).session_profile_at_entry.node)}` : '—'} · att ${ctx(r).attempts_before?.count ?? 0}</td></tr>
      <tr><td>R / capture</td><td>${ex(r).r_multiple ?? '—'}R · ${ex(r).capture_pct ?? '—'}% · post-exit +${ex(r).post_exit_favorable_atr ?? '—'} ATR</td></tr>
      <tr><td>TP</td><td>${tpBits || '—'}</td></tr>
    </table>
  </div>`
}

async function main() {
  let agg: string | null = null
  if (!NO_AGG) {
    console.log(`aggregate coach read over ${set.length} trades (text-only call)…`)
    agg = await say([{ role: 'user', content: 'Give the aggregate read for this set.' }])
    console.log('\n' + agg + '\n')
  }
  const html = `<!doctype html><meta charset="utf-8"><title>coach board — ${esc(bucketLabel)}</title>
<style>
body{background:#111;color:#ddd;font:13px/1.45 system-ui;margin:16px}
h1{font-size:17px} .sub{color:#888;max-width:900px}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:6px;margin:14px 0;max-width:1400px}
.stats div{background:#1a1a1a;padding:8px 10px;border-radius:6px}.stats b{color:#9ac}
.agg{background:#16202a;border-left:3px solid #4a8;border-radius:6px;padding:12px 14px;max-width:980px;white-space:pre-wrap;margin:14px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:14px}
.card{background:#191919;border-radius:8px;overflow:hidden}
.card header{display:flex;gap:8px;align-items:center;padding:6px 10px;font-weight:600}
.card img{width:100%;display:block;background:#000}
.card table{width:100%;border-collapse:collapse;font-size:12px}
.card td{padding:2px 10px;color:#aaa}.card td:first-child{color:#666;width:80px}
.pnl.pos{color:#7c6}.pnl.neg{color:#d66}.off{color:#e83}
.chip{margin-left:auto;font-size:11px;padding:1px 8px;border-radius:9px}
.v-good{background:#1e3a24;color:#8c8}.v-not_good{background:#3a1e1e;color:#d88}.v-mixed{background:#33301e;color:#cc8}.v-none{background:#222;color:#666}
</style>
<h1>coach board — ${esc(bucketLabel)}</h1>
<p class="sub">${set.length} trades, newest first. Verdict chips are cached per-trade reads (·v4 = pre-XY voice). Images are signed URLs — they expire ~7 days after the harness pull. The aggregate read and any chat run on bar truth only: no image calls are ever spent here.</p>
<div class="stats">${Object.entries(bucketStats).map(([k, v]) => `<div><b>${esc(k)}</b><br>${esc(v)}</div>`).join('')}</div>
${agg ? `<div class="agg"><b>Coach — across the set:</b>\n\n${esc(agg)}</div>` : ''}
<div class="grid">${set.map(card).join('\n')}</div>`
  const outPath = join(dirname(IN_PATH), `board-${bucketLabel.replace(/[^a-z0-9-]+/gi, '-')}.html`)
  writeFileSync(outPath, html, 'utf8')
  console.log(`wrote ${outPath}  (${set.length} trades)`)

  if (CHAT) {
    const chatLog = join(dirname(IN_PATH), `board-chat-${bucketLabel.replace(/[^a-z0-9-]+/gi, '-')}.md`)
    const hist: Array<{ role: 'user' | 'assistant'; content: string }> = []
    if (agg) hist.push({ role: 'user', content: 'Give the aggregate read for this set.' }, { role: 'assistant', content: agg })
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    let closed = false
    rl.on('close', () => { closed = true })
    console.log(`
chat with the coach about these ${set.length} trades — plain-English trading questions, "exit" to leave. e.g.:
  what did my best trades in this set have in common?
  is my stop placement the problem here, or the entries?
  which of these should I simply never have taken?
`)
    const ask = () => { if (closed) return; rl.question('you> ', async q => {
      q = q.trim()
      if (!q || q === 'exit' || q === 'quit') { rl.close(); return }
      hist.push({ role: 'user', content: q })
      const a = await say(hist)
      hist.push({ role: 'assistant', content: a })
      console.log('\ncoach> ' + a + '\n')
      appendFileSync(chatLog, `\n**you:** ${q}\n\n**coach:** ${a}\n`, 'utf8')
      ask()
    }) }
    ask()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
