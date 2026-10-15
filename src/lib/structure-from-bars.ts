/**
 * 5m structure for imported trades, read from the shared `ohlcv_bars` feed —
 * the cloud-safe counterpart of the `.scid` tagging in /api/import-sc-log.
 *
 *   structure_5m_regime    — K=4 pivot regime on NQ 5m closes, whatever was
 *                            traded (the study runs on NQ), with 7 days of
 *                            warmup before the session.
 *   structure_5m_alignment — EMA-20 on the traded instrument's own 5m closes,
 *                            from the Globex open (15:00 PT the day before).
 *
 * Why this exists: hosted imports go through /api/import-trades-csv, which
 * never set either field. Only import-sc-log did, and that route is local-only
 * (503 on tapescore.app) — so once the trader imported on the hosted site,
 * every new trade landed with both fields null, and Exit's Runner part and the
 * follow/fade analytics quietly lost them.
 *
 * Checked 2026-10-15 against the values already stored on the trader's
 * May–Aug trades: regime 184/184, and the same as the full `.scid` series
 * (scripts/backfill-structure-regime.ts) on all 402 trades since May.
 * Alignment 161/182; the 21 that differ sit at the EMA line (median 0.03% from
 * it), i.e. they were computed from an earlier snapshot of the bars.
 */
import { computeStructure5mAlignment, type StructureAlignment } from './structure-5m'
import { buildRegimeSeriesFrom1mBars, regimeAtEntry } from './nq-front-month'
import type { Regime } from './market-structure'
import { chartSeriesRoot } from './futures-symbols'
import { ptDateSodToUtcMs, sessionUtcWindow, todayPT } from './pt-time'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export interface StructureTradeInput {
  id: string
  entry_time: string | null
  direction: 'long' | 'short' | null
  symbol: string | null
}

export interface StructureFields {
  structure_5m_alignment: StructureAlignment | null
  structure_5m_regime: Regime | null
}

/** Longest run of PT dates read in one go. Keeps each bar read bounded
 *  (~30 sessions of 1m bars); a wider set of trades is split into runs. */
export const STRUCTURE_SPAN_DAYS = 21
const REGIME_WARMUP_DAYS = 7
const DAY_MS = 86_400_000

type Bar = { ts: string; high: number; low: number; close: number }

/** ohlcv_bars for one series root over [startIso, endIso], ts ascending, paged
 *  past the 1000-row cap. */
async function readBars(db: Db, root: string, startIso: string, endIso: string): Promise<Bar[]> {
  const PAGE = 1000
  const out: Bar[] = []
  for (let p = 0; p < 200; p++) {
    const { data, error } = await db
      .from('ohlcv_bars')
      .select('ts, high, low, close')
      .eq('symbol', root)
      .gte('ts', startIso)
      .lte('ts', endIso)
      .order('ts', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error || !data || data.length === 0) break
    for (const b of data as Bar[]) out.push({ ts: b.ts, high: Number(b.high), low: Number(b.low), close: Number(b.close) })
    if (data.length < PAGE) break
  }
  return out
}

function prevDate(date: string): string {
  return new Date(Date.parse(date + 'T00:00:00Z') - DAY_MS).toISOString().slice(0, 10)
}

/** Start of the Globex session a PT date belongs to: 15:00 PT the day before. */
function alignmentStartMs(date: string): number {
  return ptDateSodToUtcMs(prevDate(date), 15 * 3600)
}

/** First index in ascending `times` with times[i] >= x. */
function lowerBound(times: number[], x: number): number {
  let lo = 0, hi = times.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < x) lo = mid + 1; else hi = mid }
  return lo
}

/**
 * Both structure fields for each trade, from the bar feed. A field is null
 * where the feed can't decide it honestly: no bars near the entry, fewer than
 * 20 five-minute bars before it, or no symbol/direction for alignment.
 */
export async function computeStructureFromBars(
  db: Db,
  trades: StructureTradeInput[],
): Promise<Map<string, StructureFields>> {
  const out = new Map<string, StructureFields>()
  const dated = trades
    .filter(t => t.entry_time && Number.isFinite(Date.parse(t.entry_time)))
    .map(t => ({ t, ms: Date.parse(t.entry_time!), date: todayPT(new Date(t.entry_time!)) }))
    .sort((a, b) => a.ms - b.ms)

  // Runs of at most STRUCTURE_SPAN_DAYS, so each read stays bounded however
  // far apart the trades are.
  const runs: (typeof dated)[] = []
  for (const x of dated) {
    const run = runs[runs.length - 1]
    if (run && Date.parse(x.date) - Date.parse(run[0].date) <= STRUCTURE_SPAN_DAYS * DAY_MS) run.push(x)
    else runs.push([x])
  }

  for (const run of runs) {
    const first = run[0].date
    const endIso = sessionUtcWindow(run[run.length - 1].date).end

    const nq = await readBars(db, 'NQ', new Date(Date.parse(first + 'T00:00:00Z') - REGIME_WARMUP_DAYS * DAY_MS).toISOString(), endIso)
    const series = buildRegimeSeriesFrom1mBars(nq)

    const barsByRoot = new Map<string, { bars: Bar[]; times: number[] }>([['NQ', { bars: nq, times: nq.map(b => Date.parse(b.ts)) }]])
    const alignStartIso = new Date(alignmentStartMs(first)).toISOString()
    for (const x of run) {
      if (!x.t.symbol) continue
      const root = chartSeriesRoot(x.t.symbol)
      if (barsByRoot.has(root)) continue
      const bars = await readBars(db, root, alignStartIso, endIso)
      barsByRoot.set(root, { bars, times: bars.map(b => Date.parse(b.ts)) })
    }

    for (const x of run) {
      const regime = series ? regimeAtEntry(series, x.ms) : null
      let alignment: StructureAlignment | null = null
      const feed = x.t.symbol ? barsByRoot.get(chartSeriesRoot(x.t.symbol)) : undefined
      if (feed && x.t.direction) {
        // This session's bars up to the entry; the alignment rule drops
        // anything after the entry instant itself.
        const from = lowerBound(feed.times, alignmentStartMs(x.date))
        const to = lowerBound(feed.times, x.ms + 1)
        alignment = computeStructure5mAlignment({ entry_time: x.t.entry_time, direction: x.t.direction }, feed.bars.slice(from, to))
      }
      out.set(x.t.id, { structure_5m_alignment: alignment, structure_5m_regime: regime })
    }
  }
  return out
}

/**
 * Fill whichever structure field is still null on the trades of these trading
 * days. Never overwrites a stored value. With `write: false` it computes and
 * counts without writing. Returns trades looked at and trades filled.
 */
export async function fillStructureForDays(
  db: Db,
  dayIds: string[],
  opts: { write?: boolean } = {},
): Promise<{ targets: number; filled: number }> {
  if (dayIds.length === 0) return { targets: 0, filled: 0 }
  type Target = StructureTradeInput & { structure_5m_alignment: string | null; structure_5m_regime: string | null }
  const targets: Target[] = []
  const PAGE = 1000
  for (let p = 0; p < 50; p++) {
    const { data, error } = await db
      .from('trades')
      .select('id, entry_time, direction, symbol, structure_5m_alignment, structure_5m_regime')
      .in('trading_day_id', dayIds)
      .or('structure_5m_alignment.is.null,structure_5m_regime.is.null')
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) throw new Error(`structure targets: ${error.message}`)
    if (!data || data.length === 0) break
    targets.push(...(data as Target[]))
    if (data.length < PAGE) break
  }
  if (targets.length === 0) return { targets: 0, filled: 0 }

  const computed = await computeStructureFromBars(db, targets)
  // One update per distinct value pair rather than one per trade.
  const groups = new Map<string, { patch: Record<string, string>; ids: string[] }>()
  for (const t of targets) {
    const c = computed.get(t.id)
    if (!c) continue
    const patch: Record<string, string> = {}
    if (t.structure_5m_alignment == null && c.structure_5m_alignment) patch.structure_5m_alignment = c.structure_5m_alignment
    if (t.structure_5m_regime == null && c.structure_5m_regime) patch.structure_5m_regime = c.structure_5m_regime
    if (Object.keys(patch).length === 0) continue
    const key = JSON.stringify(patch)
    const g = groups.get(key) ?? { patch, ids: [] }
    g.ids.push(t.id)
    groups.set(key, g)
  }

  let filled = 0
  for (const { patch, ids } of groups.values()) {
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100)
      if (opts.write === false) { filled += chunk.length; continue }
      const { error } = await db.from('trades').update(patch).in('id', chunk)
      if (error) console.error('[structure-from-bars] update failed:', error.message)
      else filled += chunk.length
    }
  }
  return { targets: targets.length, filled }
}
