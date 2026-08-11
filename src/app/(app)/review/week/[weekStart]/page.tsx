import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { format, parseISO } from 'date-fns'
import { weekTradingDays, weekEnd, weekLabel, weekStartFor, previousWeekStart, nextWeekStart } from '@/lib/week-dates'
import { todayPT } from '@/lib/pt-time'
import { displayDayTypes } from '@/lib/day-type-display'
import { computeCarryover, type Carryover } from '@/lib/prep-carryover'
import type { TradeWithExcursion } from '@/lib/analytics'
import {
  loadPeriodDays, loadPeriodTrades, summarizePeriod, summarizeCommitments, comparisonRows,
  type PeriodDay, type PeriodSummary,
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

  const finding = weeklyFinding(carryover, summary)
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
      }}
      commitment={commitment}
      ledger={{ title: 'The sessions', hint: 'each row opens that day’s review', rows: ledgerRows }}
      vs={vs}
      initialSynthesis={recap?.ai_synthesis_json ?? null}
      initialNotes={recap?.notes_md ?? ''}
      migrationPending={!!migrationPending}
    />
  )
}

/** Weekly hero: the engine's finding when it clears, otherwise honest process
 *  facts — never an invented lesson. */
function weeklyFinding(carryover: Carryover | null, s: PeriodSummary): RecapFinding {
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
  if (s.railsDays > 0 && s.railsKept === s.railsDays) {
    return {
      state: 'held',
      headline: `Every rail kept, ${s.railsDays === 1 ? 'the one graded day' : `all ${s.railsDays} graded days`}.`,
      sub: `${s.trades} trades across ${s.tradedDays} sessions, clean on the rails you track.${capturePart} Too few trades to call a setup edge or leak — that read builds at the month.`,
      next: 'Nothing to fix — protect the process that made this week.',
      evidence: [],
    }
  }
  const railsPart = s.railsDays > 0 ? `Rails held on ${s.railsKept} of ${s.railsDays} graded days.` : 'No sessions were graded against your rails.'
  return {
    state: 'none',
    headline: 'Nothing separated itself.',
    sub: `${s.trades} trades across ${s.tradedDays} sessions — no setup or behaviour stood out at this sample size. ${railsPart}${capturePart}`,
    next: 'No change to force — keep taking your A setups and let the sample build.',
    evidence: [],
  }
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
