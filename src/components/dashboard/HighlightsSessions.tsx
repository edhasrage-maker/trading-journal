'use client'

import { useState } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import { ChevronRight } from 'lucide-react'
import AchievementCoin from '@/components/AchievementCoin'
import { ACHIEVEMENT_CATALOG, type AchievementId } from '@/lib/achievements'
import { tapeScoreDaySentence } from '@/lib/tapescore'
import type { DayRowData } from './RecentDaysList'

/**
 * Highlights' Recent sessions — what happened each day, not just the numbers
 * (founder, 2026-10-28; docs/tapescore-highlights-mockup-r2.html).
 *
 * Columns: Date (trade count under it) · TapeScore (score + word) · What
 * happened · Win rate · P&L. "What happened" is the day's recap headline — the
 * same line the Recap page leads with, falling back to the deterministic day
 * sentence — plus a tag where the score and the money disagree, and the day's
 * badges as coins. One flat list, newest first: six rows, then all of them.
 */

const VISIBLE = 6

function money(n: number): string {
  return `${n < 0 ? '-' : '+'}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`
}

/** "2026-10-28" → "Wed, Oct 28". Noon so the timezone can't roll the day back. */
function dayLabel(date: string): string {
  try { return format(new Date(`${date}T12:00:00`), 'EEE, MMM d') } catch { return date }
}

/** The score's word, in step with its colour band (green 70+, amber 50-69,
 *  red under 50). A session capped by a rule breach says so instead. */
function scoreWord(score: number, capped: boolean): { word: string; cls: string } {
  if (capped) return { word: 'Broke a rule', cls: 'border-red-800/60 text-red-300 bg-red-950/40' }
  if (score >= 80) return { word: 'Excellent', cls: 'border-green-800/60 text-green-300 bg-green-950/40' }
  if (score >= 70) return { word: 'Strong', cls: 'border-green-800/60 text-green-300 bg-green-950/40' }
  if (score >= 50) return { word: 'Fair', cls: 'border-amber-800/60 text-amber-300 bg-amber-950/40' }
  return { word: 'Needs work', cls: 'border-red-800/60 text-red-300 bg-red-950/40' }
}

export default function HighlightsSessions({ days, headlines, periodLabel }: {
  /** The period's sessions, newest first. */
  days: DayRowData[]
  /** Recap headline per trading_days id (eod_ai_analysis_json.headline). */
  headlines: Record<string, string>
  periodLabel: string
}) {
  const [showAll, setShowAll] = useState(false)
  if (days.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-6 text-sm text-gray-500 text-center">
        No sessions in {periodLabel.toLowerCase()}.
      </div>
    )
  }

  // "Best day" marks the period's top P&L session (only when it was green).
  const best = days.reduce<DayRowData | null>((a, d) => ((d.eod_pnl ?? -Infinity) > (a?.eod_pnl ?? -Infinity) ? d : a), null)
  const bestId = best && (best.eod_pnl ?? 0) > 0 ? best.id : null
  const shown = showAll ? days : days.slice(0, VISIBLE)

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="flex items-baseline justify-between gap-3 px-4 sm:px-5 pt-4 pb-3">
        <h2 className="text-sm font-semibold text-white" style={{ fontFamily: 'var(--font-display)' }}>Recent sessions</h2>
        <span className="text-[11px] text-gray-500">tap a session for its recap</span>
      </div>

      {/* Column headers — wide screens only; phones stack each row. */}
      <div className="hidden md:grid grid-cols-[110px_120px_1fr_76px_92px_14px] gap-3.5 px-5 py-2 border-t border-gray-800 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        <span>Date</span><span>TapeScore</span><span>What happened</span>
        <span className="text-right">Win rate</span><span className="text-right">P&amp;L</span><span />
      </div>

      <ul>
        {shown.map(d => {
          const score = d.tapescore?.score ?? null
          const pnl = d.eod_pnl
          const wr = d.trades_with_pnl_count > 0 ? Math.round((d.trade_wins / d.trades_with_pnl_count) * 100) : null
          const story = headlines[d.id]?.trim()
            || (d.tapescore ? tapeScoreDaySentence(d.tapescore) : 'Not graded yet — open it to get its TapeScore.')
          const pill = score != null ? scoreWord(score, !!d.tapescore?.capped) : null
          const coins = d.achievements.filter((id): id is AchievementId => id in ACHIEVEMENT_CATALOG)
          const tags: { label: string; cls: string; title: string }[] = []
          if (score != null && pnl != null && score >= 70 && pnl < 0) {
            tags.push({ label: 'Good trading, red day', cls: 'text-blue-300 bg-blue-950/50 border-blue-800/60', title: 'You traded it well; the market just didn’t pay.' })
          }
          if (score != null && pnl != null && score < 60 && pnl > 0) {
            tags.push({ label: 'Green, but sloppy', cls: 'text-amber-300 bg-amber-950/40 border-amber-800/60', title: 'It made money, but the trading scored low.' })
          }
          if (d.id === bestId) {
            tags.push({ label: 'Best day', cls: 'text-gray-300 bg-gray-800 border-gray-700', title: `Your best P&L in ${periodLabel.toLowerCase()}.` })
          }
          return (
            <li key={d.id} className="border-t border-gray-800">
              <Link
                href={`/review/today/${d.date}`}
                className="grid grid-cols-[auto_1fr_auto] md:grid-cols-[110px_120px_1fr_76px_92px_14px] gap-x-3.5 gap-y-2 items-center px-4 sm:px-5 py-3 hover:bg-gray-800/40 transition-colors"
              >
                <div className="text-[13px] font-semibold text-gray-100">
                  {dayLabel(d.date)}
                  <span className="block text-[11px] font-normal text-gray-500">
                    {d.trade_count} trade{d.trade_count === 1 ? '' : 's'}
                  </span>
                </div>
                <div>
                  {pill ? (
                    <span className={`inline-flex items-baseline gap-1.5 text-[12px] px-2 py-1 rounded-md border whitespace-nowrap ${pill.cls}`}>
                      <b className="text-[15px] font-semibold tabular-nums">{score}</b>{pill.word}
                    </span>
                  ) : (
                    <span className="text-[12px] text-gray-500">—</span>
                  )}
                </div>
                <div className="col-span-3 md:col-span-1 row-start-2 md:row-start-auto min-w-0">
                  <div className="text-[14px] text-gray-200 leading-snug">{story}</div>
                  {(tags.length > 0 || coins.length > 0) && (
                    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                      {tags.map(t => (
                        <span key={t.label} className={`text-[11px] font-semibold px-1.5 py-0.5 rounded border ${t.cls}`} title={t.title}>{t.label}</span>
                      ))}
                      {coins.map(id => (
                        <AchievementCoin
                          key={id}
                          id={id}
                          size={22}
                          ring="flat"
                          title={`${ACHIEVEMENT_CATALOG[id].label} — ${ACHIEVEMENT_CATALOG[id].blurb}`}
                        />
                      ))}
                    </div>
                  )}
                </div>
                <div className="hidden md:block text-right text-[14px] text-gray-200 tabular-nums">{wr != null ? `${wr}%` : '—'}</div>
                <div className={`text-right text-[15px] font-semibold tabular-nums ${(pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {pnl != null ? money(pnl) : '—'}
                  {wr != null && <span className="md:hidden block text-[11px] font-normal text-gray-500">{wr}% win rate</span>}
                </div>
                <ChevronRight className="hidden md:block w-3.5 h-3.5 text-gray-600" />
              </Link>
            </li>
          )
        })}
      </ul>

      {days.length > VISIBLE && (
        <button
          type="button"
          onClick={() => setShowAll(v => !v)}
          className="w-full border-t border-gray-800 py-3 text-[13px] font-semibold text-blue-400 hover:text-blue-300"
        >
          {showAll ? 'Show fewer' : `Show all ${days.length} sessions`}
        </button>
      )}
    </div>
  )
}
