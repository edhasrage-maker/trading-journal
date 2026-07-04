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
  direction: 'long' | 'short' | null
  pnl: number | null
  entry_price: number | null
  stop_price: number | null
  high_during_position: number | null  // tick-precise high while in trade — long MFE source
  low_during_position: number | null   // tick-precise low while in trade — short MFE source
  mfe_dollars_per_leg: number | null   // scaling-aware best-case $ (peak per leg) — primary capture basis
  quantity: number | null
  symbol: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tags_json: any
  structure_5m_alignment: string | null
}

export async function buildCoachContext(supabase: AnyClient, opts: CoachContextOptions): Promise<string> {
  const { startDate, endDate, windowLabel, includeWeekOverWeek = false, recentTradesLimit = 50 } = opts

  // Pull trading_days first so we have the day-type map for cross-tabulation.
  const { data: days } = await supabase
    .from('trading_days')
    .select('id, date, day_types, eod_pnl')
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: false })
  const dayDateById = new Map<string, string>()
  const dayTypesById = new Map<string, string[]>()
  for (const d of (days ?? []) as Array<{ id: string; date: string; day_types: string[] | null }>) {
    dayDateById.set(d.id, d.date)
    dayTypesById.set(d.id, Array.isArray(d.day_types) ? d.day_types : [])
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
      .select('id, trading_day_id, entry_time, direction, pnl, entry_price, stop_price, high_during_position, low_during_position, mfe_dollars_per_leg, quantity, symbol, tags_json, structure_5m_alignment')
      .in('trading_day_id', dayIds)
      .order('entry_time', { ascending: false })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (!data || data.length === 0) break
    trades.push(...data)
    if (data.length < PAGE) break
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
  const derived = new Map<string, { r: number | null; mfeR: number | null; capPct: number | null; maePct: number | null }>()

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

  for (const t of trades) {
    const pnl = t.pnl ?? 0
    // All per-trade MFE/MAE interpretation lives in the shared helper so the
    // coach, the weekly recap, and the video-recap commentary can't drift.
    const { isWin, r, mfeUsd, capPct, leftUsd, mfeR, maePts, maePct } = interpretExcursion(t)

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

    derived.set(t.id, { r, mfeR, capPct, maePct })

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
    return `${date} ${dir}${t.quantity ?? '?'} pnl=${t.pnl?.toFixed(0) ?? '?'}${r != null ? ` R=${r.toFixed(2)}` : ''}${mfeR != null ? ` mfeR=${mfeR.toFixed(2)}` : ''}${cap != null ? ` cap=${Math.round(cap * 100)}%` : ''}${mae != null ? ` mae=${Math.round(mae * 100)}%` : ''} setup=[${setups}]${mistakes !== '—' ? ' mistake=['+mistakes+']' : ''}${t.structure_5m_alignment ? ' 5m='+t.structure_5m_alignment : ''}`
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
  const exitEffBlock = (dl.n === 0 && rb.withStop === 0)
    ? '  (no MFE data on trades in this window)'
    : `  WINNERS scored ($ basis, no stop needed): ${dl.n} of ${winners} winners
  Captured ${pct(dl.sumCapPct, dl.n)}% of the available favorable move on avg · left ${dl.n > 0 ? usd(dl.sumLeft / dl.n) : '—'}/win on the table (avg realized ${dl.n > 0 ? usd(dl.sumRealized / dl.n) : '—'} vs avg peak ${dl.n > 0 ? usd(dl.sumMfe / dl.n) : '—'})
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
  Winners: avg heat ${avgPts(maeAgg.win)} pts (${avgPctOf(maeAgg.win)} of planned stop) across ${maeAgg.win.n} wins
  Losers:  avg heat ${avgPts(maeAgg.loss)} pts (${avgPctOf(maeAgg.loss)} of planned stop) across ${maeAgg.loss.n} losses
  WIN RATE BY HEAT TAKEN (share of the planned stop distance price used before the trade resolved):
${MAE_BUCKETS.map(([label]) => {
    const b = maeBuckets.get(label)
    if (!b) return `    ${label}: 0 trades`
    const wr = (b.wins + b.losers) > 0 ? Math.round((b.wins / (b.wins + b.losers)) * 100) : 0
    const avgR = b.rs.length > 0 ? (b.rs.reduce((a, x) => a + x, 0) / b.rs.length).toFixed(2) : '—'
    return `    ${label}: ${b.count} trades · WR ${wr}% · avgR ${avgR} · ${fmt(b.pnl)}`
  }).join('\n')}`

  return `═══ TRADER DATA SUMMARY ═══
Window: ${windowLabel} (${startDate} → ${endDate}). Total trades: ${total}.

OVERALL:
  Win rate: ${winRate.toFixed(0)}% (${winners}W / ${losers}L)
  Total PnL: ${fmt(totalPnl)}
  Profit factor: ${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : '∞'}${weekOverWeekBlock}

MONTH-BY-MONTH (chronological — each month's trade count, PnL, win rate, profit factor):
${Array.from(monthBuckets.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([ym, b]) => {
    const wr = (b.wins + b.losers) > 0 ? Math.round((b.wins / (b.wins + b.losers)) * 100) : 0
    return `  ${ym}: ${b.count} trades · ${fmt(b.pnl)} · WR ${wr}%`
  }).join('\n') || '  (no trades in window)'}

EXIT EFFICIENCY — MFE CAPTURE (how much of the favorable move you keep; informs whether to hold for a TP2 / runner vs take TP1):
${exitEffBlock}

MAE — HEAT TAKEN (adverse excursion before the trade resolved; "planned" heat = your stop distance, "taken" = the actual move against you. Speaks to entry timing, stop sizing, and risk management — low heat on winners = clean entries; high heat that still won = nearly stopped out):
${maeBlock}

SETUP PERFORMANCE (by total PnL, top 10) — avgR realized; captured%/left$ = winners' $ MFE capture (TP2 headroom per setup):
${sortByPnl(setupBuckets).map(([s, b]) => {
    const avgR = b.rs.length > 0 ? (b.rs.reduce((a, r) => a + r, 0) / b.rs.length).toFixed(2) : '—'
    const avgCap = b.capPcts.length > 0 ? Math.round((b.capPcts.reduce((a, c) => a + c, 0) / b.capPcts.length) * 100) : null
    const avgLeft = b.lefts.length > 0 ? b.lefts.reduce((a, x) => a + x, 0) / b.lefts.length : null
    return `  ${s}: ${b.count} trades · ${fmt(b.pnl)} · WR ${Math.round((b.wins / (b.wins + b.losers || 1)) * 100)}% · avgR ${avgR}${avgCap != null ? ` · winners captured ${avgCap}%` : ''}${avgLeft != null ? ` · left ${usd(avgLeft)}/win` : ''}`
  }).join('\n')}

DAY TYPE PERFORMANCE (by total PnL, top 10):
${sortByPnl(dayTypeBuckets).map(([d, b]) => `  ${d}: ${b.count} trades · ${fmt(b.pnl)} · WR ${Math.round((b.wins / b.count) * 100)}%`).join('\n') || '  (no day_types tagged in window)'}

TOP MISTAKES (by frequency, top 10):
${sortByCount(mistakeCounts).map(([m, b]) => `  ${m}: ${b.count} occurrences · ${fmt(b.pnl)} total PnL impact`).join('\n') || '  (no mistakes tagged in window)'}

ORDER FLOW SIGNAL PERFORMANCE (by total PnL, top 10):
${sortByPnl(ofBuckets).map(([o, b]) => `  ${o}: ${b.count} trades · ${fmt(b.pnl)} · WR ${Math.round((b.wins / b.count) * 100)}%`).join('\n') || '  (no orderflow tags logged in window)'}

5M STRUCTURE ALIGNMENT:
${Array.from(structureBuckets.entries()).map(([k, b]) => `  ${k}: ${b.count} trades · ${fmt(b.pnl)} · WR ${Math.round((b.wins / b.count) * 100)}%`).join('\n') || '  (no structure_5m_alignment values yet — backfill pending)'}

RECENT TRADES (newest first, terse format, capped at ${recentTradesLimit}):
${recent}

═══ END TRADER DATA ═══`
}
