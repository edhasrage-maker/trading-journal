/**
 * Shared trader-data context builder used by BOTH:
 *   - /api/coach (the chatbox) — full 180-day window with week-over-week
 *   - /api/analyze-week (the weekly recap synthesis) — single-week window
 *
 * Sharing this code is what guarantees the chatbox and the weekly recap
 * agree on patterns. They read the same trades, apply the same
 * aggregations, and produce numerically identical conclusions for any
 * overlapping window.
 *
 * Returns a compact, structured text block suitable for prompt injection.
 */

import { interpretExcursion } from './trade-excursion'
import { computeBehavioralProxies } from './behavioral-proxies'
import { fetchJournalEntries, journalLanguageHeatmapPromptBlock } from './journal-language-heatmap'
import { fetchOpenThread, coachingThreadPromptBlock } from './coaching-thread'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export interface CoachContextOptions {
  /** ISO date YYYY-MM-DD. Window start (inclusive). */
  startDate: string
  /** ISO date YYYY-MM-DD. Window end (inclusive). */
  endDate: string
  /** Human-readable label for the window — printed in the context header.
   *  e.g. "last 180 days", "week of Jun 16", "this week". */
  windowLabel: string
  /** Include this-week vs prior-week comparison. Defaults to false. Only
   *  meaningful when the window spans at least 2 weeks. */
  includeWeekOverWeek?: boolean
  /** Max recent trades to include in the terse-format list. Defaults to 50. */
  recentTradesLimit?: number
}

const fmt = (n: number) => (n >= 0 ? '+' : '') + '$' + Math.round(n).toLocaleString()
const sortByCount = <T extends { count: number }>(map: Map<string, T>, n = 10) =>
  Array.from(map.entries()).sort((a, b) => b[1].count - a[1].count).slice(0, n)
const sortByPnl = <T extends { pnl: number }>(map: Map<string, T>, n = 10) =>
  Array.from(map.entries()).sort((a, b) => b[1].pnl - a[1].pnl).slice(0, n)

interface TradeContextRow {
  id: string
  trading_day_id: string
  entry_time: string | null
  exit_time: string | null
  direction: 'long' | 'short' | null
  pnl: number | null
  entry_price: number | null
  stop_price: number | null
  high_during_position: number | null  // tick-precise high while in trade — long MFE source
  low_during_position: number | null   // tick-precise low while in trade — short MFE source
  mfe_dollars_per_leg: number | null   // scaling-aware best-case $ (peak per leg) — primary capture basis
  entry_atr_1m: number | null          // ATR-10 (1m) at entry — normalizes MFE/MAE to volatility units
  quantity: number | null
  symbol: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tags_json: any
  structure_5m_alignment: string | null
  notes: string | null                 // trader's per-trade free text — fuels the journal heatmap
}

export async function buildCoachContext(supabase: AnyClient, opts: CoachContextOptions): Promise<string> {
  const { startDate, endDate, windowLabel, includeWeekOverWeek = false, recentTradesLimit = 50 } = opts

  // Pull trading_days first so we have the day-type map for cross-tabulation.
  const { data: days } = await supabase
    .from('trading_days')
    .select('id, date, day_types, eod_pnl, eod_ai_analysis_json')
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: false })
  const dayDateById = new Map<string, string>()
  const dayTypesById = new Map<string, string[]>()
  // Per-day EOD verdicts (#2b) — Process (Compliant/Breach) + Execution composite,
  // read from the EOD analysis so the chat coach can CITE them instead of
  // re-deriving. null when a day hasn't been analyzed.
  const verdictByDay = new Map<string, { verdict: string | null; composite: number | null }>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const d of (days ?? []) as Array<{ id: string; date: string; day_types: string[] | null; eod_ai_analysis_json: any }>) {
    dayDateById.set(d.id, d.date)
    dayTypesById.set(d.id, Array.isArray(d.day_types) ? d.day_types : [])
    const eod = d.eod_ai_analysis_json
    if (eod && (eod.process || eod.execution)) {
      verdictByDay.set(d.id, {
        verdict: eod.process?.verdict ?? null,
        composite: typeof eod.execution?.composite === 'number' ? eod.execution.composite : null,
      })
    }
  }

  // Paginate trades within the window.
  const PAGE = 1000
  const trades: TradeContextRow[] = []
  const dayIds = Array.from(dayDateById.keys())
  if (dayIds.length === 0) {
    return `═══ TRADER DATA SUMMARY ═══
Window: ${windowLabel} (${startDate} → ${endDate}).
NO TRADE DATA — no trading days in this window.
═══ END TRADER DATA ═══`
  }
  for (let p = 0; p < 10; p++) {
    const { data } = await supabase
      .from('trades')
      .select('id, trading_day_id, entry_time, exit_time, direction, pnl, entry_price, stop_price, high_during_position, low_during_position, mfe_dollars_per_leg, entry_atr_1m, quantity, symbol, tags_json, structure_5m_alignment, notes')
      .in('trading_day_id', dayIds)
      .order('entry_time', { ascending: false })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (!data || data.length === 0) break
    trades.push(...data)
    if (data.length < PAGE) break
  }

  // Day conditions (#2c) — RVOL/ATR regime per day so the coach can judge
  // whether the trader is selective on the day types they do well on. Keyed by
  // trading_day_id (one market_context row per day/symbol; take the first).
  const mcByDay = new Map<string, { rvol: number | null; atr: number | null }>()
  {
    const { data: mcs } = await supabase
      .from('market_context')
      .select('trading_day_id, rvol, atr_1m')
      .in('trading_day_id', dayIds)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const m of (mcs ?? []) as any[]) {
      if (!mcByDay.has(m.trading_day_id)) {
        mcByDay.set(m.trading_day_id, { rvol: m.rvol ?? null, atr: m.atr_1m ?? null })
      }
    }
  }
  // The stored rvol/atr flags are almost never set, and rvol isn't a clean ratio
  // — so bucket each day into low/mid/high thirds of the trader's OWN window
  // distribution (unit-agnostic). Answers "are you selective on high- vs low-
  // participation / volatility days?" without depending on absolute thresholds.
  const terciles = (vals: number[]): [number, number] | null => {
    const s = vals.filter(v => v != null).sort((a, b) => a - b)
    if (s.length < 6) return null
    return [s[Math.floor(s.length / 3)], s[Math.floor((2 * s.length) / 3)]]
  }
  const rvolCut = terciles(Array.from(mcByDay.values()).map(m => m.rvol).filter((v): v is number => v != null))
  const atrCut = terciles(Array.from(mcByDay.values()).map(m => m.atr).filter((v): v is number => v != null))
  const classifyBand = (v: number | null, cut: [number, number] | null, labels: [string, string, string]): string | null => {
    if (v == null || !cut) return null
    return v < cut[0] ? labels[0] : v <= cut[1] ? labels[1] : labels[2]
  }

  // Post-exit continuation (#1) — MARKET-SENSE / directional-read signal (did the
  // read keep working after exit). Fetched in its OWN query so a missing column
  // (pre-migration) disables only this block, never the main trades read. Values
  // are already direction-relative: favorable = continued the trade's way.
  const postExitById = new Map<string, { fav: number; against: number }>()
  for (let p = 0; p < 10; p++) {
    const { data: pe, error: peErr } = await supabase
      .from('trades')
      .select('id, post_exit_favorable_pts, post_exit_against_pts')
      .in('trading_day_id', dayIds)
      .not('post_exit_favorable_pts', 'is', null)
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (peErr || !pe || pe.length === 0) break   // column missing / no rows → stop
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of pe as any[]) {
      if (r.post_exit_favorable_pts != null && r.post_exit_against_pts != null) {
        postExitById.set(r.id, { fav: Number(r.post_exit_favorable_pts), against: Number(r.post_exit_against_pts) })
      }
    }
    if (pe.length < PAGE) break
  }

  // ── Aggregates ──
  const total = trades.length
  if (total === 0) {
    return `═══ TRADER DATA SUMMARY ═══
Window: ${windowLabel} (${startDate} → ${endDate}).
NO TRADE DATA — the trader logged no trades in this window.
═══ END TRADER DATA ═══`
  }

  const winners = trades.filter(t => (t.pnl ?? 0) > 0).length
  const losers = trades.filter(t => (t.pnl ?? 0) < 0).length
  const winRate = (winners + losers) > 0 ? (winners / (winners + losers)) * 100 : 0
  const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const sumW = trades.filter(t => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl ?? 0), 0)
  const sumL = trades.filter(t => (t.pnl ?? 0) < 0).reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0)
  const profitFactor = sumL > 0 ? sumW / sumL : (sumW > 0 ? Infinity : 0)

  const setupBuckets = new Map<string, { count: number; wins: number; losers: number; pnl: number; rs: number[]; capPcts: number[]; lefts: number[] }>()
  const mistakeCounts = new Map<string, { count: number; pnl: number }>()
  const dayTypeBuckets = new Map<string, { count: number; wins: number; pnl: number }>()
  const ofBuckets = new Map<string, { count: number; wins: number; pnl: number }>()
  const structureBuckets = new Map<string, { count: number; wins: number; pnl: number }>()
  const monthBuckets = new Map<string, { count: number; wins: number; losers: number; pnl: number }>()
  // Day-condition regime buckets (#2c) — trades bucketed by their day's RVOL/ATR
  // flag so the coach can see if the trader is selective on the regimes they win in.
  const rvolBuckets = new Map<string, { count: number; wins: number; pnl: number }>()
  const atrRegimeBuckets = new Map<string, { count: number; wins: number; pnl: number }>()

  // Exit efficiency (MFE capture) — answers "am I leaving runners on the table /
  // should I hold for a TP2?". PRIMARY basis is DOLLARS: mfe_dollars_per_leg
  // (best-case $ if every leg had exited at its in-trade peak) vs realized pnl.
  // It needs no stop, so it covers ~all trades. SECONDARY basis is R-multiples
  // (mfeR = favorable excursion ÷ stop distance) — only computable when a stop
  // was logged, but it quantifies whether a ≥2R/≥3R TP2 was actually reachable.
  const exitEff = {
    dollar: { n: 0, sumCapPct: 0, sumLeft: 0, sumRealized: 0, sumMfe: 0 },   // winners, $ basis
    r: { withStop: 0, ge2R: 0, ge3R: 0, winners: 0, winGe2R: 0, winGe3R: 0 }, // trades w/ a stop
  }
  // Per-trade derived metrics keyed by id so the recent-trades list can show
  // realized R, mfeR, $ capture%, and MAE% without recomputing.
  const derived = new Map<string, { r: number | null; mfeR: number | null; capPct: number | null; maePct: number | null; mfeAtr: number | null; maeAtr: number | null }>()

  // MAE / HEAT TAKEN — the adverse twin of exit efficiency. "Planned" heat = the
  // stop distance (entry→stop, i.e. the max adverse you signed up for); "taken"
  // heat = how far price actually went against the trade (long→low, short→high)
  // before it resolved. taken ÷ planned = the share of the stop budget price
  // chewed through. Surfaces the trader's core claim — winners take little heat,
  // losers take a lot — and whether stops are sized to the heat trades take.
  const maeAgg = {
    win: { n: 0, sumPts: 0, sumPct: 0 },
    loss: { n: 0, sumPts: 0, sumPct: 0 },
  }
  const maeBuckets = new Map<string, { count: number; wins: number; losers: number; pnl: number; rs: number[] }>()
  const MAE_BUCKETS: Array<[string, (p: number) => boolean]> = [
    ['0-25% of stop', p => p < 0.25],
    ['25-50% of stop', p => p >= 0.25 && p < 0.5],
    ['50-75% of stop', p => p >= 0.5 && p < 0.75],
    ['75-100% of stop', p => p >= 0.75 && p <= 1],
    ['>100% (stop hit / exceeded)', p => p > 1],
  ]
  // ×ATR (volatility-normalized) excursion, split winners/losers — the third unit
  // alongside $ and points so size can be pulled apart in the read.
  const atrAgg = {
    mfeWin: { n: 0, sum: 0 }, mfeAll: { n: 0, sum: 0 },
    maeWin: { n: 0, sum: 0 }, maeLoss: { n: 0, sum: 0 },
  }

  for (const t of trades) {
    const pnl = t.pnl ?? 0
    // All per-trade MFE/MAE interpretation lives in the shared helper so the
    // coach, the weekly recap, and the video-recap commentary can't drift.
    const { isWin, r, mfeUsd, capPct, leftUsd, mfeR, maePts, maePct, mfeAtr, maeAtr } = interpretExcursion(t)

    // ×ATR accumulation (volatility-normalized excursion).
    if (mfeAtr != null) { atrAgg.mfeAll.n++; atrAgg.mfeAll.sum += mfeAtr; if (isWin) { atrAgg.mfeWin.n++; atrAgg.mfeWin.sum += mfeAtr } }
    if (maeAtr != null) { if (isWin) { atrAgg.maeWin.n++; atrAgg.maeWin.sum += maeAtr } else if ((t.pnl ?? 0) < 0) { atrAgg.maeLoss.n++; atrAgg.maeLoss.sum += maeAtr } }

    // Exit-efficiency $ aggregation — winners only (capPct is set exactly when
    // the trade won and had a positive best-case $).
    if (capPct != null && mfeUsd != null) {
      const dl = exitEff.dollar
      dl.n++; dl.sumCapPct += capPct; dl.sumLeft += leftUsd ?? 0; dl.sumRealized += pnl; dl.sumMfe += mfeUsd
    }

    // TP2 reachability aggregation — trades with a logged stop.
    if (mfeR != null) {
      const rb = exitEff.r
      rb.withStop++; if (mfeR >= 2) rb.ge2R++; if (mfeR >= 3) rb.ge3R++
      if (isWin) { rb.winners++; if (mfeR >= 2) rb.winGe2R++; if (mfeR >= 3) rb.winGe3R++ }
    }

    // MAE / heat-taken aggregation — winners-vs-losers heat + the
    // win-rate-by-heat-taken buckets.
    if (maePct != null && maePts != null) {
      const side = isWin ? maeAgg.win : (pnl < 0 ? maeAgg.loss : null)
      if (side) { side.n++; side.sumPts += maePts; side.sumPct += maePct }
      for (const [label, test] of MAE_BUCKETS) {
        if (test(maePct)) {
          const b = maeBuckets.get(label) ?? { count: 0, wins: 0, losers: 0, pnl: 0, rs: [] }
          b.count++; if (isWin) b.wins++; if (pnl < 0) b.losers++; b.pnl += pnl
          if (r != null) b.rs.push(r)
          maeBuckets.set(label, b)
          break
        }
      }
    }

    derived.set(t.id, { r, mfeR, capPct, maePct, mfeAtr, maeAtr })

    const setups = (t.tags_json?.setups as string[]) ?? []
    const pushSetup = (key: string) => {
      const b = setupBuckets.get(key) ?? { count: 0, wins: 0, losers: 0, pnl: 0, rs: [], capPcts: [], lefts: [] }
      b.count++; if (isWin) b.wins++; if (pnl < 0) b.losers++; b.pnl += pnl
      if (r != null) b.rs.push(r)
      if (capPct != null) b.capPcts.push(capPct)
      if (isWin && mfeUsd != null && mfeUsd > 0) b.lefts.push(Math.max(0, mfeUsd - pnl))
      setupBuckets.set(key, b)
    }
    if (setups.length === 0) pushSetup('Discretionary/No Setup')
    else for (const s of setups) pushSetup(s)

    const mistakes = (t.tags_json?.mistakes as string[]) ?? []
    for (const m of mistakes) {
      const b = mistakeCounts.get(m) ?? { count: 0, pnl: 0 }
      b.count++; b.pnl += pnl
      mistakeCounts.set(m, b)
    }

    const dayTypes = dayTypesById.get(t.trading_day_id) ?? []
    for (const dt of dayTypes) {
      const b = dayTypeBuckets.get(dt) ?? { count: 0, wins: 0, pnl: 0 }
      b.count++; if (isWin) b.wins++; b.pnl += pnl
      dayTypeBuckets.set(dt, b)
    }

    const ofs = (t.tags_json?.order_flow as string[]) ?? []
    for (const o of ofs) {
      const b = ofBuckets.get(o) ?? { count: 0, wins: 0, pnl: 0 }
      b.count++; if (isWin) b.wins++; b.pnl += pnl
      ofBuckets.set(o, b)
    }

    if (t.structure_5m_alignment) {
      const b = structureBuckets.get(t.structure_5m_alignment) ?? { count: 0, wins: 0, pnl: 0 }
      b.count++; if (isWin) b.wins++; b.pnl += pnl
      structureBuckets.set(t.structure_5m_alignment, b)
    }

    // Bucket the trade under its day's RVOL / ATR tercile band.
    const mc = mcByDay.get(t.trading_day_id)
    const rvolBand = classifyBand(mc?.rvol ?? null, rvolCut, ['low participation', 'normal', 'high participation'])
    if (rvolBand) {
      const b = rvolBuckets.get(rvolBand) ?? { count: 0, wins: 0, pnl: 0 }
      b.count++; if (isWin) b.wins++; b.pnl += pnl
      rvolBuckets.set(rvolBand, b)
    }
    const atrBand = classifyBand(mc?.atr ?? null, atrCut, ['low volatility', 'normal', 'high volatility'])
    if (atrBand) {
      const b = atrRegimeBuckets.get(atrBand) ?? { count: 0, wins: 0, pnl: 0 }
      b.count++; if (isWin) b.wins++; b.pnl += pnl
      atrRegimeBuckets.set(atrBand, b)
    }

    // Per-calendar-month bucket (key = YYYY-MM) so the coach can answer
    // month-over-month questions. Uses the trade's entry_time, NOT the
    // day-id, so it works regardless of trading_days join state.
    const ym = (t.entry_time ?? '').slice(0, 7)
    if (ym) {
      const b = monthBuckets.get(ym) ?? { count: 0, wins: 0, losers: 0, pnl: 0 }
      b.count++; if (isWin) b.wins++; if (pnl < 0) b.losers++; b.pnl += pnl
      monthBuckets.set(ym, b)
    }
  }

  // ── Behavioral proxies across the window (#2a) ──
  // Run the per-session proxy detector on EACH day's fills, then aggregate how
  // often each pattern fired. A single day's tilt is noise; the same pattern on
  // many sessions is a behavioral leak the coach should surface.
  const tradesByDay = new Map<string, typeof trades>()
  for (const t of trades) {
    const arr = tradesByDay.get(t.trading_day_id) ?? []
    arr.push(t)
    tradesByDay.set(t.trading_day_id, arr)
  }
  const proxyTally = new Map<string, { label: string; flag: number; mild: number }>()
  let proxyScoredDays = 0
  for (const [, dayTrades] of tradesByDay) {
    if (dayTrades.length < 2) continue
    proxyScoredDays++
    const { proxies } = computeBehavioralProxies(dayTrades.map(t => ({
      id: t.id, direction: t.direction, entry_time: t.entry_time, exit_time: t.exit_time, pnl: t.pnl, quantity: t.quantity,
    })))
    for (const p of proxies) {
      if (p.severity === 'none') continue
      const e = proxyTally.get(p.key) ?? { label: p.label, flag: 0, mild: 0 }
      if (p.severity === 'flag') e.flag++; else e.mild++
      proxyTally.set(p.key, e)
    }
  }

  // ── EOD verdict aggregation (#2b) ──
  let compliantDays = 0, breachDays = 0, execN = 0, execSum = 0
  const breachDates: string[] = []
  for (const [dayId, v] of verdictByDay) {
    if (v.verdict === 'Compliant') compliantDays++
    else if (v.verdict === 'Breach') { breachDays++; const dt = dayDateById.get(dayId); if (dt) breachDates.push(dt) }
    if (v.composite != null) { execN++; execSum += v.composite }
  }
  breachDates.sort((a, b) => b.localeCompare(a))

  // Recent trades (newest first, capped at recentTradesLimit)
  const recent = trades.slice(0, recentTradesLimit).map(t => {
    const date = dayDateById.get(t.trading_day_id) ?? '?'
    const dir = t.direction?.[0]?.toUpperCase() ?? '?'
    const setups = ((t.tags_json?.setups as string[]) ?? []).join(',') || '—'
    const mistakes = ((t.tags_json?.mistakes as string[]) ?? []).join(',') || '—'
    const d = derived.get(t.id)
    const r = d?.r ?? null
    const mfeR = d?.mfeR ?? null
    const cap = d?.capPct ?? null
    const mae = d?.maePct ?? null
    const mfeAtr = d?.mfeAtr ?? null
    const maeAtr = d?.maeAtr ?? null
    return `${date} ${dir}${t.quantity ?? '?'} pnl=${t.pnl?.toFixed(0) ?? '?'}${r != null ? ` R=${r.toFixed(2)}` : ''}${mfeR != null ? ` mfeR=${mfeR.toFixed(2)}` : ''}${cap != null ? ` cap=${Math.round(cap * 100)}%` : ''}${mae != null ? ` mae=${Math.round(mae * 100)}%` : ''}${mfeAtr != null ? ` mfe×ATR=${mfeAtr.toFixed(2)}` : ''}${maeAtr != null ? ` mae×ATR=${maeAtr.toFixed(2)}` : ''} setup=[${setups}]${mistakes !== '—' ? ' mistake=['+mistakes+']' : ''}${t.structure_5m_alignment ? ' 5m='+t.structure_5m_alignment : ''}`
  }).join('\n')

  // Optional week-over-week comparison — only meaningful for the chatbox's
  // 180-day window, not the weekly recap (which IS one week).
  let weekOverWeekBlock = ''
  if (includeWeekOverWeek) {
    const endMs = Date.parse(endDate + 'T23:59:59Z')
    const past7 = new Date(endMs - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const past14 = new Date(endMs - 14 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const tradesThisWeek = trades.filter(t => (t.entry_time ?? '').slice(0, 10) >= past7)
    const tradesPriorWeek = trades.filter(t => {
      const d = (t.entry_time ?? '').slice(0, 10)
      return d >= past14 && d < past7
    })
    const wkPnl = (arr: TradeContextRow[]) => arr.reduce((s, t) => s + (t.pnl ?? 0), 0)
    const wkWR = (arr: TradeContextRow[]) => {
      const w = arr.filter(t => (t.pnl ?? 0) > 0).length
      const l = arr.filter(t => (t.pnl ?? 0) < 0).length
      return (w + l) > 0 ? Math.round((w / (w + l)) * 100) : null
    }
    weekOverWeekBlock = `

THIS WEEK vs PRIOR WEEK:
  This week  (${past7} → ${endDate}): ${tradesThisWeek.length} trades · ${fmt(wkPnl(tradesThisWeek))} · WR ${wkWR(tradesThisWeek) ?? '—'}%
  Prior week (${past14} → ${past7}): ${tradesPriorWeek.length} trades · ${fmt(wkPnl(tradesPriorWeek))} · WR ${wkWR(tradesPriorWeek) ?? '—'}%`
  }

  // Exit-efficiency summary. Dollar basis is the headline (covers ~all trades);
  // R basis adds TP2-reachability where a stop was logged.
  const dl = exitEff.dollar
  const rb = exitEff.r
  const pct = (num: number, den: number) => den > 0 ? Math.round((num / den) * 100) : 0
  const usd = (n: number) => '$' + Math.round(n).toLocaleString()
  const avgAtr = (a: { n: number; sum: number }) => a.n > 0 ? (a.sum / a.n).toFixed(2) : '—'
  const exitEffBlock = (dl.n === 0 && rb.withStop === 0)
    ? '  (no MFE data on trades in this window)'
    : `  WINNERS scored ($ basis, no stop needed): ${dl.n} of ${winners} winners
  Captured ${pct(dl.sumCapPct, dl.n)}% of the available favorable move on avg · left ${dl.n > 0 ? usd(dl.sumLeft / dl.n) : '—'}/win on the table (avg realized ${dl.n > 0 ? usd(dl.sumRealized / dl.n) : '—'} vs avg peak ${dl.n > 0 ? usd(dl.sumMfe / dl.n) : '—'})
  MFE size (×ATR, ${atrAgg.mfeAll.n} trades w/ ATR): all ${avgAtr(atrAgg.mfeAll)}×ATR · winners ${avgAtr(atrAgg.mfeWin)}×ATR — ×ATR is SIZE-AGNOSTIC; read it next to the $ above, not instead of it (a big ×ATR move on small size is small $; $ is the goal)
  TP2 reachability (R basis, ${rb.withStop} trades w/ a logged stop): any ran ≥2R ${pct(rb.ge2R, rb.withStop)}% · ≥3R ${pct(rb.ge3R, rb.withStop)}% · winners ≥2R ${pct(rb.winGe2R, rb.winners)}% · ≥3R ${pct(rb.winGe3R, rb.winners)}%`

  // MAE / heat-taken summary — the adverse twin of exit efficiency. Headline is
  // winners-vs-losers avg heat (the trader's strongest winner/loser separator);
  // the heat-bucket table is the win-rate-by-heat-taken cross-tab.
  const maeScored = maeAgg.win.n + maeAgg.loss.n
  const avgPts = (a: { n: number; sumPts: number }) => a.n > 0 ? (a.sumPts / a.n).toFixed(1) : '—'
  const avgPctOf = (a: { n: number; sumPct: number }) => a.n > 0 ? Math.round((a.sumPct / a.n) * 100) + '%' : '—'
  const maeBlock = maeScored === 0
    ? '  (no trades with both a logged stop and in-trade extremes in this window)'
    : `  Scored ${maeScored} trades (had a logged stop + in-trade high/low).
  Winners: avg heat ${avgPts(maeAgg.win)} pts (${avgPctOf(maeAgg.win)} of planned stop${atrAgg.maeWin.n > 0 ? `, ${avgAtr(atrAgg.maeWin)}×ATR` : ''}) across ${maeAgg.win.n} wins
  Losers:  avg heat ${avgPts(maeAgg.loss)} pts (${avgPctOf(maeAgg.loss)} of planned stop${atrAgg.maeLoss.n > 0 ? `, ${avgAtr(atrAgg.maeLoss)}×ATR` : ''}) across ${maeAgg.loss.n} losses
  WIN RATE BY HEAT TAKEN (share of the planned stop distance price used before the trade resolved):
${MAE_BUCKETS.map(([label]) => {
    const b = maeBuckets.get(label)
    if (!b) return `    ${label}: 0 trades`
    const wr = (b.wins + b.losers) > 0 ? Math.round((b.wins / (b.wins + b.losers)) * 100) : 0
    const avgR = b.rs.length > 0 ? (b.rs.reduce((a, x) => a + x, 0) / b.rs.length).toFixed(2) : '—'
    return `    ${label}: ${b.count} trades · WR ${wr}% · avgR ${avgR} · ${fmt(b.pnl)}`
  }).join('\n')}`

  // Day-conditions regime performance (#2c) — are they selective on the regimes they win in?
  const regimeLine = (m: Map<string, { count: number; wins: number; pnl: number }>, order: string[]) =>
    order.filter(k => m.has(k)).map(k => {
      const b = m.get(k)!
      return `    ${k}: ${b.count} trades · ${fmt(b.pnl)} · WR ${Math.round((b.wins / b.count) * 100)}%`
    }).join('\n')
  const conditionsBlock = (rvolBuckets.size === 0 && atrRegimeBuckets.size === 0)
    ? '  (not enough market-context data to split days by regime in this window)'
    : `  By PARTICIPATION — RVOL terciles of your own days (low = quiet tape, high = busy):
${regimeLine(rvolBuckets, ['low participation', 'normal', 'high participation']) || '    (n/a)'}
  By VOLATILITY — ATR terciles of your own days:
${regimeLine(atrRegimeBuckets, ['low volatility', 'normal', 'high volatility']) || '    (n/a)'}`

  // Behavioral patterns across sessions (#2a) — one day is noise; recurrence is a leak.
  const proxyBlock = proxyTally.size === 0
    ? '  (no behavioral-pattern signals across sessions in this window)'
    : Array.from(proxyTally.values()).map(p => `  ${p.label}: flagged on ${p.flag} session${p.flag === 1 ? '' : 's'}${p.mild ? `, mild on ${p.mild}` : ''} (of ${proxyScoredDays} multi-trade sessions)`).join('\n')

  // Post-exit continuation summary (#1) — directional-read / market-sense.
  const peVals = Array.from(postExitById.values())
  const postExitBlock = peVals.length === 0
    ? '  (no post-exit data yet — apply migration 20260705 + run scripts/backfill-post-exit.ts)'
    : (() => {
        const n = peVals.length
        const avgFav = peVals.reduce((s, v) => s + v.fav, 0) / n
        const avgAgainst = peVals.reduce((s, v) => s + v.against, 0) / n
        const held = peVals.filter(v => v.fav > v.against).length
        return `  Scored ${n} trades (30-min window after exit).
  After exit, price continued YOUR direction by avg ${avgFav.toFixed(1)} pts vs reversed against you by avg ${avgAgainst.toFixed(1)} pts.
  Directional read kept working (continued your way) on ${held}/${n} (${Math.round((held / n) * 100)}%). Persistently more 'against' than 'favorable' = repeatedly on the wrong side (directional-bias problem). This is a MARKET-SENSE read — do NOT use it to grade exit timing; if early-exit is a stated edge, price continuing after exit is expected, not an error.`
      })()

  // Journal language heatmap (Pt 3) — mine the trader's OWN free text (prep,
  // per-trade notes, EOD, weekly) for recurring words/phrases + emotional
  // language, correlated to outcomes, so the coach can react (uplift on
  // self-criticism that lands on good days; flag hedged reads that lose). Reuses
  // the trades already in hand; fetches the other three surfaces. Best-effort.
  const journalEntries = await fetchJournalEntries(supabase, { startDate, endDate, trades })
  const journalBlock = journalLanguageHeatmapPromptBlock(journalEntries).trim()

  // Coaching thread (Pt 4) — the coach's OWN prior directives + the trader's
  // commitments, distilled from finished chats. Placed LAST (highest recency
  // within this block; the route still appends Focus after) so follow-ups feel
  // present, not buried. Best-effort — empty/no-op until the table exists.
  const coachingThread = coachingThreadPromptBlock(await fetchOpenThread(supabase)).trim()

  // EOD Process/Execution verdicts (#2b) — cite these, don't re-derive.
  const analyzedDays = compliantDays + breachDays
  const verdictBlock = analyzedDays === 0
    ? '  (no days analyzed for Process/Execution yet in this window)'
    : `  Process: ${compliantDays}/${analyzedDays} analyzed days Compliant, ${breachDays} Breach${breachDates.length ? ` (breach days: ${breachDates.slice(0, 10).join(', ')}${breachDates.length > 10 ? '…' : ''})` : ''}
  Execution: avg composite ${execN > 0 ? Math.round((execSum / execN) * 100) + '%' : '—'} across ${execN} scored days`

  return `═══ TRADER DATA SUMMARY ═══
Window: ${windowLabel} (${startDate} → ${endDate}). Total trades: ${total}.

OVERALL:
  Win rate: ${winRate.toFixed(0)}% (${winners}W / ${losers}L)
  Total PnL: ${fmt(totalPnl)}
  Profit factor: ${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : '∞'}${weekOverWeekBlock}

PROCESS & EXECUTION (from the trader's own EOD analyses — cite these directly; Process = did they follow their safety rails, Execution = decision quality, two SEPARATE axes):
${verdictBlock}

MONTH-BY-MONTH (chronological — each month's trade count, PnL, win rate, profit factor):
${Array.from(monthBuckets.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([ym, b]) => {
    const wr = (b.wins + b.losers) > 0 ? Math.round((b.wins / (b.wins + b.losers)) * 100) : 0
    return `  ${ym}: ${b.count} trades · ${fmt(b.pnl)} · WR ${wr}%`
  }).join('\n') || '  (no trades in window)'}

EXIT EFFICIENCY — MFE CAPTURE (how much of the favorable move you keep; informs whether to hold for a TP2 / runner vs take TP1):
${exitEffBlock}

MAE — HEAT TAKEN (adverse excursion before the trade resolved; "planned" heat = your stop distance, "taken" = the actual move against you. Speaks to entry timing, stop sizing, and risk management — low heat on winners = clean entries; high heat that still won = nearly stopped out):
${maeBlock}

POST-EXIT — MARKET SENSE / DIRECTIONAL READ (where price went in the 30 min AFTER you exited; a read on directional bias, NOT an exit-timing grade):
${postExitBlock}

SETUP PERFORMANCE (by total PnL, top 10) — avgR realized; captured%/left$ = winners' $ MFE capture (TP2 headroom per setup):
${sortByPnl(setupBuckets).map(([s, b]) => {
    const avgR = b.rs.length > 0 ? (b.rs.reduce((a, r) => a + r, 0) / b.rs.length).toFixed(2) : '—'
    const avgCap = b.capPcts.length > 0 ? Math.round((b.capPcts.reduce((a, c) => a + c, 0) / b.capPcts.length) * 100) : null
    const avgLeft = b.lefts.length > 0 ? b.lefts.reduce((a, x) => a + x, 0) / b.lefts.length : null
    return `  ${s}: ${b.count} trades · ${fmt(b.pnl)} · WR ${Math.round((b.wins / (b.wins + b.losers || 1)) * 100)}% · avgR ${avgR}${avgCap != null ? ` · winners captured ${avgCap}%` : ''}${avgLeft != null ? ` · left ${usd(avgLeft)}/win` : ''}`
  }).join('\n')}

DAY TYPE PERFORMANCE (by total PnL, top 10):
${sortByPnl(dayTypeBuckets).map(([d, b]) => `  ${d}: ${b.count} trades · ${fmt(b.pnl)} · WR ${Math.round((b.wins / b.count) * 100)}%`).join('\n') || '  (no day_types tagged in window)'}

DAY CONDITIONS — PERFORMANCE BY REGIME (are you selective on the conditions you win in? judge day-type selectivity against this):
${conditionsBlock}

TOP MISTAKES (by frequency, top 10):
${sortByCount(mistakeCounts).map(([m, b]) => `  ${m}: ${b.count} occurrences · ${fmt(b.pnl)} total PnL impact`).join('\n') || '  (no mistakes tagged in window)'}

BEHAVIORAL PATTERNS ACROSS SESSIONS (derived from the fill sequence — tilt/stacking/pressing/shrinking-hold; a pattern on ONE day is noise, recurrence is a leak):
${proxyBlock}
${journalBlock ? '\n' + journalBlock + '\n' : ''}
ORDER FLOW SIGNAL PERFORMANCE (by total PnL, top 10):
${sortByPnl(ofBuckets).map(([o, b]) => `  ${o}: ${b.count} trades · ${fmt(b.pnl)} · WR ${Math.round((b.wins / b.count) * 100)}%`).join('\n') || '  (no orderflow tags logged in window)'}

5M STRUCTURE ALIGNMENT:
${Array.from(structureBuckets.entries()).map(([k, b]) => `  ${k}: ${b.count} trades · ${fmt(b.pnl)} · WR ${Math.round((b.wins / b.count) * 100)}%`).join('\n') || '  (no structure_5m_alignment values yet — backfill pending)'}

RECENT TRADES (newest first, terse format, capped at ${recentTradesLimit}):
${recent}
${coachingThread ? '\n' + coachingThread + '\n' : ''}
═══ END TRADER DATA ═══`
}
