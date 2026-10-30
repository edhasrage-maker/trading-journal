'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, X, ExternalLink, PlayCircle } from 'lucide-react'
import TradeForm from '@/components/intraday/TradeForm'
import PinPlacement, { type Pin, type PinType } from '@/components/intraday/PinPlacement'
import ScreenshotLightbox from '@/components/intraday/ScreenshotLightbox'
import { rMultiple } from '@/lib/analytics'
import { plannedStopPrice } from '@/lib/planned-stop'
import { tradeFacts, tradeMgmt, mgmtBarGeometry, exitKind } from '@/lib/trade-management'
import { symbolRoot } from '@/lib/futures-symbols'
import { postExitVerdict, plannedExitRead, type VerdictTrade, type VerdictTone } from '@/lib/post-exit-verdict'
import { useMfeUnit } from '@/lib/mfe-unit'
import { DISCARD_TRADE_EDITS_MESSAGE, clearTradeDraft, tradeDraftKey } from '@/lib/trade-draft'
import type { PostExitData } from '@/lib/atr'
import type { TradeGrade } from '@/lib/trade-grade'
import type { Trade, TradeTag } from '@/lib/supabase/types'
import { keptCell, magLabel } from './SessionTradeTable'
import { TradeGradeWhy } from './TradeGrade'

// Pacific, like the table — the panel only renders in the browser, but the
// trade's time should read the same as its row.
const PT_CLOCK_SECONDS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' })

const VERDICT_TONE_CLASS: Record<VerdictTone, string> = {
  good: 'text-green-400',
  welltimed: 'text-green-500/70',
  left: 'text-amber-400',
  giveback: 'text-red-400',
  flat: 'text-gray-500',
}

const CALL_CLASS = { good: 'text-emerald-400', mistake: 'text-red-400', unsure: 'text-amber-300' } as const

/**
 * One trade, opened (mockup: SessionTradeOpen). A right-hand panel that reads
 * top to bottom: the result (P&L, R, Score, Kept, the MAE · MFE bar, what price
 * did after the exit), the chart with a way into Replay, why it scored what it
 * did, then the trader's own log — editable in place, the same TradeForm and the
 * same save path as everywhere else. ‹ › step through the day's trades in time
 * order.
 *
 * While the session is live the panel is the log alone: no result, no Score, no
 * after-exit read — judgment waits for the close, as it does in the table.
 *
 * Every number here comes from the same functions the table's columns use; this
 * is a second view of them, not a second calculation.
 */
export default function TradeOpenPanel({
  trades, tradeId, live, date, allTags, defaultSymbol, gradeOf, liveAtrByTradeId, giveBackAtr = 1,
  postExitByTradeId, deepDive = false, onStep, onSave, onClose, onOpenFullLog, onTagCreated,
}: {
  /** The day's trades in time order — what ‹ › walk through. */
  trades: Trade[]
  tradeId: string
  live: boolean
  date: string
  allTags: TradeTag[]
  defaultSymbol?: string | null
  gradeOf: (t: Trade) => TradeGrade | null
  liveAtrByTradeId?: Record<string, number>
  giveBackAtr?: number
  postExitByTradeId?: Record<string, PostExitData>
  /** Show "Replay this trade" (Replay Review is a private beta). */
  deepDive?: boolean
  onStep: (tradeId: string) => void
  onSave: (trade: Trade) => void
  onClose: () => void
  /** The full form — replace the screenshot, re-read levels, direction. */
  onOpenFullLog: (tradeId: string) => void
  onTagCreated?: (tag: TradeTag) => void
}) {
  const index = trades.findIndex(t => t.id === tradeId)
  const t = trades[index]
  const [mfeUnit] = useMfeUnit()
  const [zoomed, setZoomed] = useState<string | null>(null)

  // Unsaved edits in the log. Stepping or closing asks before dropping them
  // (the form's own Cancel asks for itself).
  const dirtyRef = useRef(false)
  const onDirtyChange = useCallback((dirty: boolean) => { dirtyRef.current = dirty }, [])
  const leave = useCallback((then: () => void) => {
    if (dirtyRef.current) {
      if (!window.confirm(DISCARD_TRADE_EDITS_MESSAGE)) return
      clearTradeDraft(tradeDraftKey(tradeId, date))
    }
    dirtyRef.current = false
    then()
  }, [tradeId, date])
  const requestClose = useCallback(() => leave(onClose), [leave, onClose])
  const prev = index > 0 ? trades[index - 1] : null
  const next = index >= 0 && index < trades.length - 1 ? trades[index + 1] : null

  // Esc closes (matches the app's other overlays) — unless the screenshot zoom,
  // which also closes on Esc, is open: then the key is its.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.querySelector('[aria-label="Trade screenshot zoom"]')) return
      requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestClose])

  if (!t) return null

  const time = t.entry_time ? PT_CLOCK_SECONDS.format(new Date(t.entry_time)) : '--:--:--'
  const isLong = t.direction === 'long'
  const isShort = t.direction === 'short'
  const setup = t.tags_json?.setups?.[0]
  const title = [
    `${isLong ? 'Long' : isShort ? 'Short' : ''} ${t.quantity ?? ''} ${t.symbol ? symbolRoot(t.symbol) : ''}`.replace(/\s+/g, ' ').trim(),
    setup,
  ].filter(Boolean).join(' · ')

  // ── The result — the table's own reads, one trade at a time ──
  const liveAtr = liveAtrByTradeId?.[t.id]
  const pnl = t.pnl ?? 0
  const r = rMultiple(t, liveAtr)
  const atrBased = r != null && plannedStopPrice(t) == null
  const grade = live ? null : gradeOf(t)
  const mgmt = tradeMgmt(t, { atr: liveAtr, thresholdAtr: giveBackAtr })
  const kept = keptCell(mgmt)
  const facts = tradeFacts(t, { atr: liveAtr })
  const mae = facts?.mae[mfeUnit] ?? null
  const mfe = facts?.mfe[mfeUnit] ?? null
  const geo = facts ? mgmtBarGeometry({ mfe, mae, result: facts.result[mfeUnit] }, { maxMae: mae ?? 0, maxMfe: mfe ?? 0 }) : null
  const ext = postExitByTradeId?.[t.id]
  const kind = exitKind(t)
  const after = (() => {
    if (kind === 'stopped' || kind === 'target') {
      const read = plannedExitRead(t as VerdictTrade, kind, ext)
      return { text: read.label, cls: 'text-gray-400', title: read.title }
    }
    const v = postExitVerdict(t as VerdictTrade, ext)
    return v ? { text: `${v.glyph} ${v.label}`, cls: VERDICT_TONE_CLASS[v.tone], title: v.title } : null
  })()
  const partialWindow = ext != null && ext.full_window === false
  const verdict = t.review_json?.verdict

  const pins: Partial<Record<PinType, Pin>> = {}
  if (t.entry_pin_x != null && t.entry_pin_y != null) pins.entry = { x: t.entry_pin_x, y: t.entry_pin_y }
  if (t.stop_pin_x != null && t.stop_pin_y != null) pins.stop = { x: t.stop_pin_x, y: t.stop_pin_y }
  if (t.tp1_pin_x != null && t.tp1_pin_y != null) pins.tp1 = { x: t.tp1_pin_x, y: t.tp1_pin_y }

  const navBtn = 'inline-flex items-center justify-center w-9 h-9 rounded-md border border-gray-700 bg-gray-900 text-gray-300 hover:text-white hover:border-gray-500 disabled:opacity-40 disabled:hover:border-gray-700 disabled:cursor-not-allowed transition-colors'
  const tile = 'bg-gray-900 rounded-lg px-1 py-2 text-center'
  const tileLabel = 'text-[11px] text-gray-500'
  const tileValue = 'text-lg font-bold tabular-nums'

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop — click to dismiss. */}
      <div className="flex-1 bg-black/50" onClick={requestClose} aria-hidden="true" />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Trade at ${time}`}
        className="w-full max-w-[600px] h-full bg-gray-950 border-l border-gray-800 shadow-2xl flex flex-col"
      >
        <div className="flex items-center gap-2.5 px-4 sm:px-[18px] py-3.5 border-b border-gray-800 shrink-0">
          <div className="flex-1 min-w-0">
            <h2 className="text-[17px] font-semibold text-white truncate" style={{ fontFamily: 'var(--font-display)' }}>
              <span className="font-mono">{time}</span>
              {title && <> · {(isLong || isShort) && <span className={isLong ? 'text-green-400' : 'text-red-400'}>{isLong ? '▲' : '▼'}</span>} {title}</>}
            </h2>
            <p className="text-xs text-gray-500">Trade {index + 1} of {trades.length}</p>
          </div>
          <button type="button" className={navBtn} aria-label="Previous trade" disabled={!prev} onClick={() => prev && leave(() => onStep(prev.id))}>
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button type="button" className={navBtn} aria-label="Next trade" disabled={!next} onClick={() => next && leave(() => onStep(next.id))}>
            <ChevronRight className="w-4 h-4" />
          </button>
          <button type="button" className={navBtn} aria-label="Close" onClick={requestClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 sm:px-[18px] py-4 space-y-4">
          {!live && (
            <>
              {/* Result */}
              <section aria-label="Result" className="space-y-2.5">
                <div className="grid grid-cols-4 gap-2">
                  <div className={tile}>
                    <div className={tileLabel}>P&amp;L</div>
                    <div className={`${tileValue} ${pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                      {pnl < 0 ? '−' : pnl > 0 ? '+' : ''}${Math.abs(Math.round(pnl)).toLocaleString('en-US')}
                    </div>
                  </div>
                  <div className={tile} title={atrBased ? 'R in ATR units (no stop/TP): PnL ÷ (1 ATR at entry × qty × multiplier).' : 'R = PnL ÷ planned risk (|entry − stop| × qty × multiplier).'}>
                    <div className={tileLabel}>R</div>
                    <div className={`${tileValue} ${r == null ? 'text-gray-600' : r >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {r == null ? '—' : `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}${atrBased ? '*' : ''}`}
                    </div>
                  </div>
                  <div className={tile} title="This trade's grade: Entry and Exit averaged. The reasons are below.">
                    <div className={tileLabel}>Score</div>
                    <div className={`${tileValue} text-gray-100`}>{grade?.score ?? '—'}</div>
                  </div>
                  <div className={tile} title={kept.title}>
                    <div className={tileLabel}>Kept</div>
                    <div className={`${tileValue} ${kept.cls}`}>{kept.text}</div>
                  </div>
                </div>

                {facts && (
                  <div className="flex items-center gap-2 text-xs" title="MAE (left): the worst point reached. MFE (right): the best. Solid = what you kept or lost.">
                    <span className="w-[76px] text-right text-red-400 whitespace-nowrap"><b className="text-gray-400 font-semibold">MAE</b> −{magLabel(mae, mfeUnit)}</span>
                    <span className="relative block flex-1 h-[9px] rounded-[3px] bg-gray-800" aria-hidden="true">
                      {geo && (
                        <>
                          <span className="absolute top-0 h-[9px] bg-red-400/30" style={{ left: `${geo.maeLeft}%`, width: `${geo.maeWidth}%` }} />
                          <span className="absolute top-0 h-[9px] bg-green-400/25" style={{ left: `${geo.zero}%`, width: `${geo.mfeWidth}%` }} />
                          {geo.solidSide !== 'none' && (
                            <span
                              className={`absolute top-0 h-[9px] ${geo.solidSide === 'kept' ? 'bg-green-400' : 'bg-red-400'}`}
                              style={{ left: `${geo.solidLeft}%`, width: `${geo.solidWidth}%` }}
                            />
                          )}
                          <span className="absolute -top-[3px] h-[15px] w-[2px] bg-gray-200" style={{ left: `${geo.zero}%` }} />
                        </>
                      )}
                    </span>
                    <span className="w-[76px] text-green-400 whitespace-nowrap">+{magLabel(mfe, mfeUnit)} <b className="text-gray-400 font-semibold">MFE</b></span>
                  </div>
                )}

                {after && (
                  <p className="text-[12.5px] text-gray-400" title={after.title}>
                    After exit: <span className={after.cls}>{after.text}</span>
                    {partialWindow && (
                      <span
                        className="ml-1.5 align-middle text-[10px] text-amber-400/80 border border-amber-700/50 rounded px-1 py-0.5"
                        title="The 15-minute window after the exit hasn't fully elapsed yet — this updates once it does."
                      >
                        partial window
                      </span>
                    )}
                  </p>
                )}
              </section>

              {/* Chart: the trader's screenshot, and Replay */}
              {(t.screenshot_url || deepDive || verdict) && (
                <section aria-label="Chart" className="space-y-2">
                  {t.screenshot_url && (
                    <PinPlacement imageUrl={t.screenshot_url} pins={pins} onZoom={() => setZoomed(t.screenshot_url)} />
                  )}
                  {(deepDive || verdict) && (
                    <div className="flex flex-wrap items-center gap-2">
                      {deepDive && (
                        <Link
                          href={`/review/replay?id=${t.id}`}
                          className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-md px-3 min-h-9 transition-colors"
                        >
                          <PlayCircle className="w-3.5 h-3.5" /> Replay this trade
                        </Link>
                      )}
                      {verdict && (
                        <span className="text-xs text-gray-500">
                          Your call on replay: <b className={CALL_CLASS[verdict.call]}>{verdict.call}</b>
                          {verdict.note ? <> — &ldquo;{verdict.note}&rdquo;</> : null}
                        </span>
                      )}
                    </div>
                  )}
                </section>
              )}

              {grade && grade.score != null && (
                <TradeGradeWhy grade={grade} neverWent={mgmt?.went === false} hasStop={plannedStopPrice(t) != null} />
              )}
            </>
          )}

          {/* Your log — editable in place */}
          <section aria-label="Your log" className={live ? 'space-y-3' : 'space-y-3 border-t border-gray-800 pt-3.5'}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>Your log</h3>
              <button
                type="button"
                onClick={() => leave(() => onOpenFullLog(t.id))}
                className="inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-blue-300 transition-colors"
                title="Replace the screenshot, re-read levels, change direction"
              >
                <ExternalLink className="w-3 h-3" /> Open full log
              </button>
            </div>
            <TradeForm
              key={t.id}
              compact
              hideScreenshot={!live}
              date={date}
              allTags={allTags}
              trade={t}
              defaultSymbol={defaultSymbol}
              onTagCreated={onTagCreated}
              onSave={saved => { dirtyRef.current = false; onSave(saved) }}
              onCancel={onClose}
              onDirtyChange={onDirtyChange}
            />
          </section>
        </div>
      </aside>

      <ScreenshotLightbox src={zoomed} onClose={() => setZoomed(null)} />
    </div>
  )
}
