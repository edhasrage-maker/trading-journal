import { createClient } from '@/lib/supabase/server'
import { computeStats, type TradeWithExcursion } from '@/lib/analytics'
import { computeCarryover } from '@/lib/prep-carryover'
import type { Trade } from '@/lib/supabase/types'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Review · All time — the longest window, and the only one with enough sample
 * to say something durable.
 *
 * It runs the SAME finding engine the Prep bridge uses, just over every trade
 * instead of a month. Same discipline applies: if nothing separates itself at a
 * defensible sample size, it says so rather than manufacturing a lesson.
 */
export default async function ReviewAllTimePage() {
  const supabase = await createClient()

  // Page through the whole book — Supabase caps a select at 1000 rows.
  const trades: Trade[] = []
  for (let page = 0; page < 100; page++) {
    const { data, error } = await supabase
      .from('trades')
      .select('*')
      .order('entry_time', { ascending: true })
      .range(page * 1000, page * 1000 + 999)
    if (error) break
    const rows = (data ?? []) as Trade[]
    trades.push(...rows)
    if (rows.length < 1000) break
  }

  const stats = computeStats(trades)
  const finding = computeCarryover(trades as TradeWithExcursion[], 'whole record')

  const money = (n: number) =>
    `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`

  const ledger: Array<{ label: string; value: string; tone?: string }> = [
    { label: 'Trades', value: stats.count.toLocaleString('en-US') },
    { label: 'Net P&L', value: money(stats.total_pnl), tone: stats.total_pnl >= 0 ? 'text-green-400' : 'text-red-400' },
    { label: 'Win rate', value: `${Math.round(stats.win_rate * 100)}%` },
    { label: 'Average R', value: stats.avg_r != null ? `${stats.avg_r >= 0 ? '+' : '−'}${Math.abs(stats.avg_r).toFixed(2)}R` : '—' },
    { label: 'Profit factor', value: Number.isFinite(stats.profit_factor) ? stats.profit_factor.toFixed(2) : '—' },
    { label: 'Move captured', value: stats.avg_capture != null ? `${Math.round(stats.avg_capture * 100)}%` : '—' },
  ]

  if (stats.count === 0) {
    return (
      <p className="text-sm text-gray-400 max-w-[62ch] leading-normal">
        Nothing logged yet. Once you import or record trades, this view holds the read across your
        whole record — the one window with enough sample to say something durable.
      </p>
    )
  }

  return (
    <div>
      <div className="font-mono text-[11.5px] tracking-wide text-gray-500 mb-3">ALL TIME</div>

      {finding ? (
        <>
          <div
            className={`text-[12.5px] font-semibold mb-2.5 ${finding.mode === 'protect' ? 'text-green-400' : 'text-blue-400'}`}
          >
            {finding.mode === 'protect' ? 'Clear edge' : 'Clear leak'}
          </div>
          <h1
            className="text-[clamp(24px,3.2vw,32px)] font-bold leading-[1.08] tracking-[-0.025em] text-gray-100 text-balance max-w-[24ch]"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {finding.finding}.
          </h1>
          <p className="mt-3.5 text-[15px] text-gray-100 max-w-[56ch] leading-normal">
            {finding.metric}.
          </p>
        </>
      ) : (
        <>
          <div className="text-[12.5px] font-semibold text-gray-500 mb-2.5">No clear read</div>
          <h1
            className="text-[clamp(24px,3.2vw,32px)] font-bold leading-[1.08] tracking-[-0.025em] text-gray-100 text-balance max-w-[24ch]"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Nothing has separated itself yet.
          </h1>
          <p className="mt-3.5 text-[15px] text-gray-400 max-w-[56ch] leading-normal">
            Across your whole record, no setup, tag or exit pattern clears a defensible sample.
            Not every record has a lesson in it — manufacturing one would be the mistake.
          </p>
        </>
      )}

      <section className="pt-6 mt-8 border-t border-gray-700">
        <h2
          className="text-base font-bold tracking-tight text-gray-100 mb-4"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          The numbers
        </h2>
        <div className="grid gap-x-10 md:grid-cols-2">
          {ledger.map(row => (
            <div
              key={row.label}
              className="grid grid-cols-[1fr_auto] gap-4 items-baseline py-2 border-t border-gray-800"
            >
              <span className="text-[13px] text-gray-400">{row.label}</span>
              <span
                className={`text-[17px] font-bold tabular-nums text-right ${row.tone ?? 'text-gray-100'}`}
                style={{ fontFamily: 'var(--font-display)' }}
              >
                {row.value}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
