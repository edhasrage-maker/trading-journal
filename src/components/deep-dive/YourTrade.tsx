'use client'

/**
 * "Your trade" — the trade's Score (the Recap's, in a narrow layout), its
 * screenshot (click for the same full-screen view as Game film) and your tags,
 * grouped the way every trade view groups them. Full review only: the Exit
 * half is how it went, a live Sierra screenshot shows the open P&L and a
 * Mistake tag says how it went, so none of it is fetched while Blind is on.
 */
import { useState } from 'react'
import { cn } from '@/lib/utils'
import ScreenshotLightbox from '@/components/intraday/ScreenshotLightbox'
import { TradeGradeCompact } from '@/components/session/TradeGrade'
import type { ReplayDetails } from '@/app/api/deep-dive/details/route'

export default function YourTrade({ details, error, scoring = null, big = false }: {
  details: ReplayDetails | null
  error?: string | null
  /** The on-demand Entry read for this trade: running now, or why it didn't land. */
  scoring?: 'running' | 'pending' | 'error' | null
  /** Phone tab: a taller screenshot, bigger text. */
  big?: boolean
}) {
  const [zoom, setZoom] = useState(false)
  const cap = cn('font-semibold uppercase tracking-[.8px] text-gray-400', big ? 'text-[11px]' : 'text-[10.5px]')
  const empty = cn('text-gray-400', big ? 'text-[13px]' : 'text-[12.5px]')
  const note = !details ? null
    : details.tooOld ? 'No Entry part: the site keeps 90 days of tick data and this trade is older.'
    : scoring === 'pending' ? 'No Entry part yet: the tick data for your fill isn’t on the site yet. It scores on a later visit.'
    : scoring === 'error' ? 'No Entry part: the tick data at your fill couldn’t be read just now.'
    : null

  if (error) return <p className="text-[12.5px] text-red-400">{error}</p>
  return (
    <div>
      <div className={cn(cap, 'mb-1.5')}>Score</div>
      {!details ? <p className={empty}>Loading…</p>
        : scoring === 'running' ? <p className={empty}>Scoring this trade… reading the tick data at your fill.</p>
        : <TradeGradeCompact grade={details.grade} neverWent={details.neverWent} hasStop={details.hasStop} note={note} big={big} />}

      <div className={cn(cap, 'mt-[18px] mb-1.5')}>Screenshot</div>
      {!details ? <p className={empty}>Loading…</p> : details.screenshot ? (
        <button
          type="button"
          onClick={() => setZoom(true)}
          aria-label="Open your screenshot full screen"
          className="relative block w-full border border-gray-800 rounded overflow-hidden cursor-zoom-in"
          style={{ height: big ? 190 : 170, background: 'var(--color-surface-2)' }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URL, arbitrary size; next/image needs a fixed remote pattern */}
          <img src={details.screenshot} alt="Your screenshot of this trade" className="w-full h-full object-contain" draggable={false} />
          <span className="absolute right-1.5 bottom-1.5 px-1.5 rounded-[3px] text-[11px]" style={{ background: 'var(--color-surface-1)', color: 'var(--ts-mut)' }}>
            {big ? 'tap to zoom' : 'click to zoom'}
          </span>
        </button>
      ) : <p className={empty}>No screenshot for this trade.</p>}

      <div className={cn(cap, 'mt-4 mb-1')}>Your tags</div>
      {details && (details.tags.length === 0 ? <p className={empty}>Nothing tagged yet.</p> : details.tags.map(g => (
        <div key={g.label} className={cn('flex gap-2 border-b border-gray-800', big ? 'py-[7px] text-[13px]' : 'py-1.5 text-[12px]')}>
          <span className={cn('flex-none text-gray-400 pt-0.5', big ? 'w-[82px]' : 'w-[74px]')}>{g.label}</span>
          <span className="flex flex-wrap gap-1">
            {g.items.map(it => (
              <span
                key={it}
                className={cn(
                  'px-2 py-0.5 rounded-full border',
                  big ? 'text-[12.5px]' : 'text-[11.5px]',
                  g.danger ? 'border-red-800/60 text-red-300 bg-red-950/30' : 'border-gray-700 text-gray-100',
                )}
              >{it}</span>
            ))}
          </span>
        </div>
      )))}

      <ScreenshotLightbox src={zoom && details?.screenshot ? details.screenshot : null} onClose={() => setZoom(false)} />
    </div>
  )
}
