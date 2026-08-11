import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { weekStartFor, weekLabel } from '@/lib/week-dates'
import { todayPT } from '@/lib/pt-time'
import { computeCarryover, type Carryover } from '@/lib/prep-carryover'
import type { TradeWithExcursion } from '@/lib/analytics'
import {
  loadPeriodDays, loadPeriodTrades, summarizePeriod, summarizeCommitments, comparisonRows,
  monthRange, previousMonth, nextMonth, monthLabel,
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

  const [days, prevDays, recapResult] = await Promise.all([
    loadPeriodDays(supabase, start, end),
    loadPeriodDays(supabase, prevRange.start, prevRange.end),
    supabase
      .from('monthly_recap')
      .select('ai_synthesis_json, notes_md, generated_at')
      .eq('month_start_date', start)
      .maybeSingle() as Promise<{ data: { ai_synthesis_json: AiSynthesis | null; notes_md: string | null } | null; error: { code?: string } | null }>,
  ])

  const summary = summarizePeriod(days)
  const prevSummary = summarizePeriod(prevDays)

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
      }}
      commitment={commitment}
      ledger={{ title: 'The weeks', hint: 'each row opens that week’s recap', rows: ledgerRows }}
      vs={vs}
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
