'use client'

import { useMemo, useState } from 'react'
import { format, parseISO, startOfWeek, startOfMonth } from 'date-fns'
import { ChevronDown, ChevronUp, ArrowRight } from 'lucide-react'
import type { TradeWithContext } from '@/lib/analytics'

/**
 * Week-by-week and month-by-month comparison table.
 *
 * Toggle between two granularities (Week / Month). For each bucket in the
 * analytics-page range, computes:
 *   - P&L            (sum of eod_pnl override, else trade pnl)
 *   - Trade Win %    (% of trades with pnl > 0 in the bucket)
 *   - Day Win %      (% of TRADED days where pnl > 0)
 *   - Median Process (median ai_analysis_json.score across days w/ prep)
 *   - Trade count
 *   - Day count
 *
 * Renders one row per bucket, newest first. Delta chips on each metric
 * show the difference vs. the next-older bucket so you can scan
 * trends at a glance — no chart needed.
 */

interface DayStat {
  date: string                    // YYYY-MM-DD
  eod_pnl: number | null
  process_score: number | null
}

interface Props {
  trades: TradeWithContext[]
  dayStats: DayStat[]
}

type Granularity = 'week' | 'month'

interface Bucket {
  /** Sortable key (week-start date or "YYYY-MM"). */
  key: string
  /** Human label rendered in the row ("Wk of Jun 1" / "Jun 2026"). */
  label: string
  pnl: number
  tradeWins: number
  tradesWithPnl: number
  tradeWinRate: number | null
  tradedDays: number
  winDays: number
  dayWinRate: number | null
  medianProcess: number | null
  procCount: number
  tradeCount: number
  dayCount: number
}

const GRAN_LABELS: Record<Granularity, string> = {
  week: 'Week-by-week',
  month: 'Month-by-month',
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m]
}

function bucketKey(dateStr: string, gran: Granularity): { key: string; label: string } {
  const d = parseISO(dateStr + 'T12:00:00')
  if (gran === 'week') {
    const start = startOfWeek(d, { weekStartsOn: 1 }) // Monday
    return {
      key: format(start, 'yyyy-MM-dd'),
      label: `Wk of ${format(start, 'MMM d')}`,
    }
  }
  const start = startOfMonth(d)
  return {
    key: format(start, 'yyyy-MM'),
    label: format(start, 'MMM yyyy'),
  }
}

function computeBuckets(
  trades: TradeWithContext[],
  dayStats: DayStat[],
  gran: Granularity,
): Bucket[] {
  // First pass: assign every trade + every day to its bucket key.
  type Acc = {
    label: string
    pnlFromOverride: number
    pnlFromTrades: number
    tradedDaysWithOverride: Set<string>
    tradeWins: number
    tradesWithPnl: number
    tradeCount: number
    dayCount: number
    winDays: number
    tradedDays: number
    procScores: number[]
    // Per-day pnl accumulator (sum of trade pnl). Used when eod_pnl is null.
    tradePnlByDate: Map<string, number>
    // Days seen for this bucket (any source: trades or dayStats).
    daysSeen: Set<string>
  }
  const acc = new Map<string, Acc>()

  const getAcc = (dateStr: string): Acc => {
    const { key, label } = bucketKey(dateStr, gran)
    let a = acc.get(key)
    if (!a) {
      a = {
        label,
        pnlFromOverride: 0,
        pnlFromTrades: 0,
        tradedDaysWithOverride: new Set(),
        tradeWins: 0,
        tradesWithPnl: 0,
        tradeCount: 0,
        dayCount: 0,
        winDays: 0,
        tradedDays: 0,
        procScores: [],
        tradePnlByDate: new Map(),
        daysSeen: new Set(),
      }
      acc.set(key, a)
    }
    return a
  }

  // Trades: contribute to trade-level metrics + accumulate per-date trade pnl.
  for (const t of trades) {
    if (!t.date) continue
    const a = getAcc(t.date)
    a.tradeCount += 1
    if (t.pnl != null) {
      a.tradesWithPnl += 1
      if (t.pnl > 0) a.tradeWins += 1
      a.tradePnlByDate.set(t.date, (a.tradePnlByDate.get(t.date) ?? 0) + t.pnl)
    }
    a.daysSeen.add(t.date)
  }

  // Day stats: contribute day-level metrics + process scores + eod_pnl override.
  for (const d of dayStats) {
    const a = getAcc(d.date)
    a.daysSeen.add(d.date)
    if (d.process_score != null) a.procScores.push(d.process_score)
    if (d.eod_pnl != null) {
      a.pnlFromOverride += d.eod_pnl
      a.tradedDaysWithOverride.add(d.date)
    }
  }

  // Second pass: resolve per-day pnl (override > trade sum) + day-level stats.
  const buckets: Bucket[] = []
  for (const [key, a] of acc) {
    // Sum non-overridden days' trade pnl
    let pnlFromUnoverriddenTrades = 0
    for (const [date, sum] of a.tradePnlByDate) {
      if (!a.tradedDaysWithOverride.has(date)) {
        pnlFromUnoverriddenTrades += sum
      }
    }
    const pnl = a.pnlFromOverride + pnlFromUnoverriddenTrades

    // Day win rate: combine override and trade-derived pnl per date.
    const dayPnlByDate = new Map<string, number>()
    for (const d of dayStats) {
      const sameKey = bucketKey(d.date, gran).key === key
      if (sameKey && d.eod_pnl != null) dayPnlByDate.set(d.date, d.eod_pnl)
    }
    for (const [date, sum] of a.tradePnlByDate) {
      if (!dayPnlByDate.has(date)) dayPnlByDate.set(date, sum)
    }
    const tradedDays = dayPnlByDate.size
    let winDays = 0
    for (const v of dayPnlByDate.values()) if (v > 0) winDays += 1

    buckets.push({
      key,
      label: a.label,
      pnl,
      tradeWins: a.tradeWins,
      tradesWithPnl: a.tradesWithPnl,
      tradeWinRate: a.tradesWithPnl > 0 ? a.tradeWins / a.tradesWithPnl : null,
      tradedDays,
      winDays,
      dayWinRate: tradedDays > 0 ? winDays / tradedDays : null,
      medianProcess: median(a.procScores),
      procCount: a.procScores.length,
      tradeCount: a.tradeCount,
      dayCount: a.daysSeen.size,
    })
  }

  // Sort newest-first so the most recent period is at the top.
  buckets.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
  return buckets
}

/** Render a delta chip if curr/prev are both numeric. */
function Delta({
  curr,
  prev,
  unit = '',
  goodIsHigher = true,
  fractionDigits = 0,
}: {
  curr: number | null
  prev: number | null
  unit?: string
  goodIsHigher?: boolean
  fractionDigits?: number
}) {
  if (curr == null || prev == null) return null
  const diff = curr - prev
  if (Math.abs(diff) < 1e-9) {
    return <span className="text-[10px] text-gray-600">·</span>
  }
  const isGood = goodIsHigher ? diff > 0 : diff < 0
  const Icon = diff > 0 ? ChevronUp : ChevronDown
  return (
    <span className={`inline-flex items-center text-[10px] ${isGood ? 'text-green-400' : 'text-red-400'}`}>
      <Icon className="w-3 h-3" />
      {diff > 0 ? '+' : '−'}{Math.abs(diff).toFixed(fractionDigits)}{unit}
    </span>
  )
}

export default function PeriodComparison({ trades, dayStats }: Props) {
  const [gran, setGran] = useState<Granularity>('week')
  const [open, setOpen] = useState(false)
  // Period picker — which buckets to include in the comparison. Defaults
  // to the 3 most recent (the user's most common ask: "how does this
  // week/month compare to the last two") but the popover lets them check
  // any combination, e.g. "last 3 weeks plus the same week a quarter ago".
  const [pickerOpen, setPickerOpen] = useState(false)
  // Tagged selection — { gran, keys }. When gran flips (week ↔ month) or
  // selection is null, we render the top-3 default during render — no effect
  // needed, avoiding the set-state-in-effect rule.
  const [selection, setSelection] = useState<{ gran: Granularity; keys: Set<string> } | null>(null)

  const buckets = useMemo(() => computeBuckets(trades, dayStats, gran), [trades, dayStats, gran])

  const selectedKeys = useMemo<Set<string>>(() => {
    if (selection && selection.gran === gran) return selection.keys
    return new Set(buckets.slice(0, 3).map(b => b.key))
  }, [selection, gran, buckets])

  const visibleBuckets = useMemo(
    () => buckets.filter(b => selectedKeys.has(b.key)),
    [buckets, selectedKeys],
  )

  const toggleKey = (key: string) => {
    const next = new Set(selectedKeys)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSelection({ gran, keys: next })
  }

  const resetSelection = () => setSelection(null)

  if (buckets.length === 0) {
    return null
  }

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
      {/* Header row: collapse-button + title on the left, granularity toggle
          on the right. They're SIBLINGS — earlier they were nested (the
          granularity buttons lived inside the collapse <button>), which is
          invalid HTML and broke hydration. */}
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="flex-1 flex items-start gap-2 text-left"
        >
          <ChevronDown className={`w-4 h-4 text-gray-400 mt-0.5 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
          <div>
            <h2 className="font-semibold text-white">Period Comparison</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Side-by-side P&L, win rates, and process scores. Delta chips show
              change vs. the next-older period.
            </p>
          </div>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          {open && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setPickerOpen(o => !o)}
                className="px-3 py-1 text-xs bg-gray-800 border border-gray-700 rounded-md text-gray-300 hover:bg-gray-700 transition-colors whitespace-nowrap"
                title="Pick which periods appear in the table"
              >
                {selectedKeys.size} selected
              </button>
              {pickerOpen && (
                <div className="absolute right-0 mt-1 w-56 max-h-80 overflow-y-auto bg-gray-950 border border-gray-700 rounded-md shadow-xl z-20 p-1">
                  <div className="flex items-center justify-between px-2 py-1 text-[10px] text-gray-500 uppercase tracking-wide">
                    <span>Periods</span>
                    <button
                      type="button"
                      onClick={resetSelection}
                      className="text-blue-400 hover:text-blue-300 normal-case tracking-normal"
                    >
                      Reset to last 3
                    </button>
                  </div>
                  {buckets.map(b => {
                    const checked = selectedKeys.has(b.key)
                    return (
                      <label
                        key={b.key}
                        className="flex items-center gap-2 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800 rounded cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleKey(b.key)}
                          className="accent-blue-600"
                        />
                        <span className="flex-1 font-sans">{b.label}</span>
                        <span className="text-[10px] text-gray-600 font-mono">
                          {b.tradeCount}t
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          )}
          <div className="flex bg-gray-800 border border-gray-700 rounded-md overflow-hidden text-xs">
            {(['week', 'month'] as Granularity[]).map(g => (
              <button
                key={g}
                type="button"
                onClick={() => setGran(g)}
                className={`px-3 py-1 transition-colors ${
                  gran === g ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-gray-700'
                }`}
              >
                {GRAN_LABELS[g]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {open && (
        <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-gray-500 border-b border-gray-800 text-[11px]">
                <th className="text-left font-normal py-2 pr-3 whitespace-nowrap">{gran === 'week' ? 'Week' : 'Month'}</th>
                <th className="text-right font-normal py-2 pr-3 whitespace-nowrap">P&L</th>
                <th className="text-right font-normal py-2 pr-3 whitespace-nowrap">Trade Win %</th>
                <th className="text-right font-normal py-2 pr-3 whitespace-nowrap">Day Win %</th>
                <th className="text-right font-normal py-2 pr-3 whitespace-nowrap">Median Prep</th>
                <th className="text-right font-normal py-2 pr-3 whitespace-nowrap">Trades</th>
                <th className="text-right font-normal py-2 pr-3 whitespace-nowrap">Days</th>
              </tr>
            </thead>
            <tbody>
              {visibleBuckets.map((b, i) => {
                // Prior bucket = the next-older SELECTED one, so deltas
                // compare against whatever the user chose to put next to
                // this row (could be the immediately prior week or, e.g.,
                // last quarter's same-week if that's what they picked).
                const prev = visibleBuckets[i + 1] ?? null
                const pnlColor = b.pnl > 0 ? 'text-green-400' : b.pnl < 0 ? 'text-red-400' : 'text-gray-400'
                return (
                  <tr key={b.key} className="border-b border-gray-800/60 hover:bg-gray-800/30 transition-colors">
                    <td className="text-left py-2 pr-3 text-gray-300 whitespace-nowrap font-sans">
                      <div className="flex items-center gap-2">
                        <span>{b.label}</span>
                        {i === 0 && (
                          <span className="text-[9px] text-blue-400 bg-blue-900/40 px-1.5 py-0.5 rounded-full">
                            current
                          </span>
                        )}
                      </div>
                    </td>
                    <td className={`text-right py-2 pr-3 font-medium ${pnlColor} whitespace-nowrap`}>
                      <div className="flex items-center justify-end gap-1.5">
                        {`${b.pnl >= 0 ? '+' : '−'}$${Math.abs(Math.round(b.pnl)).toLocaleString()}`}
                        <Delta curr={b.pnl} prev={prev?.pnl ?? null} unit="" goodIsHigher fractionDigits={0} />
                      </div>
                    </td>
                    <td className="text-right py-2 pr-3 text-gray-300 whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        {b.tradeWinRate == null ? '—' : `${(b.tradeWinRate * 100).toFixed(0)}%`}
                        <Delta
                          curr={b.tradeWinRate == null ? null : b.tradeWinRate * 100}
                          prev={prev?.tradeWinRate == null ? null : prev.tradeWinRate * 100}
                          unit="%"
                        />
                      </div>
                    </td>
                    <td className="text-right py-2 pr-3 text-gray-300 whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        {b.dayWinRate == null ? '—' : `${(b.dayWinRate * 100).toFixed(0)}%`}
                        <Delta
                          curr={b.dayWinRate == null ? null : b.dayWinRate * 100}
                          prev={prev?.dayWinRate == null ? null : prev.dayWinRate * 100}
                          unit="%"
                        />
                      </div>
                    </td>
                    <td className="text-right py-2 pr-3 text-gray-300 whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        {b.medianProcess == null
                          ? <span className="text-gray-600">—</span>
                          : <span>{b.medianProcess.toFixed(1)}/10</span>}
                        <Delta
                          curr={b.medianProcess}
                          prev={prev?.medianProcess ?? null}
                          unit=""
                          fractionDigits={1}
                        />
                      </div>
                    </td>
                    <td className="text-right py-2 pr-3 text-gray-400 whitespace-nowrap">{b.tradeCount}</td>
                    <td className="text-right py-2 pr-3 text-gray-400 whitespace-nowrap">{b.dayCount}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {visibleBuckets.length >= 2 && (
            <p className="text-[10px] text-gray-600 mt-2 flex items-center gap-1">
              <ArrowRight className="w-3 h-3" />
              Delta chips compare each row vs. the next row (the older selected period).
              First row has no delta — no prior bucket to compare against.
            </p>
          )}
          {visibleBuckets.length === 0 && (
            <p className="text-center text-xs text-gray-600 italic py-6">
              No periods selected. Open the picker above to choose which {gran}s to compare.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
