'use client'

import { useEffect, useState } from 'react'
import type { MarketContext } from '@/lib/supabase/types'
import { suggestFlag, type MetricBuckets, type MetricSuggestion } from '@/lib/metric-buckets'

type PerfFlag = 'red' | 'yellow' | 'green'
type ContextFields = Omit<MarketContext, 'id' | 'trading_day_id' | 'stat_performance_json' | 'created_at'>

interface AllBuckets {
  rvol: MetricBuckets
  adr: MetricBuckets
  ib_size: MetricBuckets
  atr_1m: MetricBuckets
  total_days: number
  date_range: { from: string; to: string } | null
}

interface Props {
  value: Partial<ContextFields>
  onChange: (v: Partial<ContextFields>) => void
}

const flagDefs = [
  { val: 'red' as PerfFlag, label: 'Bad', idle: 'border-gray-700 text-gray-500 hover:border-red-700', on: 'bg-red-700 border-red-600 text-white' },
  { val: 'yellow' as PerfFlag, label: 'Mid', idle: 'border-gray-700 text-gray-500 hover:border-yellow-600', on: 'bg-yellow-600 border-yellow-500 text-white' },
  { val: 'green' as PerfFlag, label: 'Good', idle: 'border-gray-700 text-gray-500 hover:border-green-700', on: 'bg-green-700 border-green-600 text-white' },
]

function FlagRow({
  value,
  onChange,
  suggestion,
}: {
  value: PerfFlag | null | undefined
  onChange: (v: PerfFlag | null) => void
  suggestion?: MetricSuggestion | null
}) {
  return (
    <div className="mt-1 space-y-1">
      {suggestion && <SuggestionHint suggestion={suggestion} />}
      <div className="flex gap-1">
        {flagDefs.map(({ val, label, idle, on }) => {
          const isSuggested = suggestion?.flag === val && value == null
          // Suggested-but-unselected gets a subtle ring so the eye lands on it
          // without committing to the value. Once the user clicks any flag,
          // the ring disappears so we don't double-signal.
          return (
            <button
              key={val}
              type="button"
              onClick={() => onChange(value === val ? null : val)}
              className={`flex-1 text-xs py-1 rounded border transition-colors ${value === val ? on : `bg-gray-800 ${idle}`} ${isSuggested ? 'ring-1 ring-offset-0 ring-blue-500/60' : ''}`}
              title={isSuggested
                ? `Historical bucket suggests "${label}" for today's value`
                : value === val
                  ? `Currently set to ${label}`
                  : undefined}
            >{label}</button>
          )
        })}
      </div>
    </div>
  )
}

/** Compact one-liner describing where today's value sits historically. */
function SuggestionHint({ suggestion }: { suggestion: MetricSuggestion }) {
  const tone = suggestion.flag === 'green'
    ? 'text-green-400'
    : suggestion.flag === 'yellow'
      ? 'text-yellow-400'
      : 'text-red-400'
  const tierLabel = suggestion.tier === 'low' ? 'low' : suggestion.tier === 'mid' ? 'mid' : 'high'
  const wr = (suggestion.win_rate * 100).toFixed(0)
  const pnl = suggestion.avg_pnl
  const pnlStr = `${pnl >= 0 ? '+' : ''}$${Math.round(pnl)}`
  return (
    <div className="text-[10px] text-gray-500 leading-tight" title={`Across ${suggestion.count} historical sessions where this metric was in the ${tierLabel} tercile.`}>
      <span>{tierLabel} tercile · </span>
      <span>{wr}% WR · {pnlStr} avg · n={suggestion.count}</span>
      <span className={`ml-1 font-semibold ${tone}`}>→ {suggestion.flag === 'green' ? 'Good' : suggestion.flag === 'yellow' ? 'Mid' : 'Bad'}</span>
    </div>
  )
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

export default function MarketContextForm({ value, onChange }: Props) {
  // Fetched once on mount. The bucket structure is computed across the
  // user's full session history and changes slowly, so a single fetch per
  // prep-page mount is fine. Failure is silent — no buckets means no
  // suggestion chips, the form continues to work manually.
  const [buckets, setBuckets] = useState<AllBuckets | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await fetch('/api/metric-buckets')
        if (!r.ok) return
        const data = await r.json() as AllBuckets
        if (!cancelled) setBuckets(data)
      } catch {
        /* network/server failure → no suggestions, form still works */
      }
    })()
    return () => { cancelled = true }
  }, [])

  const rvolSuggestion = buckets ? suggestFlag(value.rvol == null ? null : Number(value.rvol), buckets.rvol) : null
  const adrSuggestion = buckets ? suggestFlag(value.adr == null ? null : Number(value.adr), buckets.adr) : null
  const atrSuggestion = buckets ? suggestFlag(value.atr_1m == null ? null : Number(value.atr_1m), buckets.atr_1m) : null

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

  const setDirect = (key: keyof ContextFields, v: unknown) =>
    onChange({ ...value, [key]: v })

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
            <label className="block text-xs text-gray-400 mb-1">GBX % of ADR</label>
            <div className={`border rounded-lg px-3 py-2 text-sm transition-colors ${
              derivedGbxPctAdrNum != null && derivedGbxPctAdrNum > 100
                ? 'bg-green-950/40 border-green-700/60 text-green-300'
                : 'bg-gray-800 border-gray-700 text-gray-300'
            }`}>
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

      {/* Stats */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Stats</h3>
        <div className="space-y-3">
          {/* Rvol */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <NumInput label="Rvol" hint="Relative Volume" value={value.rvol} onChange={r => set('rvol', r)} />
              <FlagRow value={value.rvol_flag as PerfFlag | null | undefined} onChange={v => setDirect('rvol_flag', v)} suggestion={rvolSuggestion} />
            </div>
          </div>
          {/* ADR + GBX% of ADR side by side */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <NumInput label="ADR" hint="Avg Daily Range (RTH)" value={value.adr} onChange={r => set('adr', r)} />
              <FlagRow value={value.adr_flag as PerfFlag | null | undefined} onChange={v => setDirect('adr_flag', v)} suggestion={adrSuggestion} />
            </div>
          </div>
          {/* ATR */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <NumInput label="ATR-10 (1m)" hint="1×ATR on 1min chart" value={value.atr_1m} onChange={r => set('atr_1m', r)} />
              <FlagRow value={value.atr_flag as PerfFlag | null | undefined} onChange={v => setDirect('atr_flag', v)} suggestion={atrSuggestion} />
            </div>
          </div>
        </div>
      </div>

    </div>
  )
}
