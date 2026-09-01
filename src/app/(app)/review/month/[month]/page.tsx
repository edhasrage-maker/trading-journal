import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { weekStartFor, weekLabel } from '@/lib/week-dates'
import { todayPT } from '@/lib/pt-time'
import { computeCarryover, type Carryover } from '@/lib/prep-carryover'
import type { TradeWithExcursion } from '@/lib/analytics'
import {
  loadPeriodDays, loadPeriodTrades, summarizePeriod, summarizeCommitments, comparisonRows,
  monthRange, previousMonth, nextMonth, monthLabel, quarterRead,
  type PeriodDay, type PeriodSummary, type QuarterRead,
} from '@/lib/period-recap'
import PeriodRecapClient, {
  type RecapFinding, type RecapLedgerRow, type RecapCommitment, type AiSynthesis,
} from '@/components/review/PeriodRecapClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

interface PageProps {
  params: Promise<{ month: string }>
}

/**
 * Review · Month — the monthly debrief (mockup: docs/tapescore-recap-mockup-r1.html).
 *
 * Finding-first at full strength: a month is 60+ trades, enough for the same
 * engine that powers the Dashboard read — but scoped to ONE calendar month the
 * trader can page through. The Dashboard keeps the running windows; this is
 * the period's closed book: finding, numbers, the five weeks, the commitments,
 * the coach's read, the trader's own notes.
 */
export default async function MonthlyRecapPage({ params }: PageProps) {
  const { month: rawMonth } = await params
  if (!/^\d{4}-\d{2}$/.test(rawMonth)) redirect(`/review/month/${todayPT().slice(0, 7)}`)
  const month = rawMonth
  const currentMonth = todayPT().slice(0, 7)
  if (month > currentMonth) redirect(`/review/month/${currentMonth}`)

  const supabase: AnyClient = await createClient()
  const { start, end } = monthRange(month)
  const prevM = previousMonth(month)
  const prevRange = monthRange(prevM)
  // Two months back as well: with only one prior month a dip reads as decline,
  // and the direction of travel is what makes the comparison worth reading.
  const prev2M = previousMonth(prevM)
  const prev2Range = monthRange(prev2M)

  const [days, prevDays, prev2Days, recapResult] = await Promise.all([
    loadPeriodDays(supabase, start, end),
    loadPeriodDays(supabase, prevRange.start, prevRange.end),
    loadPeriodDays(supabase, prev2Range.start, prev2Range.end),
    supabase
      .from('monthly_recap')
      .select('ai_synthesis_json, notes_md, generated_at')
      .eq('month_start_date', start)
      .maybeSingle() as Promise<{ data: { ai_synthesis_json: AiSynthesis | null; notes_md: string | null } | null; error: { code?: string } | null }>,
  ])

  const summary = summarizePeriod(days)
  const prevSummary = summarizePeriod(prevDays)
  const prev2Summary = summarizePeriod(prev2Days)
  const quarter = buildQuarter(
    [
      { label: monthLabel(prev2M).split(' ')[0], summary: prev2Summary },
      { label: monthLabel(prevM).split(' ')[0], summary: prevSummary },
      { label: monthLabel(month).split(' ')[0], summary },
    ],
  )

  const tradedDayIds = days.filter(d => d.rollup.trade_count > 0).map(d => d.rollup.id)
  const trades = await loadPeriodTrades(supabase, tradedDayIds)
  const label = monthLabel(month)
  const carryover = computeCarryover(trades as unknown as TradeWithExcursion[], `${label.split(' ')[0]} review`)

  const finding = monthlyFinding(carryover, summary, month === currentMonth)
  const commitment = monthlyCommitment(days)

  // Weeks ledger — the month's days grouped by their trading week; each row
  // opens that week's recap.
  const byWeek = new Map<string, PeriodDay[]>()
  for (const d of days) {
    const ws = weekStartFor(d.rollup.date)
    const arr = byWeek.get(ws) ?? []
    arr.push(d)
    byWeek.set(ws, arr)
  }
  const ledgerRows: RecapLedgerRow[] = Array.from(byWeek.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ws, weekDays]) => {
      const w = summarizePeriod(weekDays)
      const partial = weekDays.length < 5 && w.tradedDays < weekDays.length
      return {
        href: `/review/week/${ws}`,
        label: weekLabel(ws),
        sub: partial && weekDays.length < 4 ? 'partial' : null,
        read: null,
        trades: w.trades,
        capture: w.capture,
        rails: w.railsDays > 0 ? `${w.railsKept} of ${w.railsDays} days` : null,
        railsTone: w.railsDays > 0 ? (w.railsKept === w.railsDays ? 'pos' : w.railsKept < w.railsDays - 1 ? 'neg' : null) : null,
        score: w.score.score,
        pnl: w.pnl,
        empty: w.tradedDays === 0,
      }
    })

  const vs = comparisonRows(prevSummary, summary, 'month')
  const next = nextMonth(month)
  const recap = recapResult.error ? null : recapResult.data
  const migrationPending = recapResult.error?.code === 'PGRST205' || recapResult.error?.code === '42P01'

  return (
    <PeriodRecapClient
      scope="month"
      periodKey={month}
      eyebrow={`review · ${label.toLowerCase()} · ${summary.trades} trade${summary.trades === 1 ? '' : 's'} · ${summary.tradedDays} session${summary.tradedDays === 1 ? '' : 's'}`}
      pager={{
        prevHref: `/review/month/${prevM}`,
        prevLabel: monthLabel(prevM).split(' ')[0],
        nextHref: next <= currentMonth ? `/review/month/${next}` : null,
        nextLabel: next <= currentMonth ? monthLabel(next).split(' ')[0] : null,
      }}
      scorePeriod={summary.score}
      scoreLabel={label.split(' ')[0]}
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
      ledger={{ title: 'The weeks', hint: 'each row opens that week’s recap', rows: ledgerRows }}
      vs={vs}
      quarter={quarter}
      initialSynthesis={recap?.ai_synthesis_json ?? null}
      initialNotes={recap?.notes_md ?? ''}
      migrationPending={!!migrationPending}
    />
  )
}

function monthlyFinding(carryover: Carryover | null, s: PeriodSummary, isCurrentMonth: boolean): RecapFinding {
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
      headline: isCurrentMonth ? 'No trades yet this month.' : 'No trades this month.',
      sub: 'Nothing to review.',
      next: 'Nothing to force. Take the A setups when they come.',
      evidence: [],
    }
  }
  const railsPart = s.railsDays > 0 ? ` Rails held on ${s.railsKept} of ${s.railsDays} graded days.` : ''
  const capturePart = s.capture != null ? ` You kept ${s.capture}% of what your winners offered.` : ''
  return {
    state: 'none',
    headline: 'Nothing separated itself.',
    sub: `${s.trades} trades across ${s.tradedDays} sessions — no setup family or behaviour stood out from the rest of your book.${railsPart}${capturePart} Not every month has a lesson; manufacturing one would be the mistake.`,
    next: 'No change to force — keep taking your A setups and let the sample build.',
    evidence: [],
  }
}

function monthlyCommitment(days: PeriodDay[]): RecapCommitment | null {
  const report = summarizeCommitments(days)
  if (!report || !report.top) return null
  const mode = days.find(d => d.commitment)?.commitment?.mode ?? 'correct'
  const parts: string[] = [
    `Tracked on ${report.tracked} session${report.tracked === 1 ? '' : 's'}`,
  ]
  if (report.held > 0 || report.broke > 0) parts.push(`held on ${report.held}`)
  if (report.broke > 0) parts.push(`slipped ${report.broke}`)
  if (report.unresolved > 0) parts.push(`${report.unresolved} never resolved`)
  const topPart = report.top.tracked > 1
    ? ` Most carried: this one, ${report.top.tracked} sessions (held ${report.top.held}).`
    : ''
  return {
    mode,
    text: report.top.text,
    days: [],
    summary: parts.join(' · ') + '.' + topPart,
  }
}

/**
 * The three-month read. The headline is chosen from what actually moved rather
 * than from a template: a P&L fall that tracks a fall in risk per trade is
 * de-risking and says so, because reporting only the P&L half of that would
 * read as a verdict on the trading.
 */
function buildQuarter(
  periods: Array<{ label: string; summary: PeriodSummary }>,
): { title: string; headline: string; read: QuarterRead } | null {
  const read = quarterRead(periods)
  if (!read) return null

  const live = periods.filter(p => p.summary.trades > 0)
  const first = live[0].summary
  const last = live[live.length - 1].summary
  const span = `${live[0].label}–${live[live.length - 1].label}`

  const riskChange =
    first.avgRisk != null && last.avgRisk != null && first.avgRisk > 0
      ? Math.round(((last.avgRisk - first.avgRisk) / first.avgRisk) * 100)
      : null
  const pnlChange = first.pnl !== 0 ? Math.round(((last.pnl - first.pnl) / Math.abs(first.pnl)) * 100) : null

  let headline: string
  if (riskChange != null && riskChange <= -10 && pnlChange != null && pnlChange < 0) {
    headline = `Your risk per trade fell ${Math.abs(riskChange)}%. The P&L fell with it — the trading did not.`
  } else if (riskChange != null && riskChange <= -10) {
    headline = `You cut risk per trade ${Math.abs(riskChange)}% and held the result.`
  } else if (last.avgR != null && first.avgR != null && last.avgR > first.avgR) {
    headline = 'You are earning more per unit of risk than you were.'
  } else if (last.avgR != null && first.avgR != null && last.avgR < first.avgR) {
    headline = 'You are earning less per unit of risk than you were.'
  } else {
    headline = 'The measures held broadly steady across the period.'
  }

  return { title: `The quarter, month by month · ${span}`, headline, read }
}
