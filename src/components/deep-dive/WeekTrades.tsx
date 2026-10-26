'use client'

/**
 * The week's trades, by day — Replay Review's trade list.
 *
 * BLIND shows only what was known at the fill: time, instrument, Long / Short,
 * and a ✓ once you've made your call (never which call). No P&L, no R, and no
 * green / red anywhere, so a colour can't be read as a result — Long / Short
 * is plain text for the same reason. FULL REVIEW adds the result and your call.
 */
import { format, parseISO } from 'date-fns'
import { cn } from '@/lib/utils'
import type { TradeVerdict } from '@/lib/supabase/types'
import type { ReplayResult } from '@/app/api/deep-dive/results/route'

export interface WeekTrade {
  id: string
  entryUtc: string
  symbol: string
  direction: 'long' | 'short'
  /** PT date of the entry. */
  date: string
  /** You've made your call on it (a yes / no only). */
  called: boolean
}

export interface WeekNav { title: string; range: string; prev: string; next: string | null }

const hhmm = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
export const rootOf = (symbol: string) => (/^M?NQ/i.test(symbol) ? 'NQ' : /^M?ES/i.test(symbol) ? 'ES' : symbol.slice(0, 3))
export const fmtUsd = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`

const CALL: Record<TradeVerdict['call'], { label: string; cls: string }> = {
  good: { label: 'Good', cls: 'text-green-400' },
  mistake: { label: 'Mistake', cls: 'text-red-400' },
  unsure: { label: 'Unsure', cls: 'text-gray-500' },
}

const Chevron = ({ left }: { left?: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><path d={left ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} /></svg>
)

export default function WeekTrades({
  trades, selectedId, onSelect, blind, results, calls, week, onWeek, big = false,
}: {
  trades: WeekTrade[]
  selectedId: string | null
  onSelect: (id: string) => void
  blind: boolean
  /** Full review only. */
  results: Record<string, ReplayResult> | null
  /** Calls saved on this page, newer than the list. */
  calls: Record<string, TradeVerdict['call']>
  week: WeekNav
  onWeek: (monday: string) => void
  /** Phone sheet: taller rows. */
  big?: boolean
}) {
  const callOf = (t: WeekTrade) => calls[t.id] ?? results?.[t.id]?.call ?? null
  const isCalled = (t: WeekTrade) => t.called || !!calls[t.id] || !!results?.[t.id]?.call
  const nCalled = trades.filter(isCalled).length
  const navBtn = 'inline-flex items-center justify-center w-[26px] h-[26px] border border-gray-800 rounded-[4px] text-gray-400 hover:text-gray-100 disabled:opacity-40 disabled:hover:text-gray-400'

  return (
    <div>
      {!big && (
        <div className="flex items-center justify-between mt-3.5 mb-1.5">
          <span className="text-[13px] font-semibold text-gray-100">{week.title} <span className="font-normal text-gray-400">{week.range}</span></span>
          <span className="flex gap-1">
            <button type="button" className={navBtn} aria-label="Previous week" onClick={() => onWeek(week.prev)}><Chevron left /></button>
            <button type="button" className={navBtn} aria-label="Next week" disabled={!week.next} onClick={() => week.next && onWeek(week.next)}><Chevron /></button>
          </span>
        </div>
      )}
      {trades.length === 0 && <p className="text-[12.5px] text-gray-500 mt-2">No trades this week.</p>}
      {trades.map((t, i) => {
        const head = i === 0 || trades[i - 1].date !== t.date ? format(parseISO(t.date), 'EEE MMM d') : null
        const r = results?.[t.id], c = callOf(t), current = t.id === selectedId
        return (
          <div key={t.id}>
            {head && <div className={cn('font-semibold uppercase tracking-[.8px] text-gray-400', big ? 'text-[11px] mt-3.5 mb-1' : 'text-[10.5px] mt-2.5 mb-[3px]')}>{head}</div>}
            <button
              type="button"
              onClick={() => onSelect(t.id)}
              aria-current={current ? 'true' : undefined}
              className={cn(
                'flex items-center gap-2 w-full text-left border rounded-[4px] mb-0.5 transition-colors',
                big ? 'h-11 px-3 text-[14px]' : 'px-2 py-[5px] text-[12.5px]',
                current ? 'border-blue-500 bg-blue-500/10 text-gray-100' : 'border-transparent text-gray-100 hover:bg-gray-800/40',
              )}
              title={t.symbol}
            >
              <span className={cn('font-mono tabular-nums', big ? 'text-[13px]' : 'text-[12px]')}>{hhmm(t.entryUtc)}</span>
              <span>{rootOf(t.symbol)}</span>
              <span className="text-gray-400">{t.direction === 'long' ? 'Long' : 'Short'}</span>
              <span className="ml-auto flex items-center gap-2">
                {!blind && r?.pnl != null && (
                  <span className={cn('font-mono tabular-nums text-[12px]', r.pnl > 0 ? 'text-green-400' : r.pnl < 0 ? 'text-red-400' : 'text-gray-400')}>{fmtUsd(r.pnl)}</span>
                )}
                <span
                  className={cn('w-3.5 text-center text-[11px]', blind ? 'text-gray-400' : c ? CALL[c].cls : '')}
                  title={blind ? (isCalled(t) ? "You've made your call" : 'No call yet') : c ? `Your call: ${CALL[c].label}` : 'No call yet'}
                >
                  {blind ? (isCalled(t) ? '✓' : '') : c ? '●' : ''}
                </span>
              </span>
            </button>
          </div>
        )
      })}
      {trades.length > 0 && (
        <div className="mt-2.5 text-[12px] text-gray-400">
          {nCalled} of {trades.length} called{blind ? ' · results hidden' : ''}
        </div>
      )}
    </div>
  )
}
