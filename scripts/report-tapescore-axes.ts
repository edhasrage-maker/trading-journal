/**
 * READ-ONLY report: one trader's TapeScore axes, OLD (amendment 8 — what is
 * live before this change) vs NEW (amendment 9), with the order-flow Score
 * setting ON (the default) and OFF. NEW runs through the SAME code the app runs —
 *
 *   dashboard path   every day → computeDayStats → scoreDayRollups → aggregateTapeScore
 *   recap path       loadPeriodDays (Review · Month) → summarizePeriod
 *
 * — and the recap path is printed beside it so any disagreement shows up here
 * first. OLD is rebuilt from the same rollups with the amendment-8 arithmetic
 * (Risk = rails kept from the stored audit; Entry = exec params 41 / plan 24 /
 * profit factor 11; Exit = five factors 25/25/20/15/15 pooled over trades, loss
 * size against the plain average risk at 1.1× / 2×; the stored verdict for the
 * cap) so the two are compared on identical data. Each October day also shows
 * P3 as stored, as the previous build read it (quantity rule) and now (usual
 * risk spread), with the yardstick and the trades it judged.
 *
 * Never writes: the client is wrapped so every write throws or no-ops (the
 * recap loader's best-effort cache write-back is swallowed), and every read is
 * scoped to one user even under the service key.
 *
 *   npx tsx scripts/report-tapescore-axes.ts                 (hosted DB, founder)
 *   npx tsx scripts/report-tapescore-axes.ts --user=<uuid> --from=2026-06 --to=2026-10 --daily=2026-10 --extra=2026-09-29
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { computeDayStats, scoreDayRollups, ROLLUP_TRADE_COLS, type DayForStats, type ScoredDayRollup, type TradeForStats } from '../src/lib/day-stats'
import { loadTapeScoreSettings } from '../src/lib/day-stats-server'
import { loadPeriodDays, summarizePeriod, monthRange, nextMonth } from '../src/lib/period-recap'
import { aggregateTapeScore, railPassCount, type TapeScoreResult } from '../src/lib/tapescore'
import { axisPartLines, mergeTradeSums, sumScore, type TradeSums } from '../src/lib/tapescore-axes'
import { tradeSumsInSequence, type DayTradeInputs } from '../src/lib/exit-rollup'
import type { RiskYardstick } from '../src/lib/exit-score'
import type { EodAiAnalysis } from '../src/lib/supabase/types'

const arg = (name: string, dflt: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt
const UID = arg('user', 'fa3fb352-9538-44cc-8ce1-1c76f307044c')
const FROM = arg('from', '2026-06')
const TO = arg('to', '2026-10')
const DAILY = arg('daily', '2026-10')
const EXTRA = arg('extra', '2026-09-29').split(',').filter(Boolean)

for (const l of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/)
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const URL = process.env.PUBLIC_SUPABASE_URL, KEY = process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) { console.error('Missing PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_SERVICE_ROLE_KEY in .env.public-feed'); process.exit(1) }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const raw: any = createClient(URL, KEY)

/** The service key sees every tenant and can write. This wrapper scopes every
 *  select to one user (what RLS does for the app) and refuses every write. */
let blockedWrites = 0
const ro = {
  from(table: string) {
    const b = raw.from(table)
    return {
      select: (cols: string, opts?: unknown) => b.select(cols, opts).eq('user_id', UID),
      update: () => ({ eq: () => { blockedWrites++; return Promise.resolve({ data: null, error: { message: 'read-only report' } }) } }),
      insert: () => { throw new Error('read-only report: insert refused') },
      upsert: () => { throw new Error('read-only report: upsert refused') },
      delete: () => { throw new Error('read-only report: delete refused') },
    }
  },
}

const PAGE = 1000
async function all<T>(table: string, cols: string, order: string): Promise<T[]> {
  const out: T[] = []
  for (let p = 0; p < 100; p++) {
    const { data, error } = await ro.from(table).select(cols).order(order, { ascending: true }).range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...(data as T[]))
    if ((data as T[]).length < PAGE) break
  }
  return out
}

// ── OLD (amendment 8) arithmetic, rebuilt for comparison ──────────────────────
interface Axes { score: number | null; risk: number | null; entry: number | null; exit: number | null }
const OLD_EXIT_W = { kept: 0.25, lossSize: 0.25, stopRespected: 0.20, stopSize: 0.15, runner: 0.15 } as const
/** Amendment-8 loss size: the loss against the plain AVERAGE risk (the
 *  yardstick's mean), full marks to 1.1x, none at 2x; own planned risk with no
 *  average. */
function oldLossSums(parts: DayTradeInputs | null | undefined, y: RiskYardstick | null) {
  let n = 0, sum = 0
  for (const [loss, own] of parts?.losses ?? []) {
    const yard = y && y.mean > 0 ? y.mean : own
    if (yard == null || !(yard > 0)) continue
    const ratio = Math.abs(loss) / yard
    n += 1; sum += ratio <= 1.1 ? 1 : ratio >= 2 ? 0 : (2 - ratio) / 0.9
  }
  return { n, sum }
}
function oldExit(s: TradeSums | null | undefined): number | null {
  if (!s) return null
  let w = 0, v = 0
  for (const k of Object.keys(OLD_EXIT_W) as (keyof typeof OLD_EXIT_W)[]) {
    const x = sumScore(s[k]); if (x != null) { w += OLD_EXIT_W[k]; v += x * OLD_EXIT_W[k] }
  }
  return w > 0 ? v / w : null
}
interface OldDay extends Axes { capped: boolean; v15: boolean }
function oldDay(eod: EodAiAnalysis | null | undefined, sums: TradeSums | null): OldDay | null {
  const p = eod?.process, e = eod?.execution
  const tracked = p?.active_rails?.length ?? null
  const denom = tracked ?? 5
  const pass = p?.per_rule && denom > 0 ? railPassCount(p, p.active_rails) : null
  const risk = pass != null ? (pass / denom) * 100 : null
  let entry: number | null = null
  if (e != null) {
    const pf = e.profit_factor != null ? Math.max(0, Math.min(1, e.profit_factor / 2)) : (e.planned_vs_realized_rr ?? null)
    let num = 0, den = 0
    for (const [v, w] of [[e.execution_parameters, 0.41], [e.prep_adherence, 0.24], [pf, 0.11]] as [number | null, number][]) {
      if (v != null) { num += v * w; den += w }
    }
    const x = den > 0 ? num / den : (e.composite ?? null)
    entry = x != null ? Math.max(0, Math.min(1, x)) * 100 : 0
  }
  if (risk == null && entry == null) {
    return eod?.score != null
      ? { score: Math.round(Math.max(0, Math.min(10, eod.score)) * 10), risk: null, entry: null, exit: null, capped: false, v15: false }
      : null
  }
  const verdict = pass == null ? null : tracked != null ? (p?.verdict ?? null) : pass >= 4 ? 'Compliant' : 'Breach'
  const exit = oldExit(sums)
  let w = 0, v = 0
  for (const a of [risk, entry, exit]) if (a != null) { w += 1; v += a }
  let score = Math.round(v / w)
  let capped = false
  if (verdict === 'Breach' && score > 49) { score = 49; capped = true }
  return { score, risk, entry, exit, capped, v15: true }
}
function oldPeriod(days: { old: OldDay | null; sums: TradeSums | null }[]): Axes {
  const scored = days.filter((d): d is { old: OldDay; sums: TradeSums | null } => d.old != null)
  const mean = (xs: (number | null)[]) => { const f = xs.filter((x): x is number => x != null); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null }
  const r = (x: number | null) => (x == null ? null : Math.round(x))
  return {
    score: r(mean(scored.map(d => d.old.score))),
    risk: r(mean(scored.map(d => (d.old.risk == null ? null : Math.round(d.old.risk))))),
    entry: r(mean(scored.map(d => (d.old.entry == null ? null : Math.round(d.old.entry))))),
    exit: r(oldExit(mergeTradeSums(scored.filter(d => d.old.v15).map(d => d.sums)))),
  }
}

const r0 = (v: number | null | undefined) => (v == null ? '—' : String(Math.round(v)))
const pad = (s: string, n: number) => s.padStart(n)
const quad = (a: Axes | null | undefined, capped = false) =>
  `${pad(r0(a?.risk), 3)} ${pad(r0(a?.entry), 3)} ${pad(r0(a?.exit), 3)} ${pad(`${r0(a?.score)}${capped ? '*' : ' '}`, 4)}`
const dayQuad = (t: TapeScoreResult | null | undefined) =>
  quad(t ? { ...t.components, score: t.score } : null, !!t?.capped)

async function main() {
  type DayRow = DayForStats & { id: string; date: string }
  const days = await all<DayRow>('trading_days', 'id, date, eod_pnl, day_type, day_types, ai_analysis_json, eod_ai_analysis_json', 'date')
  type T = TradeForStats & { trading_day_id: string }
  const trades = await all<T>('trades', `trading_day_id, ${ROLLUP_TRADE_COLS}`, 'id')
  const settings = await loadTapeScoreSettings(ro)
  console.log(`user ${UID}: ${days.length} days, ${trades.length} trades (${trades.filter(t => t.flow_total != null).length} with an order-flow Score)`)
  console.log(`settings: ATR stop ${settings.atrStopTarget}, order-flow Score in Entry: ${settings.includeFlow ? 'ON' : 'OFF'} (default ON)`)

  const byDay = new Map<string, T[]>()
  for (const t of trades) { const a = byDay.get(t.trading_day_id) ?? []; a.push(t); byDay.set(t.trading_day_id, a) }
  const rollups = days.map(d => computeDayStats(d, byDay.get(d.id) ?? [], null, { atrStopTarget: settings.atrStopTarget }))
  const on = scoreDayRollups(rollups, [], { includeFlow: true })
  const off = scoreDayRollups(rollups, [], { includeFlow: false })
  const eodById = new Map(days.map(d => [d.id, d.eod_ai_analysis_json]))
  // The yardstick each day was read with (the same sequence the app runs), and
  // the trade sums with loss size scored the amendment-8 way, for OLD.
  const reads = tradeSumsInSequence(rollups)
  const yardById = new Map(rollups.map((r, i) => [r.id, reads[i].yardstick]))
  const oldSumsById = new Map(rollups.map((r, i) => {
    const s = reads[i].sums
    return [r.id, s ? { ...s, lossSize: oldLossSums(r.trade_parts, reads[i].yardstick) } : null]
  }))
  const oldOf = (r: ScoredDayRollup) => oldDay(eodById.get(r.id), oldSumsById.get(r.id) ?? null)
  // P3 under the previous build (quantity rule, always), for "what changed".
  const p3Prev = (r: ScoredDayRollup) => ((r.trade_parts?.size_up?.qty_hits ?? 0) > 0 ? 'fail' : 'pass')

  const head = (l: string) => `${l} R   E   X  TS  `
  console.log('\nMONTHLY   (Risk Entry Exit TapeScore)')
  console.log(`${'month'.padEnd(8)} | ${head('OLD    ')} | ${head('NEW·ON ')} | ${head('NEW·OFF')} | recap page vs NEW (trader's setting) | scored days`)
  for (let m = FROM; m <= TO; m = nextMonth(m)) {
    const { start, end } = monthRange(m)
    const inOn = on.filter(d => d.date >= start && d.date <= end)
    const inOff = off.filter(d => d.date >= start && d.date <= end)
    const pOn = aggregateTapeScore(inOn), pOff = aggregateTapeScore(inOff)
    const pOld = oldPeriod(inOn.map(d => ({ old: oldOf(d), sums: oldSumsById.get(d.id) ?? null })))
    const recap = summarizePeriod(await loadPeriodDays(ro, start, end)).score
    const mine = settings.includeFlow ? pOn : pOff
    const same = recap.score === mine.score && recap.risk === mine.risk && recap.entry === mine.entry && recap.exit === mine.exit
    console.log(`${m.padEnd(8)} |        ${quad(pOld)} |        ${quad(pOn)} |        ${quad(pOff)} | ${same ? 'agrees' : `DIFFERS: ${quad(recap)}`} | ${pOn.scoredDays}`)
  }

  // ── Daily ──
  const { start, end } = monthRange(DAILY)
  const dailyDates = new Set([...EXTRA, ...on.filter(x => x.date >= start && x.date <= end && x.trade_count > 0).map(x => x.date)])
  console.log(`\nDAILY ${DAILY} (+ ${EXTRA.join(', ')})   (* = capped at 49; OF = trades with an order-flow Score)`)
  console.log(`${'date'.padEnd(11)} ${pad('n', 2)} ${pad('OF', 2)} | ${head('OLD    ')} | ${head('NEW·ON ')} | ${head('NEW·OFF')} | what moved`)
  for (const d of on.filter(x => dailyDates.has(x.date))) {
    const o = oldOf(d)
    const f = off.find(x => x.id === d.id)
    const ts = d.tapescore
    const notes: string[] = []
    if (ts?.parts) {
      notes.push(`rules ${ts.parts.rulesKept}/${ts.parts.rulesOf}`)
      const re = ts.parts.risk.reentry
      if (re.n != null && re.n > 0) notes.push(`re-entries ${r0(re.score)} on ${re.n}`)
      const stored = eodById.get(d.id)?.process
      if (stored?.verdict && stored.verdict !== ts.components.verdict) notes.push(`verdict ${stored.verdict} → ${ts.components.verdict}`)
      const storedP3 = (stored?.per_rule as Record<string, { status?: string }> | undefined)?.P3?.status
      const nowP3 = d.process_breach_rules?.includes('P3') ? 'fail' : 'pass'
      const y = yardById.get(d.id)
      const pressed = (d.trade_parts?.size_up?.pressed ?? []).map(x => (x == null ? 'no stop' : `$${Math.round(x)}`)).join(',')
      notes.push(`P3 stored ${storedP3} / prev build ${p3Prev(d)} / now ${nowP3}`
        + ` (usual risk ${y ? `$${Math.round(y.mean)} ± $${Math.round(y.sd)}, limit $${Math.round(y.mean + 2 * y.sd)}` : 'none: quantity rule'}`
        + `${pressed ? `; red/after-loss trades ${pressed}` : ''})`)
      const loss = ts.parts.risk.lossSize
      if (loss.n) notes.push(`loss size ${r0(loss.score)} on ${loss.n}`)
      const storedNm = eodById.get(d.id)?.execution?.execution_parameter_breakdown?.no_mistakes_tagged
      notes.push(`no-mistakes ${storedNm == null ? '—' : r0(storedNm * 100)} → from tags`)
    }
    console.log(`${d.date.padEnd(11)} ${pad(String(d.trade_count), 2)} ${pad(String(d.trade_sums?.flow.n ?? 0), 2)} |        ${quad(o, !!o?.capped)} |        ${dayQuad(ts)} |        ${dayQuad(f?.tapescore)} | ${notes.join(' · ')}`)
  }

  // ── The month's parts, as the breakdown popover shows them (setting ON) ──
  for (const [label, rows] of [['ON', on], ['OFF', off]] as const) {
    const p = aggregateTapeScore(rows.filter(x => x.date >= start && x.date <= end))
    console.log(`\n${DAILY} parts, setting ${label}: TapeScore ${p.score}`)
    for (const axis of ['risk', 'entry', 'exit'] as const) {
      console.log(`  ${axis.padEnd(5)} ${pad(r0(p[axis]), 3)}  ${axisPartLines(p.parts, axis).map(l => `${l.label}: ${l.detail}`).join(' | ')}`)
    }
  }
  console.log(`\nwrites attempted by the app code and refused here: ${blockedWrites}`)
}

main().catch(e => { console.error(e); process.exit(1) })
