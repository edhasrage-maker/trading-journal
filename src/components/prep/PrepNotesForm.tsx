'use client'

import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import AutoGrowTextarea from '@/components/AutoGrowTextarea'
import type { PrepNotes, PriceScenario } from '@/lib/supabase/types'

interface Props {
  value: PrepNotes
  onChange: (v: PrepNotes) => void
  ibh?: number | null
  ibl?: number | null
  ibSize?: number | null
  /** Show the owner's full methodology fields — IB Break Timing + IB Extensions,
   *  Volume Profile, the Above/Below HTF MGI table, and the market-clarity note.
   *  These are hidden in the simplified public/beginner prep, so PrepClient
   *  passes `isAdmin && mode === 'pro'` (Detailed Tape, owner only). Defaults to
   *  false so the public/beginner prep stays Bias / Observations / Mood. */
  showAdvanced?: boolean
  /** Beginner (Highlights) prep: swap the free-text Mood box for one-tap
   *  readiness chips (stored in the same `mood` field) and turn Observations
   *  into an optional one-liner. Keeps the input near zero-effort. PrepClient
   *  passes `mode !== 'pro'`. Defaults to false (Detailed Tape / owner). */
  beginner?: boolean
}

// "Still developing" is the default — it represents the pre-break state before
// the IB has resolved one way or the other. Listed first so it renders as the
// initial dropdown value when ib_behaviour has no saved value yet.
const IB_BREAK_TIMING_DEFAULT = 'Still developing'
const ibBreakTimingOptions = [IB_BREAK_TIMING_DEFAULT, 'Early (within first 15min)', 'Normal (15-60min)', 'Late (60min+)']
const volumeShapeOptions = ['Balanced (D-shape)', 'Skewed up (P-shape)', 'Skewed down (b-shape)', 'Trending (elongated)', 'Bimodal (double distribution)']
const biasOptions = ['bullish', 'bearish', 'neutral'] as const

// Discord-card "day stance" — the plain-language verdict a casual viewer reads
// first. Kept to three traffic-light states so it stays instantly legible.
const dayStanceOptions: { value: 'go' | 'caution' | 'avoid'; label: string; on: string }[] = [
  { value: 'go', label: 'Go', on: 'bg-emerald-600 border-emerald-500 text-white' },
  { value: 'caution', label: 'Caution', on: 'bg-amber-600 border-amber-500 text-white' },
  { value: 'avoid', label: 'Sit out', on: 'bg-red-600 border-red-500 text-white' },
]

const EXT_LEVELS = ['25', '50', '100'] as const
const EXT_MULT: Record<string, number> = { '25': 0.25, '50': 0.50, '100': 1.00 }

const HTF_MGI_LEVELS = ['PDH', 'PDL', 'ONH', 'ONL', 'IBH', 'IBL', 'HTF S/R', 'HTF S/D', 'WK-OP', 'PWH', 'PWL', 'VWAP', 'EMA']

// Beginner readiness chips — one-tap emotional state, stored in the `mood`
// field (single-select). Split so "clear" states read emerald and the
// cautionary flags read amber — a gentle affect-labeling cue, never alarming
// (no red). State is the single best predictor of a bad day; one tap beats a
// paragraph and gives the coach a structured signal.
const READINESS_CLEAR = ['Calm', 'Focused'] as const
const READINESS_FLAG = ['Tired', 'Anxious', 'Rushed', 'Tilted'] as const
const READINESS_CHIPS = [...READINESS_CLEAR, ...READINESS_FLAG] as const

const SLOPE_LEVELS: Record<string, { field: 'vwap_slope' | 'ema_slope'; label: string }> = {
  VWAP: { field: 'vwap_slope', label: 'slope' },
  EMA:  { field: 'ema_slope',  label: 'slope' },
}

type ExtKey = `${'above' | 'below'}_${string}`

function calcExts(ibh: number, ibl: number, ibSize: number) {
  const result: Record<ExtKey, { ext: number; retrace: number }> = {} as never
  for (const lvl of EXT_LEVELS) {
    const dist = ibSize * EXT_MULT[lvl]
    const extAbove = ibh + dist
    const extBelow = ibl - dist
    result[`above_${lvl}`] = { ext: extAbove, retrace: extAbove - dist * 0.30 }
    result[`below_${lvl}`] = { ext: extBelow, retrace: extBelow + dist * 0.30 }
  }
  return result
}

export default function PrepNotesForm({ value, onChange, ibh, ibl, ibSize, showAdvanced = false, beginner = false }: Props) {
  const [mgiOpen, setMgiOpen] = useState(false)
  const [extsOpen, setExtsOpen] = useState(false)
  const set = (key: keyof PrepNotes, val: unknown) => onChange({ ...value, [key]: val })

  // Auto-expand the IB extensions table when Break Timing flips to an active
  // value (Early / Normal / Late), and auto-collapse when it goes back to
  // "Still developing" (or unset). User can manually toggle in between via the
  // header — that override holds until the next Break Timing change.
  const breakTimingActive = !!value.ib_behaviour && value.ib_behaviour !== IB_BREAK_TIMING_DEFAULT
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync the extensions panel open-state to whether a break timing is set
    setExtsOpen(breakTimingActive)
  }, [breakTimingActive])

  const computedIbSize = ibSize ?? (ibh != null && ibl != null ? ibh - ibl : null)
  const exts = ibh != null && ibl != null && computedIbSize != null
    ? calcExts(ibh, ibl, computedIbSize)
    : null

  const toggleExt = (key: ExtKey) => {
    const reached = value.ib_extensions_reached ?? []
    const next = reached.includes(key) ? reached.filter(k => k !== key) : [...reached, key]
    set('ib_extensions_reached', next)
  }

  const setMgi = (level: string, pos: 'above' | 'below' | null) => {
    const mgi = { ...(value.htf_mgi ?? {}) }
    if (pos === null) delete mgi[level]
    else mgi[level] = pos
    set('htf_mgi', Object.keys(mgi).length > 0 ? mgi : undefined)
  }

  // "Where price can go" — favored + alt scenarios, keyed by role so each edit
  // upserts its one row (favored always rendered first). Empty rows persist while
  // editing; the Discord card filters out any with neither trigger nor target.
  const scenarios = value.price_scenarios ?? []
  const getScenario = (role: 'favored' | 'alt') => scenarios.find(s => s.role === role)
  const setScenario = (role: 'favored' | 'alt', patch: Partial<PriceScenario>) => {
    const existing = getScenario(role)
    const merged: PriceScenario = {
      role,
      direction: patch.direction ?? existing?.direction ?? (role === 'favored' ? 'down' : 'up'),
      trigger: patch.trigger ?? existing?.trigger ?? '',
      target: patch.target ?? existing?.target ?? '',
    }
    const next = [merged, ...scenarios.filter(s => s.role !== role)]
      .sort((a) => (a.role === 'favored' ? -1 : 1))
    set('price_scenarios', next)
  }

  const toggleReactive = (level: string) => {
    const reactive = value.htf_mgi_reactive ?? []
    const next = reactive.includes(level) ? reactive.filter(l => l !== level) : [...reactive, level]
    set('htf_mgi_reactive', next.length > 0 ? next : undefined)
  }

  return (
    <div className="space-y-6">

      {/* IB Break Timing + Volume Profile — owner methodology, Detailed Tape
          only. The public/beginner prep is simplified to Bias / Observations /
          Mood. */}
      {showAdvanced && (<>
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">IB Break Timing</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Break Timing</label>
            <select value={value.ib_behaviour || IB_BREAK_TIMING_DEFAULT} onChange={e => set('ib_behaviour', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              {ibBreakTimingOptions.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>

          {/* IB Extensions Table — collapsible. Auto-expands when Break Timing
              is Early/Normal/Late; collapsed by default when "Still developing". */}
          <div className="border border-gray-800 rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => setExtsOpen(o => !o)}
              className="w-full flex items-center justify-between px-4 py-3 bg-gray-800/50 hover:bg-gray-800 transition-colors"
            >
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Above / Below IB Extensions</h3>
                {!extsOpen && (value.ib_extensions_reached?.length ?? 0) > 0 && (
                  <span className="text-xs text-blue-400">{value.ib_extensions_reached!.length} reached</span>
                )}
              </div>
              {extsOpen ? <ChevronUp className="w-3.5 h-3.5 text-gray-500" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-500" />}
            </button>
            {extsOpen && (
              <div className="p-4">
                {exts ? (
                  <div className="space-y-3">
                    {(['above', 'below'] as const).map(dir => (
                      <div key={dir}>
                        <div className="text-xs text-gray-500 mb-1 font-medium">
                          {dir === 'above' ? `↑ Above IBH (${ibh})` : `↓ Below IBL (${ibl})`}
                        </div>
                        <div className="grid gap-1">
                          <div className="grid grid-cols-4 gap-1 text-xs text-gray-500 px-1">
                            <span>Ext</span><span>Price</span><span>Retrace (30%)</span><span className="text-center">Hit?</span>
                          </div>
                          {EXT_LEVELS.map(lvl => {
                            const key: ExtKey = `${dir}_${lvl}`
                            const data = exts[key]
                            const hit = value.ib_extensions_reached?.includes(key)
                            return (
                              <button key={key} type="button" onClick={() => toggleExt(key)}
                                className={`grid grid-cols-4 gap-1 text-sm px-2 py-1.5 rounded-lg border text-left transition-colors ${
                                  hit
                                    ? 'bg-blue-900/40 border-blue-600/50 text-white'
                                    : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500'
                                }`}
                              >
                                <span className={`font-medium ${hit ? 'text-blue-400' : 'text-gray-400'}`}>{lvl}%</span>
                                <span>{data.ext.toFixed(2)}</span>
                                <span className="text-gray-400">{data.retrace.toFixed(2)}</span>
                                <span className={`text-center ${hit ? 'text-blue-400' : 'text-gray-600'}`}>{hit ? '✓' : '○'}</span>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-gray-600 italic">Enter IBH, IBL (and IB Size) in Market Context to see auto-calculated extension levels.</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Volume Profile */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Volume Profile</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Profile Shape</label>
            <select value={value.volume_profile_shape ?? ''} onChange={e => set('volume_profile_shape', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              <option value="">Select...</option>
              {volumeShapeOptions.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Notes (low nodes, POC location, etc.)</label>
            <AutoGrowTextarea rows={2} spellCheck autoCorrect="on" placeholder="e.g. Low node at 19850, POC at 19900, clean accept above..."
              value={value.volume_profile_notes ?? ''} onChange={e => set('volume_profile_notes', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600 resize-none"
            />
          </div>
        </div>
      </div>
      </>)}

      {/* Bias — direction buttons. The "Bias reasoning" textarea moved BELOW
          the HTF MGI section so the trader fills it in after touching levels. */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Bias</h3>
        <div className="flex gap-2">
          {biasOptions.map(b => (
            <button key={b} type="button" onClick={() => set('bias', b)}
              className={`flex-1 py-2 rounded-lg text-sm font-medium capitalize transition-colors border ${
                value.bias === b
                  ? b === 'bullish' ? 'bg-green-600 border-green-500 text-white'
                  : b === 'bearish' ? 'bg-red-600 border-red-500 text-white'
                  : 'bg-gray-600 border-gray-500 text-white'
                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
              }`}
            >{b}</button>
          ))}
        </div>
      </div>

      {/* Discord card — Viewer read + Where price can go. Admin/owner only (the
          card these feed is itself admin-gated). Manual so the shared card stays
          meaningful even when the bar feed hasn't auto-filled the stats. */}
      {showAdvanced && (
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Discord card — viewer read</h3>
        <p className="text-xs text-gray-600 mb-3">Set automatically when you Analyze — change anything you don’t agree with.</p>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Day stance (AI-set — tap to override)</label>
            <div className="flex gap-2">
              {dayStanceOptions.map(o => (
                <button key={o.value} type="button"
                  onClick={() => set('day_stance', value.day_stance === o.value ? undefined : o.value)}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors border ${
                    value.day_stance === o.value ? o.on : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                  }`}
                >{o.label}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">One-line read (AI-set — edit to override)</label>
            <AutoGrowTextarea rows={1} spellCheck autoCorrect="on"
              placeholder="e.g. Choppy, low-energy open — let it pick a side first."
              value={value.day_read ?? ''} onChange={e => set('day_read', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600 resize-none"
            />
          </div>
        </div>

        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mt-5 mb-3">Where price can go</h3>
        <div className="space-y-2">
          {(['favored', 'alt'] as const).map(role => {
            const sc = getScenario(role)
            const dir = sc?.direction ?? (role === 'favored' ? 'down' : 'up')
            return (
              <div key={role} className="flex items-center gap-2">
                <span className={`w-16 shrink-0 text-xs font-semibold uppercase ${role === 'favored' ? 'text-blue-400' : 'text-gray-500'}`}>
                  {role === 'favored' ? 'Plan A' : 'Plan B'}
                </span>
                <button type="button"
                  onClick={() => setScenario(role, { direction: dir === 'up' ? 'down' : 'up' })}
                  className={`w-9 shrink-0 py-1.5 rounded-lg text-sm font-bold border transition-colors ${
                    dir === 'up' ? 'bg-green-700 border-green-600 text-white' : 'bg-red-800 border-red-700 text-white'
                  }`}
                  title="Toggle direction"
                >{dir === 'up' ? '▲' : '▼'}</button>
                <input type="text" placeholder="trigger (e.g. 28910)"
                  value={sc?.trigger ?? ''} onChange={e => setScenario(role, { trigger: e.target.value })}
                  className="flex-1 min-w-0 bg-gray-800 border border-gray-700 text-white rounded-lg px-2.5 py-1.5 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <span className="shrink-0 text-gray-500 text-sm">→</span>
                <input type="text" placeholder="target (e.g. 28710)"
                  value={sc?.target ?? ''} onChange={e => setScenario(role, { target: e.target.value })}
                  className="flex-1 min-w-0 bg-gray-800 border border-gray-700 text-white rounded-lg px-2.5 py-1.5 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            )
          })}
        </div>
      </div>
      )}

      {/* HTF MGI Position — owner's methodology, Detailed Tape only (showAdvanced
          = isAdmin && mode==='pro'). Hidden in the simplified public/beginner prep. */}
      {showAdvanced && (
      <div className="border border-gray-800 rounded-xl overflow-hidden">
        <button
          type="button"
          onClick={() => setMgiOpen(o => !o)}
          className="w-full flex items-center justify-between px-4 py-3 bg-gray-800/50 hover:bg-gray-800 transition-colors"
        >
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Above / Below HTF MGI</h3>
            {!mgiOpen && value.htf_mgi && Object.keys(value.htf_mgi).length > 0 && (
              <span className="text-xs text-blue-400">
                {Object.keys(value.htf_mgi).length} tagged
                {(value.htf_mgi_reactive?.length ?? 0) > 0 && ` · ${value.htf_mgi_reactive!.length} reactive`}
              </span>
            )}
          </div>
          {mgiOpen ? <ChevronUp className="w-3.5 h-3.5 text-gray-500" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-500" />}
        </button>
        {mgiOpen && (
          <div className="p-4 space-y-1.5">
            {/* Column headers */}
            <div className="grid grid-cols-[6rem_1fr_1fr_auto] gap-1 px-1 mb-1">
              <span />
              <span className="text-xs text-gray-600 text-center">Above</span>
              <span className="text-xs text-gray-600 text-center">Below</span>
              <span className="text-xs text-gray-600 text-center w-16">Reactive?</span>
            </div>
            {HTF_MGI_LEVELS.map(level => {
              const pos = value.htf_mgi?.[level] ?? null
              const isReactive = value.htf_mgi_reactive?.includes(level) ?? false
              const slopeCfg = SLOPE_LEVELS[level] ?? null
              return (
                <div key={level} className="space-y-1">
                  <div className="grid grid-cols-[6rem_1fr_1fr_auto] gap-1 items-center">
                    <span className="text-xs font-medium text-gray-300">{level}</span>
                    {(['above', 'below'] as const).map(side => (
                      <button key={side} type="button"
                        onClick={() => setMgi(level, pos === side ? null : side)}
                        className={`py-1 text-xs rounded border font-medium transition-colors ${
                          pos === side
                            ? side === 'above'
                              ? 'bg-green-700 border-green-600 text-white'
                              : 'bg-red-700 border-red-600 text-white'
                            : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                        }`}
                      >{side === 'above' ? '▲' : '▼'}</button>
                    ))}
                    <div className="flex justify-center w-16">
                      <button type="button" onClick={() => toggleReactive(level)}
                        className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                          isReactive
                            ? 'bg-yellow-500 border-yellow-400 text-black'
                            : 'bg-gray-800 border-gray-600 text-gray-600 hover:border-gray-400'
                        }`}
                        title="Mark as reactive"
                      >
                        {isReactive ? <span className="text-xs font-bold leading-none">✓</span> : null}
                      </button>
                    </div>
                  </div>
                  {/* VWAP / EMA: flat vs sloped sub-row */}
                  {slopeCfg && (
                    <div className="grid grid-cols-[6rem_1fr_1fr_auto] gap-1 items-center">
                      <span className="text-xs text-gray-500 pl-1">{slopeCfg.label}</span>
                      {(['flat', 'sloped'] as const).map(slope => (
                        <button key={slope} type="button"
                          onClick={() => set(slopeCfg.field, value[slopeCfg.field] === slope ? undefined : slope)}
                          className={`py-1 text-xs rounded border font-medium transition-colors ${
                            value[slopeCfg.field] === slope
                              ? 'bg-blue-700 border-blue-600 text-white'
                              : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                          }`}
                        >{slope === 'flat' ? '— Flat' : '↗ Sloped'}</button>
                      ))}
                      <div className="w-16" />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      )}

      {/* Bias reasoning — moved BELOW HTF MGI so the trader writes it after
          working through the levels above. Reasoning often references which
          MGI levels the bias is built on. */}
      <div>
        <label className="block text-xs text-gray-400 mb-1">
          {beginner ? 'Anything on your mind? (optional)' : 'Observations / reasoning'}
        </label>
        <AutoGrowTextarea rows={beginner ? 1 : 2} spellCheck autoCorrect="on"
          placeholder={beginner ? 'One line — why this bias, or what you’re watching.' : 'What are you seeing? Why this bias, and what would change it?'}
          value={value.bias_notes ?? ''} onChange={e => set('bias_notes', e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600 resize-none"
        />
      </div>

      {/* Mood & Clarity */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Mood</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">How are you feeling today?</label>
            {beginner ? (
              /* One-tap readiness — single-select, stored in `mood`. Tap the
                 selected chip again to clear. Free-text mood from a prior
                 Detailed-Tape prep won't match a chip (nothing selected) until
                 the trader taps one, which overwrites it. */
              <div className="flex flex-wrap gap-2">
                {READINESS_CHIPS.map(chip => {
                  const selected = value.mood === chip
                  const isFlag = (READINESS_FLAG as readonly string[]).includes(chip)
                  return (
                    <button key={chip} type="button"
                      onClick={() => set('mood', selected ? '' : chip)}
                      className={`px-3.5 py-2 rounded-full text-sm font-medium border transition-colors ${
                        selected
                          ? isFlag
                            ? 'bg-amber-600 border-amber-500 text-white'
                            : 'bg-emerald-600 border-emerald-500 text-white'
                          : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                      }`}
                    >{chip}</button>
                  )
                })}
              </div>
            ) : (
              <AutoGrowTextarea rows={2} spellCheck autoCorrect="on" placeholder="Be honest. Any stress, fatigue, emotional events affecting you?"
                value={value.mood ?? ''} onChange={e => set('mood', e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600 resize-none"
              />
            )}
          </div>
          {showAdvanced && (
          <div>
            <label className="block text-xs text-gray-400 mb-1">Does the market feel clear to you?</label>
            <AutoGrowTextarea rows={2} spellCheck autoCorrect="on" placeholder="Can you clearly see what the market is doing and what setups to take?"
              value={value.market_clarity ?? ''} onChange={e => set('market_clarity', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600 resize-none"
            />
          </div>
          )}
        </div>
      </div>

    </div>
  )
}
