'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronDown } from 'lucide-react'
import type { BigDaysWhy, ScoutAction } from '@/lib/dashboard-read'
import { fmtSignedUsd } from './DashboardStats'
import ScoreChip from './ScoreChip'

const OPEN_KEY = 'dashboard-scouting-open-v1'

const shortDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/**
 * The Scouting report (founder, 2026-11-01): why the period's biggest days
 * scored low, then what to do — each line built by src/lib/dashboard-read.ts
 * from a part of the page, which it names. Hide / Show folds it to its title;
 * the choice is remembered on this device.
 */
export default function ScoutingReport({ why, actions }: { why: BigDaysWhy | null; actions: ScoutAction[] }) {
  const [open, setOpen] = useState(true)
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- load-from-localStorage hydration shim
      if (localStorage.getItem(OPEN_KEY) === '0') setOpen(false)
    } catch { /* ignore */ }
  }, [])
  const toggle = () => {
    setOpen(o => {
      try { localStorage.setItem(OPEN_KEY, o ? '0' : '1') } catch { /* ignore */ }
      return !o
    })
  }
  if (!why && actions.length === 0) return null

  return (
    <section aria-label="Scouting report" className="px-5 sm:px-7 py-5 border-b border-gray-800">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-[20px] font-bold text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>Scouting report</h2>
        <span className="text-[14px] text-gray-400">What you should do, from this period</span>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="ml-auto inline-flex items-center gap-1 text-[13px] text-gray-200 border border-gray-700 hover:border-gray-500 rounded-md px-3 py-1"
        >
          {open ? 'Hide' : 'Show'}
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {open && (
        <>
          {why && (
            <div className="mt-4 rounded-[10px] bg-gray-950 px-4 sm:px-5 py-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">
                <h3 className="text-[17px] font-bold text-gray-100">{why.title}</h3>
                {why.twinNote && <span className="text-[13px] text-gray-400">{why.twinNote}</span>}
              </div>
              <div className={`grid gap-4 sm:grid-cols-2 ${why.days.length >= 4 ? 'xl:grid-cols-4' : why.days.length === 3 ? 'xl:grid-cols-3' : ''}`}>
                {why.days.map((d, i) => (
                  <div key={d.date} className={`min-w-0 ${i > 0 ? 'xl:border-l xl:border-gray-800 xl:pl-5' : ''}`}>
                    <div className="flex items-baseline gap-2.5">
                      <Link href={`/session/${d.date}`} className="text-[16px] font-bold text-gray-100 hover:underline" style={{ fontFamily: 'var(--font-display)' }}>
                        {shortDate(d.date)}
                      </Link>
                      <b className={`text-[18px] tabular-nums ${d.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`} style={{ fontFamily: 'var(--font-display)' }}>{fmtSignedUsd(d.pnl)}</b>
                      <span className="text-[13px] text-gray-400">{d.trades} trade{d.trades === 1 ? '' : 's'}</span>
                      <ScoreChip score={d.score} className="ml-auto text-[13px]" />
                    </div>
                    <ul className="mt-2 pl-4 list-disc text-[14px] leading-relaxed text-gray-200 marker:text-gray-600">
                      {d.reasons.length === 0 && <li className="text-gray-400">Nothing in particular flagged</li>}
                      {d.reasons.map(r => <li key={r}>{r}</li>)}
                      <li className="text-gray-400">
                        Risk {d.axes.risk ?? '—'} · Entry {d.axes.entry ?? '—'} · Exit {d.axes.exit ?? '—'}
                      </li>
                    </ul>
                  </div>
                ))}
              </div>
              {why.takeaway && (
                <p className="mt-4 pt-3 border-t border-gray-800 text-[15px] sm:text-[16px] font-semibold leading-snug text-gray-100">{why.takeaway}</p>
              )}
            </div>
          )}

          {actions.length > 0 && (
            <>
              <h3 className="mt-5 text-[14px] font-semibold text-gray-100">What to do</h3>
              <ol className={`mt-2.5 grid gap-5 sm:grid-cols-2 ${actions.length >= 4 ? 'xl:grid-cols-4' : actions.length === 3 ? 'xl:grid-cols-3' : ''}`}>
                {actions.map((a, i) => (
                  <li key={a.title} className={`min-w-0 ${i > 0 ? 'xl:border-l xl:border-gray-800 xl:pl-5' : ''}`}>
                    <div className="text-[15px] font-bold text-gray-500" style={{ fontFamily: 'var(--font-display)' }}>{i + 1}</div>
                    <div className="mt-1 text-[17px] font-bold leading-snug text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>{a.title}</div>
                    <p className="mt-1.5 text-[14px] leading-snug text-gray-400">{a.why}</p>
                    {a.note && <p className="mt-2 text-[12.5px] leading-snug text-gray-200 bg-gray-950 rounded-md px-2 py-1.5">{a.note}</p>}
                    <p className="mt-2 text-[12px] text-gray-500">From: {a.source}</p>
                  </li>
                ))}
              </ol>
            </>
          )}
        </>
      )}
    </section>
  )
}
