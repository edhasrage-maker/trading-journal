'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { MarketContext } from '@/lib/supabase/types'

type ContextFields = Omit<MarketContext, 'id' | 'trading_day_id' | 'stat_performance_json' | 'created_at'>

interface Props {
  value: Partial<ContextFields>
  onChange: (v: Partial<ContextFields>) => void
}

function YesNoToggle({ label, value, onChange }: { label: string; value: boolean | null | undefined; onChange: (v: boolean | null) => void }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      <div className="flex gap-1">
        {([true, false] as const).map(v => (
          <button key={String(v)} type="button"
            onClick={() => onChange(value === v ? null : v)}
            className={`flex-1 py-2 text-xs rounded-lg border font-medium transition-colors ${
              value === v
                ? v ? 'bg-green-700 border-green-600 text-white' : 'bg-red-700 border-red-600 text-white'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
            }`}
          >{v ? 'Yes' : 'No'}</button>
        ))}
      </div>
    </div>
  )
}

function NumInput({ label, hint, value, onChange }: { label: string; hint?: string; value: number | string | null | undefined; onChange: (raw: string) => void }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      <input type="number" step="any" placeholder={hint} value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
      />
    </div>
  )
}

/**
 * DR_ADR input — accepts the ratio (e.g. 0.82) or a percent (82 → 0.82).
 * The displayed placeholder + suffix make the percent interpretation
 * obvious. Persists as `day_range = ratio × adr` so the Morning Conditions
 * panel + condition lookup keep working off the same field they already
 * read. Requires ADR to be set first — disabled with a hint otherwise.
 */
function DrAdrInput({
  dayRange, adr, onChange,
}: {
  dayRange: number | null | undefined
  adr: number | null | undefined
  onChange: (ratio: number | null) => void
}) {
  const adrNum = adr == null ? null : Number(adr)
  const adrUsable = adrNum != null && adrNum > 0
  const currentRatio = adrUsable && dayRange != null ? Number(dayRange) / adrNum : null
  const display = currentRatio == null ? '' : currentRatio.toFixed(2)
  const placeholder = adrUsable ? '0.82  ·  shown as 82%' : 'set ADR first'

  const onInput = (raw: string) => {
    if (raw === '') { onChange(null); return }
    let n = parseFloat(raw)
    if (!Number.isFinite(n)) return
    // Tolerate the user typing "82" when they meant 0.82 — anything > 5 is
    // assumed to be a percent, divide by 100. Below 5, treat as ratio.
    if (n > 5) n = n / 100
    onChange(n)
  }

  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1" title="(Day's high − low since 6:30 PT) / ADR">
        DR_ADR
      </label>
      <input
        type="number"
        step="any"
        placeholder={placeholder}
        value={display}
        disabled={!adrUsable}
        onChange={e => onInput(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
      />
    </div>
  )
}

export default function MarketContextForm({ value, onChange }: Props) {
  // Bad/Mid/Good per-metric flags + the metric-buckets fetch that fed
  // them used to live here — both removed 2026-06-08 as part of
  // consolidating with the Morning Conditions panel below. If you need
  // historical-bucket classification, that panel does it (with median +
  // tertile views, multi-metric verdict, override dropdown).

  // Volatility Metrics is collapsible — the section is informational and
  // takes vertical space the trader doesn't need to see once values are
  // entered. Default OPEN on days where any volatility value is empty so
  // the trader sees what's missing; default COLLAPSED when fully filled.
  const allVolFilled =
    value.rvol != null && value.adr != null && value.atr_1m != null &&
    value.day_range != null
  const [volOpen, setVolOpen] = useState(!allVolFilled)

  const set = (key: keyof ContextFields, raw: string) => {
    const num = parseFloat(raw)
    const parsed = raw === '' ? undefined : isNaN(num) ? raw : num
    const updated: Partial<ContextFields> = { ...value, [key]: parsed }

    // Auto-derive GBX % of ADR when ONH/ONL/ADR change
    if (key === 'onh' || key === 'onl' || key === 'adr') {
      const onh = key === 'onh' ? (parsed as number | undefined) : (value.onh as number | undefined)
      const onl = key === 'onl' ? (parsed as number | undefined) : (value.onl as number | undefined)
      const adr = key === 'adr' ? (parsed as number | undefined) : (value.adr as number | undefined)
      if (onh != null && onl != null && adr != null && adr > 0) {
        updated.gbx_pct_adr = parseFloat(((onh - onl) / adr * 100).toFixed(2))
      }
    }
    // Auto-derive IB vs 10d Avg ratio when IB Size or IB 10d Avg change.
    // Stored as a ratio (1.30 = 30% above); the display layer formats as %.
    if (key === 'ib_size' || key === 'ib_10d_avg') {
      const ibSize = key === 'ib_size' ? (parsed as number | undefined) : (value.ib_size as number | undefined)
      const ibAvg = key === 'ib_10d_avg' ? (parsed as number | undefined) : (value.ib_10d_avg as number | undefined)
      if (ibSize != null && ibAvg != null && ibAvg > 0) {
        updated.ib_vs_10d_avg = parseFloat((ibSize / ibAvg).toFixed(4))
      }
    }
    onChange(updated)
  }

  const setBool = (key: keyof ContextFields, v: boolean | null) =>
    onChange({ ...value, [key]: v === null ? undefined : v })

  const gbxRange = value.onh != null && value.onl != null ? Number(value.onh) - Number(value.onl) : null
  const derivedGbxPctAdrNum = gbxRange != null && value.adr != null && Number(value.adr) > 0
    ? gbxRange / Number(value.adr) * 100
    : null
  // IB vs 10d Avg expressed as a percentage. Storage is still a ratio
  // (1.30 = 30% above) per the schema's numeric(6,2); display layer
  // multiplies by 100.
  const derivedIbPctNum = value.ib_size != null && value.ib_10d_avg != null && Number(value.ib_10d_avg) > 0
    ? Number(value.ib_size) / Number(value.ib_10d_avg) * 100
    : null

  return (
    <div className="space-y-6">

      {/* Prior Day */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Prior Day</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <NumInput label="PDH" hint="Prior Day High" value={value.pdh} onChange={r => set('pdh', r)} />
          <NumInput label="PDL" hint="Prior Day Low" value={value.pdl} onChange={r => set('pdl', r)} />
          <YesNoToggle label="Price between PDH/PDL?" value={value.price_in_pd_range} onChange={v => setBool('price_in_pd_range', v)} />
        </div>
      </div>

      {/* Overnight (GBX) */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
          Overnight (GBX)
          {gbxRange != null && (
            <span className="ml-2 text-blue-400 font-normal normal-case">Range: {gbxRange.toFixed(2)}</span>
          )}
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <NumInput label="ONH" hint="Overnight High" value={value.onh} onChange={r => set('onh', r)} />
          <NumInput label="ONL" hint="Overnight Low" value={value.onl} onChange={r => set('onl', r)} />
          <YesNoToggle label="Price in GBX range?" value={value.price_in_gbx_range} onChange={v => setBool('price_in_gbx_range', v)} />
          <div>
            <label className="block text-xs text-gray-400 mb-1" title="Globex range / ADR. <60% = room to run, 60–90% = significant range used, >90% = exhaustion risk (mean-reversion more likely).">
              GBX % of ADR
            </label>
            <div
              className={`border rounded-lg px-3 py-2 text-sm transition-colors ${
                derivedGbxPctAdrNum == null
                  ? 'bg-gray-800 border-gray-700 text-gray-300'
                  : derivedGbxPctAdrNum >= 90
                    ? 'bg-red-950/40 border-red-700/60 text-red-300'
                    : derivedGbxPctAdrNum >= 60
                      ? 'bg-yellow-950/40 border-yellow-700/60 text-yellow-300'
                      : 'bg-green-950/40 border-green-700/60 text-green-300'
              }`}
              title={
                derivedGbxPctAdrNum == null
                  ? 'Auto-derived from ONH − ONL ÷ ADR. Fill in ONH, ONL and ADR to see it.'
                  : derivedGbxPctAdrNum >= 90
                    ? 'Overnight has consumed most of the expected daily range — favor mean reversion and beware of further trend expansion.'
                    : derivedGbxPctAdrNum >= 60
                      ? 'Significant range already used — pick spots, don\'t chase.'
                      : 'Plenty of expected daily range left — room for directional moves.'
              }
            >
              {derivedGbxPctAdrNum != null ? `${derivedGbxPctAdrNum.toFixed(1)}%` : '—'}
              <span className="text-gray-600 text-xs ml-1">(auto)</span>
            </div>
          </div>
        </div>
      </div>

      {/* Initial Balance */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Initial Balance</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <NumInput label="IBH" hint="IB High" value={value.ibh} onChange={r => set('ibh', r)} />
          <NumInput label="IBL" hint="IB Low" value={value.ibl} onChange={r => set('ibl', r)} />
          <NumInput label="IB Size" hint="Points" value={value.ib_size} onChange={r => set('ib_size', r)} />
          <NumInput label="IB 10d Avg" hint="Raw 10-day average" value={value.ib_10d_avg} onChange={r => set('ib_10d_avg', r)} />
          <div>
            <label className="block text-xs text-gray-400 mb-1">IB vs 10d Avg</label>
            <div className={`border rounded-lg px-3 py-2 text-sm transition-colors ${
              derivedIbPctNum != null && derivedIbPctNum > 100
                ? 'bg-green-950/40 border-green-700/60 text-green-300'
                : 'bg-gray-800 border-gray-700 text-gray-300'
            }`}>
              {derivedIbPctNum != null ? `${derivedIbPctNum.toFixed(0)}%` : '—'}
              <span className="text-gray-600 text-xs ml-1">(auto)</span>
            </div>
          </div>
        </div>
      </div>

      {/* Volatility metrics — numeric inputs only. Collapsible: the panel
          above (Morning Conditions) already shows these values, so once
          they're filled there's no reason to keep this section unfurled.
          DR_ADR is shown as the 4th input alongside Rvol/ADR/ATR-10;
          internally it stores as `day_range = ratio × adr` so the rest
          of the app (Morning Conditions, condition lookup) keeps working
          off the same `value.day_range` field. */}
      <div>
        <button
          type="button"
          onClick={() => setVolOpen(o => !o)}
          className="w-full flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 hover:text-gray-300 transition-colors"
        >
          <ChevronDown className={`w-3 h-3 transition-transform ${volOpen ? '' : '-rotate-90'}`} />
          Volatility metrics
          {!volOpen && (
            <span className="ml-auto font-normal normal-case text-[10px] text-gray-600">
              click to edit
            </span>
          )}
        </button>
        {volOpen && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <NumInput label="Rvol" hint="Relative Volume" value={value.rvol} onChange={r => set('rvol', r)} />
            <NumInput label="ADR" hint="Avg Daily Range (RTH)" value={value.adr} onChange={r => set('adr', r)} />
            <NumInput label="ATR-10 (1m)" hint="1×ATR on 1min chart" value={value.atr_1m} onChange={r => set('atr_1m', r)} />
            <DrAdrInput
              dayRange={value.day_range as number | null | undefined}
              adr={value.adr as number | null | undefined}
              onChange={ratio => {
                const adr = value.adr == null ? null : Number(value.adr)
                if (ratio == null) {
                  onChange({ ...value, day_range: undefined })
                  return
                }
                if (adr == null || !(adr > 0)) {
                  // Without ADR we can't store the raw day_range; leave it
                  // and surface the dependency in the input's hint.
                  return
                }
                onChange({ ...value, day_range: parseFloat((ratio * adr).toFixed(2)) })
              }}
            />
          </div>
        )}
      </div>

    </div>
  )
}
