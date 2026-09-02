import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { format, parseISO } from 'date-fns'
import { weekTradingDays, weekEnd, weekLabel, weekStartFor, previousWeekStart, nextWeekStart } from '@/lib/week-dates'
import { todayPT } from '@/lib/pt-time'
import { displayDayTypes } from '@/lib/day-type-display'
import { computeCarryover, type Carryover } from '@/lib/prep-carryover'
import { rMultiple, captureRatio, type TradeWithExcursion } from '@/lib/analytics'
import { resolveScreenshotUrls } from '@/lib/storage-url'
import type { FilmFrame } from '@/components/review/GameFilm'
import type { TradeReview } from '@/lib/supabase/types'
import {
  loadPeriodDays, loadPeriodTrades, summarizePeriod, summarizeCommitments, comparisonRows,
  periodVsBaseline, driverSentence, type BaselineRead, type PeriodDay, type PeriodSummary,
} from '@/lib/period-recap'
import PeriodRecapClient, {
  type RecapFinding, type RecapLedgerRow, type RecapCommitment, type AiSynthesis,
} from '@/components/review/PeriodRecapClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

interface PageProps {
  params: Promise<{ weekStart: string }>
}

/**
 * Review · Week — the weekly debrief (mockup: docs/tapescore-recap-mockup-r1.html).
 *
 * The week debriefs, the month rules: 10–20 trades rarely clears the finding
 * engine's bar, so when it doesn't, the hero states process FACTS (rails,
 * capture, the tracked commitment) instead of manufacturing a lesson. When a
 * week IS loud enough for the engine, the finding leads exactly as it does on
 * the Dashboard.
 */
export default async function WeeklyRecapPage({ params }: PageProps) {
  const { weekStart: rawWeekStart } = await params
  const canonical = weekStartFor(rawWeekStart)
  if (canonical !== rawWeekStart) redirect(`/review/week/${canonical}`)
  const weekStart = canonical

  const supabase: AnyClient = await createClient()
  const endDate = weekEnd(weekStart)
  const prevStart = previousWeekStart(weekStart)

  // This week + prior week rollups (prior feeds the comparison strip), plus
  // the saved recap row — all independent.
  const [days, prevDays, recapResult] = await Promise.all([
    loadPeriodDays(supabase, weekStart, endDate),
    loadPeriodDays(supabase, prevStart, weekEnd(prevStart)),
    supabase
      .from('weekly_recap')
      .select('ai_synthesis_json, notes_md, generated_at')
      .eq('week_start_date', weekStart)
      .maybeSingle() as Promise<{ data: { ai_synthesis_json: AiSynthesis | null; notes_md: string | null } | null; error: { code?: string } | null }>,
  ])

  const summary = summarizePeriod(days)
  const prevSummary = summarizePeriod(prevDays)

  // The finding engine runs on the week's trades; a quiet week returns null
  // and the hero falls back to process facts.
  const tradedDayIds = days.filter(d => d.rollup.trade_count > 0).map(d => d.rollup.id)
  const trades = await loadPeriodTrades(supabase, tradedDayIds)
  const carryover = computeCarryover(trades as unknown as TradeWithExcursion[], `week of ${weekLabel(weekStart)}`)

  // The week is read against the trader's OWN history, not against itself:
  // 14 trades can't support a within-week split, but the baseline arm has
  // hundreds. Trailing 400 with the day types each trade was taken on.
  const dayTypesById = new Map(days.map(d => [d.rollup.id, d.rollup.day_types]))
  const { data: bookRaw } = await supabase
    .from('trades')
    .select('id, trading_day_id, pnl, entry_price, stop_price, quantity, direction, entry_time, tags_json, symbol')
    .order('entry_time', { ascending: false })
    .limit(400) as { data: Array<Record<string, unknown>> | null }
  const bookDayIds = Array.from(new Set((bookRaw ?? []).map(t => t.trading_day_id as string).filter(Boolean)))
  const { data: bookDays } = await supabase
    .from('trading_days').select('id, day_types').in('id', bookDayIds) as { data: Array<{ id: string; day_types: string[] | null }> | null }
  const bookTypes = new Map((bookDays ?? []).map(d => [d.id, Array.isArray(d.day_types) ? d.day_types : []]))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const book = (bookRaw ?? []).map(t => ({ ...t, _dayTypes: bookTypes.get(t.trading_day_id as string) ?? [] })) as any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const weekTrades = (trades as any[]).map(t => ({ ...t, _dayTypes: dayTypesById.get(t.trading_day_id) ?? [] }))
  const baselineRead = periodVsBaseline(weekTrades, book, t => [
    ...(((t.tags_json as { setups?: string[] } | null)?.setups) ?? []).map(label => ({ kind: 'setup' as const, label })),
    ...((t._dayTypes as string[] | undefined) ?? []).map(label => ({ kind: 'day type' as const, label })),
  ])

  const finding = weeklyFinding(carryover, summary, baselineRead)
  const commitment = weeklyCommitment(days)

  // Sessions ledger — all five weekdays, empty ones included but quiet.
  const byDate = new Map(days.map(d => [d.rollup.date, d]))
  const ledgerRows: RecapLedgerRow[] = weekTradingDays(weekStart).map(date => {
    const d = byDate.get(date)
    const r = d?.rollup
    const traded = (r?.trade_count ?? 0) > 0
    const hasResult = traded || r?.eod_pnl != null
    return {
      href: hasResult ? `/review/today/${date}` : null,
      label: format(parseISO(date), 'EEE'),
      sub: format(parseISO(date), 'MMM d'),
      read: r && r.day_types.length > 0 ? displayDayTypes(r.day_types) : null,
      trades: r?.trade_count ?? 0,
      capture: r?.avg_capture != null && traded ? Math.round(r.avg_capture * 100) : null,
      rails: r?.process_verdict === 'Compliant' ? 'Kept' : r?.process_verdict === 'Breach' ? 'Breach' : null,
      railsTone: r?.process_verdict === 'Compliant' ? 'pos' : r?.process_verdict === 'Breach' ? 'neg' : null,
      score: r?.tapescore?.score ?? null,
      pnl: r?.eod_pnl ?? null,
      empty: !hasResult,
    }
  })

  const vs = comparisonRows(prevSummary, summary, 'week')

  // Game film — every screenshot this week, in entry order, signed once.
  const film = await buildFilm(supabase, days, tradedDayIds)

  // Pager: never forward past the current week.
  const currentWeek = weekStartFor(todayPT())
  const next = nextWeekStart(weekStart)
  const recap = recapResult.error ? null : recapResult.data
  const migrationPending = recapResult.error?.code === 'PGRST205' || recapResult.error?.code === '42P01'

  return (
    <PeriodRecapClient
      scope="week"
      periodKey={weekStart}
      eyebrow={`review · week of ${weekLabel(weekStart).toLowerCase()} · ${summary.trades} trade${summary.trades === 1 ? '' : 's'} · ${summary.tradedDays} session${summary.tradedDays === 1 ? '' : 's'}`}
      pager={{
        prevHref: `/review/week/${prevStart}`,
        prevLabel: weekLabel(prevStart),
        nextHref: next <= currentWeek ? `/review/week/${next}` : null,
        nextLabel: next <= currentWeek ? weekLabel(next) : null,
      }}
      scorePeriod={summary.score}
      scoreLabel="this week"
      finding={finding}
      numbers={{
        pnl: summary.pnl,
        trades: summary.trades,
        dayWins: summary.dayWins,
        tradedDays: summary.tradedDays,
        capture: summary.capture,
        mfeMae: summary.mfeMae,
        railsKept: summary.railsKept,
        railsDays: summary.railsDays,
        winRate: summary.winRate,
        avgR: summary.avgR,
        rSample: summary.rSample,
        dollarsPerTrade: summary.dollarsPerTrade,
      }}
      commitment={commitment}
      ledger={{ title: 'The sessions', hint: 'each row opens that day’s review', rows: ledgerRows }}
      vs={vs}
      initialSynthesis={recap?.ai_synthesis_json ?? null}
      initialNotes={recap?.notes_md ?? ''}
      migrationPending={!!migrationPending}
      film={film}
    />
  )
}

/** tags_json → the display groups Game film shows over a zoomed screenshot.
 *  Same categories and same order the shared session and the trade table use,
 *  so one trade reads identically wherever you meet it. Mistakes carry `danger`
 *  because they are the one group you want to see before the others. */
const FILM_TAG_CATS: Array<{ key: string; label: string; danger?: boolean }> = [
  { key: 'setups', label: 'Setup' },
  { key: 'confluences', label: 'Confluence' },
  { key: 'order_flow', label: 'Order flow' },
  { key: 'entry_model', label: 'Entry' },
  { key: 'trade_management', label: 'Management' },
  { key: 'emotions', label: 'Emotion' },
  { key: 'mistakes', label: 'Mistake', danger: true },
]
function filmTags(tags: unknown): FilmFrame['tags'] {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return []
  const t = tags as Record<string, unknown>
  return FILM_TAG_CATS
    .map(c => ({
      label: c.label,
      danger: c.danger,
      items: Array.isArray(t[c.key]) ? (t[c.key] as unknown[]).filter((v): v is string => typeof v === 'string' && v !== '') : [],
    }))
    .filter(g => g.items.length > 0)
}
/** The week's screenshot catalog. One query for the week's trades (lean
 *  fields + review_json), one batched sign for the storage URLs. Trades
 *  without a screenshot are counted, not shown. */

async function buildFilm(
  supabase: AnyClient,
  days: PeriodDay[],
  tradedDayIds: string[],
): Promise<{ frames: FilmFrame[]; missing: number; migrationPending: boolean }> {
  if (tradedDayIds.length === 0) return { frames: [], missing: 0, migrationPending: false }

  interface Row {
    id: string
    trading_day_id: string
    entry_time: string | null
    entry_price: number | null
    stop_price: number | null
    quantity: number | null
    direction: 'long' | 'short' | null
    pnl: number | null
    symbol: string | null
    high_during_position: number | null
    low_during_position: number | null
    tags_json: { setups?: string[] } | null
    screenshot_url: string | null
    review_json?: TradeReview | null
  }
  const SELECT_BASE = 'id, trading_day_id, entry_time, entry_price, stop_price, quantity, direction, pnl, symbol, high_during_position, low_during_position, tags_json, screenshot_url'

  // review_json may not exist yet (pre-migration) — that query errors with
  // 42703; fall back to the same select without it and flag the gap.
  let rows: Row[] = []
  let migrationPending = false
  {
    const first = await supabase
      .from('trades')
      .select(`${SELECT_BASE}, review_json`)
      .in('trading_day_id', tradedDayIds)
      .order('entry_time', { ascending: true }) as { data: Row[] | null; error: { code?: string } | null }
    if (first.error) {
      migrationPending = true
      const second = await supabase
        .from('trades')
        .select(SELECT_BASE)
        .in('trading_day_id', tradedDayIds)
        .order('entry_time', { ascending: true }) as { data: Row[] | null }
      rows = second.data ?? []
    } else {
      rows = first.data ?? []
    }
  }

  const withShot = rows.filter(r => !!r.screenshot_url)
  const missing = rows.length - withShot.length
  if (withShot.length === 0) return { frames: [], missing, migrationPending }

  const signed = await resolveScreenshotUrls(supabase, withShot.map(r => r.screenshot_url))
  const dayById = new Map(days.map(d => [d.rollup.id, d.rollup]))

  const frames: FilmFrame[] = []
  withShot.forEach((r, i) => {
    const src = signed[i]
    if (!src) return
    const day = dayById.get(r.trading_day_id)
    const date = day?.date ?? null
    const entry = r.entry_time ? new Date(r.entry_time) : null
    const cap = captureRatio(r as unknown as TradeWithExcursion)
    frames.push({
      tradeId: r.id,
      src,
      day: date ? format(parseISO(date), 'EEE MMM d') : '',
      time: entry
        ? entry.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false }) + ' PT'
        : '',
      href: date ? `/review/today/${date}` : '#',
      symbol: r.symbol,
      direction: r.direction,
      pnl: r.pnl,
      r: rMultiple(r as unknown as TradeWithExcursion),
      capture: cap != null ? Math.round(cap * 100) : null,
      setups: Array.isArray(r.tags_json?.setups) ? r.tags_json!.setups!.filter(Boolean) : [],
      tags: filmTags(r.tags_json),
      read: day && day.day_types.length > 0 ? displayDayTypes(day.day_types) : null,
      verdict: r.review_json?.verdict ?? null,
    })
  })
  return { frames, missing, migrationPending }
}

/** Weekly hero: the engine's finding when it clears, otherwise honest process
 *  facts — never an invented lesson. */
function weeklyFinding(carryover: Carryover | null, s: PeriodSummary, baseline: BaselineRead | null): RecapFinding {
  if (carryover) {
    return {
      state: carryover.mode === 'protect' ? 'edge' : 'leak',
      headline: `${carryover.finding}.`,
      sub: `${carryover.metric}.`,
      next: carryover.today,
      evidence: carryover.evidence,
    }
  }
  if (s.tradedDays === 0) {
    return {
      state: 'none',
      headline: 'No trades this week.',
      sub: 'Nothing to review — a flat week is a valid week.',
      next: 'Nothing to force. Take the A setups when they come.',
      evidence: [],
    }
  }
  if (s.tradedDays <= 2 || s.trades < 8) {
    return {
      state: 'none',
      headline: `${s.tradedDays === 1 ? 'One session' : `${s.tradedDays} sessions`}, ${s.trades} trade${s.trades === 1 ? '' : 's'}.`,
      sub: 'Not enough tape to read. Nothing here needs a lesson — manufacturing one would be the mistake.',
      next: 'Nothing to force. Take the A setups when they come.',
      evidence: [],
    }
  }
  const capturePart = s.capture != null ? ` You kept ${s.capture}% of what your winners offered.` : ''
  // A short week can't be split against itself, but it CAN be read against the
  // trader's own history — where the comparison arm has hundreds of trades.
  // Saying "too few trades" instead reads as a reprimand for being selective.
  const vsBaseline = baseline ? baselineSentence(baseline) : ''
  if (s.railsDays > 0 && s.railsKept === s.railsDays) {
    return {
      state: 'held',
      headline: `Every rail kept, ${s.railsDays === 1 ? 'the one graded day' : `all ${s.railsDays} graded days`}.`,
      sub: `${s.trades} trades across ${s.tradedDays} sessions, clean on the rails you track.${capturePart}${vsBaseline}`,
      next: baseline ? driverAction(baseline) : 'Nothing to fix — protect the process that made this week.',
      evidence: baseline ? baselineBars(baseline) : [],
    }
  }
  const railsPart = s.railsDays > 0 ? `Rails held on ${s.railsKept} of ${s.railsDays} graded days.` : 'No sessions were graded against your rails.'
  if (baseline) {
    return {
      state: baseline.periodR >= baseline.baselineR ? 'edge' : 'leak',
      headline: `${baseline.label} ${baseline.periodR >= baseline.baselineR ? 'ran above' : 'ran below'} your usual.`,
      sub: `${fmtR(baseline.periodR)} per trade across ${baseline.periodN} this week against ${fmtR(baseline.baselineR)} per trade over your last ${baseline.baselineN}. ${driverSentence(baseline)} ${railsPart}${capturePart}`,
      next: driverAction(baseline),
      evidence: baselineBars(baseline),
    }
  }
  return {
    state: 'none',
    headline: 'Nothing separated itself.',
    sub: `${s.trades} trades across ${s.tradedDays} sessions — nothing this week diverged from how you normally trade. ${railsPart}${capturePart}`,
    next: 'No change to force — keep taking your A setups and let the sample build.',
    evidence: [],
  }
}

const fmtR = (r: number) => `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(1)}R`

/** " Break And Retest ran +1.7R per trade across 4 this week — your usual on
 *  that setup is +0.3R per trade over 46."
 *
 *  "per trade" is not padding. These are expectancy figures over ALL trades,
 *  winners and losers, and without the qualifier a healthy +0.3R expectancy
 *  reads as a feeble 0.3R trade — the founder read it exactly that way. On this
 *  book +0.34R across 46 is 19 winners at +2.1R carrying 27 losers at -0.9R. */
function baselineSentence(b: BaselineRead): string {
  return ` ${b.label} ran ${fmtR(b.periodR)} per trade across ${b.periodN} this week — your usual on that ${b.kind} is ${fmtR(b.baselineR)} per trade over ${b.baselineN}. ${driverSentence(b)}`
}

/** What to do about it depends on WHICH component moved — holding winners
 *  longer and winning more often call for opposite responses, and a thin-sample
 *  win-rate swing calls for none at all. */
function driverAction(b: BaselineRead): string {
  const better = b.driver.contribution >= 0
  switch (b.driver.kind) {
    case 'payoff':
      return better
        ? `You held ${b.label} winners further than usual — that is the habit to keep.`
        : `Your ${b.label} winners were cut shorter than usual — hold to the plan before taking anything off.`
    case 'losses':
      return better
        ? `Your losers were smaller than usual — whatever you did on the exits, keep it.`
        : `Your losers ran further than usual — the stop is where to look, not the entry.`
    case 'win rate':
      return b.thin
        ? `Nothing to change on ${b.periodN} trades — let the sample build before reading anything into it.`
        : better
          ? `You are picking ${b.label} better than usual — keep the filter that got you here.`
          : `You are picking ${b.label} worse than usual — tighten what qualifies before the next one.`
  }
}

function baselineBars(b: BaselineRead) {
  const span = Math.max(Math.abs(b.periodR), Math.abs(b.baselineR), 0.5)
  const bar = (label: string, r: number, n: number, winRate: number | null) => ({
    label,
    value: fmtR(r),
    n,
    pct: Math.round((Math.abs(r) / span) * 100),
    tone: (r >= 0 ? 'pos' : 'neg') as 'pos' | 'neg',
    winRate,
  })
  return [
    bar(`${b.label} — this week`, b.periodR, b.periodN, b.periodWinRate),
    bar(`${b.label} — your usual`, b.baselineR, b.baselineN, b.baselineWinRate),
  ]
}

function weeklyCommitment(days: PeriodDay[]): RecapCommitment | null {
  const report = summarizeCommitments(days)
  if (!report || !report.top) return null
  const mode = days.find(d => d.commitment)?.commitment?.mode ?? 'correct'
  const pips = report.days.map(d => ({
    label: format(parseISO(d.date), 'EEE'),
    state: d.state,
  }))
  const parts: string[] = []
  if (report.held > 0) parts.push(`held it ${report.held} of ${report.tracked} tracked day${report.tracked === 1 ? '' : 's'}`)
  else parts.push(`tracked ${report.tracked} day${report.tracked === 1 ? '' : 's'}`)
  if (report.broke > 0) parts.push(`slipped ${report.broke}`)
  if (report.unresolved > 0) parts.push(`${report.unresolved} not resolved yet — close ${report.unresolved === 1 ? 'it' : 'them'} in Review · Today`)
  return {
    mode,
    text: report.top.text,
    days: pips,
    summary: parts.join(' · ').replace(/^./, c => c.toUpperCase()) + '.',
  }
}
