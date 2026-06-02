'use client'

import { useEffect, useState } from 'react'
import type { MarketContext } from '@/lib/supabase/types'

type ContextFields = Omit<MarketContext, 'id' | 'trading_day_id' | 'stat_performance_json' | 'created_at'>

interface Props {
  value: Partial<ContextFields>
  onChange: (v: Partial<ContextFields>) => void
}

// Distribution stats for the three numeric stats below the input — drives the
// auto LOW/MID/HIGH pills. Fetched once on mount; cached in module-level state
// across remounts of the same prep session.
interface Distribution {
  count: number
  p33: number | null
  p67: number | null
  median: number | null
  min: number | null
  max: number | null
}
type DistMap = { rvol: Distribution; adr: Distribution; atr_1m: Distribution }
let cachedDist: DistMap | null = null

type Bucket = 'LOW' | 'MID' | 'HIGH'
function classify(value: number | null | undefined, dist: Distribution | undefined): Bucket | null {
  if (value == null || !Number.isFinite(value) || !dist || dist.p33 == null || dist.p67 == null) return null
  if (value < dist.p33) return 'LOW'
  if (value > dist.p67) return 'HIGH'
  return 'MID'
}

function DistributionPill({
  value, dist, lowGood,
}: {
  value: number | null | undefined
  dist: Distribution | undefined
  /** True when LOW is the "good" end of the distribution (e.g. low DR_ADR is good).
   *  Affects color only — the bucket label is unchanged. Default: HIGH = good. */
  lowGood?: boolean
}) {
  const bucket = classify(value, dist)
  if (!dist || dist.p33 == null) {
    return (
      <div className="mt-1 text-[10px] text-gray-600 font-mono">
        not enough history yet
      </div>
    )
  }
  const tone = bucket === 'MID'
    ? 'bg-yellow-900/40 border-yellow-800 text-yellow-200'
    : bucket === (lowGood ? 'LOW' : 'HIGH')
      ? 'bg-green-900/40 border-green-800 text-green-200'
      : bucket === (lowGood ? 'HIGH' : 'LOW')
        ? 'bg-red-900/40 border-red-800 text-red-200'
        : 'bg-gray-800 border-gray-700 text-gray-500'
  const fmt = (n: number | null) => n == null ? '—' : n.toFixed(n < 10 ? 2 : 0)
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${tone}`}>
        {bucket ?? '—'}
      </span>
      <span className="text-[10px] text-gray-500 font-mono">
        p33 {fmt(dist.p33)} · p67 {fmt(dist.p67)} · n={dist.count}
      </span>
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
  const [dist, setDist] = useState<DistMap | null>(cachedDist)
  // One-shot fetch on mount — cached in module scope so navigating between
  // prep days doesn't re-fetch. Distribution data is the same for every date.
  useEffect(() => {
    if (cachedDist) return
    fetch('/api/market-context/distribution')
      .then(r => r.json())
      .then((d: DistMap) => {
        cachedDist = d
        setDist(d)
      })
      .catch(() => { /* silent — pills will show "not enough history yet" */ })
  }, [])

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
          {/* Rvol — HIGH = good (more activity) */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <NumInput label="Rvol" hint="Relative Volume" value={value.rvol} onChange={r => set('rvol', r)} />
              <DistributionPill value={value.rvol as number | undefined} dist={dist?.rvol} />
            </div>
          </div>
          {/* ADR — HIGH = good (more range available) */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <NumInput label="ADR" hint="Avg Daily Range (RTH)" value={value.adr} onChange={r => set('adr', r)} />
              <DistributionPill value={value.adr as number | undefined} dist={dist?.adr} />
            </div>
          </div>
          {/* ATR-10 — HIGH = high volatility (neither inherently good nor bad);
              treating HIGH as red so big-ATR days flag a caution signal. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <NumInput label="ATR-10 (1m)" hint="1×ATR on 1min chart" value={value.atr_1m} onChange={r => set('atr_1m', r)} />
              <DistributionPill value={value.atr_1m as number | undefined} dist={dist?.atr_1m} lowGood />
            </div>
          </div>
        </div>
      </div>

    </div>
  )
}
