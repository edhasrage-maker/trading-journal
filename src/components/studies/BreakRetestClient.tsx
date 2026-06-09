'use client'

/**
 * Break-and-Retest study UI.
 *
 * Lets the user replay every trade tagged with a break/retest-ish label
 * against actual 1-min market data and split out the TRUE break-and-retest
 * trades from the rejection trades (price never broke the level).
 *
 * Thresholds default to NQ-tuned values (5pt proximity, 2pt break buffer,
 * 3pt retest proximity) — exposed in the Advanced panel so the user can
 * tune until the classifications match their intuition.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { format, subMonths } from 'date-fns'
import type { BreakRetestVerdict, BreakRetestConfig } from '@/lib/studies/break-retest-classifier'
import type { ClassifiedTrade } from '@/app/api/studies/break-retest/route'

interface VerdictBucket { count: number; wins: number; losses: number; totalPnl: number; winRate: number; avgPnl: number }
interface ApiResponse {
  matchedTags: string[]
  missingBarDays: string[]
  classified: ClassifiedTrade[]
  summary: Record<BreakRetestVerdict, VerdictBucket>
  config: BreakRetestConfig
}

const VERDICT_META: Record<BreakRetestVerdict, { label: string; tone: string; help: string }> = {
  TRUE_BREAK_RETEST:    { label: 'True Break & Retest',  tone: 'bg-green-900/30 border-green-700 text-green-300',     help: 'Level broke, retested, trade direction matches the break.' },
  REJECTION_OFF_LEVEL:  { label: 'Rejection (no break)', tone: 'bg-red-900/30 border-red-700 text-red-300',           help: 'Price approached the level but never broke it. Trade is a rejection / S-R hold, NOT a true B&R.' },
  BREAK_NO_RETEST:      { label: 'Break, no retest',     tone: 'bg-amber-900/30 border-amber-700 text-amber-300',     help: 'Level broke but price never returned to retest before entry. Chase / late entry.' },
  REVERSAL_AFTER_BREAK: { label: 'Faded the break',      tone: 'bg-purple-900/30 border-purple-700 text-purple-300',  help: 'Level broke and retested, but trade direction fades the break (failed-breakout play).' },
  NO_NEARBY_LEVEL:      { label: 'No nearby level',      tone: 'bg-gray-800 border-gray-700 text-gray-300',           help: "Entry isn't within proximity of any tracked level. Tag may refer to a manually drawn S/R, VAH/VAL, etc." },
  AMBIGUOUS:            { label: 'Ambiguous',            tone: 'bg-gray-800 border-gray-700 text-gray-400',           help: 'Level was never broken AND trade direction doesn\'t match a clean rejection pattern.' },
}

const RANGE_OPTIONS: { label: string; months: number }[] = [
  { label: '1M', months: 1 },
  { label: '3M', months: 3 },
  { label: '6M', months: 6 },
  { label: '1Y', months: 12 },
  { label: 'All', months: 0 },
]

export default function BreakRetestClient() {
  const [rangeMonths, setRangeMonths] = useState(3)
  const [config, setConfig] = useState<BreakRetestConfig>({
    proximityPoints: 5,
    breakBufferPoints: 2,
    retestProximityPoints: 3,
  })
  const [resp, setResp] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [verdictFilter, setVerdictFilter] = useState<BreakRetestVerdict | 'ALL'>('ALL')
  const [showAdvanced, setShowAdvanced] = useState(false)

  const today = format(new Date(), 'yyyy-MM-dd')
  const startDate = useMemo(() => {
    if (rangeMonths === 0) return undefined
    return format(subMonths(new Date(), rangeMonths), 'yyyy-MM-dd')
  }, [rangeMonths])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoading(true)
      setErr(null)
      try {
        const params = new URLSearchParams()
        if (startDate) params.set('startDate', startDate)
        params.set('endDate', today)
        params.set('proximity', String(config.proximityPoints))
        params.set('breakBuffer', String(config.breakBufferPoints))
        params.set('retestProx', String(config.retestProximityPoints))
        const r = await fetch(`/api/studies/break-retest?${params}`)
        const j = await r.json()
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
        if (!cancelled) setResp(j as ApiResponse)
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => { cancelled = true }
  }, [startDate, today, config])

  const filteredTrades = useMemo(() => {
    if (!resp) return []
    if (verdictFilter === 'ALL') return resp.classified
    return resp.classified.filter(t => t.result?.verdict === verdictFilter)
  }, [resp, verdictFilter])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Break & Retest Study</h1>
          <p className="text-gray-400 text-sm mt-1">
            Replays each break/retest-tagged trade against 1-min market data to separate true B&amp;R from rejection trades.
          </p>
        </div>
        <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
          {RANGE_OPTIONS.map(o => (
            <button
              key={o.label}
              onClick={() => setRangeMonths(o.months)}
              className={`px-3 py-1 text-xs rounded ${rangeMonths === o.months ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* Threshold panel */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <button
          onClick={() => setShowAdvanced(v => !v)}
          className="text-sm text-gray-300 hover:text-white flex items-center gap-2"
        >
          <span>{showAdvanced ? '▾' : '▸'}</span>
          <span>Thresholds (NQ-tuned)</span>
          <span className="text-gray-500 text-xs">
            proximity {config.proximityPoints}pt · break buffer {config.breakBufferPoints}pt · retest {config.retestProximityPoints}pt
          </span>
        </button>
        {showAdvanced && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
            <NumField label="Proximity (pt)" help="Max distance from entry to a level to call that level the anchor." value={config.proximityPoints} onChange={v => setConfig({ ...config, proximityPoints: v })} />
            <NumField label="Break buffer (pt)" help="A 1-min bar must CLOSE past the level by this much to count as broken (filters wick pokes)." value={config.breakBufferPoints} onChange={v => setConfig({ ...config, breakBufferPoints: v })} />
            <NumField label="Retest proximity (pt)" help="After a break, price must return within this many points to count as a retest." value={config.retestProximityPoints} onChange={v => setConfig({ ...config, retestProximityPoints: v })} />
          </div>
        )}
      </div>

      {loading && <div className="text-gray-500 text-sm">Replaying market data…</div>}
      {err && <div className="bg-red-900/20 border border-red-800 text-red-300 rounded-lg p-3 text-sm">Error: {err}</div>}

      {resp && (
        <>
          {/* Matched tags chip row */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">
              Matched tag labels ({resp.matchedTags.length})
            </div>
            {resp.matchedTags.length === 0
              ? <div className="text-gray-500 text-sm">No break/retest-ish tags found in your tag library.</div>
              : <div className="flex flex-wrap gap-1.5">
                  {resp.matchedTags.map(t => (
                    <span key={t} className="px-2 py-0.5 text-xs rounded bg-gray-800 border border-gray-700 text-gray-300">{t}</span>
                  ))}
                </div>
            }
          </div>

          {/* Missing bar data warning */}
          {resp.missingBarDays.length > 0 && (
            <div className="bg-amber-900/20 border border-amber-800 rounded-lg p-3 text-sm text-amber-300">
              <div className="font-medium mb-1">Bar data missing for {resp.missingBarDays.length} day(s) — those trades skipped:</div>
              <div className="text-xs text-amber-400/80">{resp.missingBarDays.join(', ')}</div>
              <div className="text-xs text-amber-400/60 mt-1">Import via Settings → Bar Data to include them.</div>
            </div>
          )}

          {/* Summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            <SummaryCard
              key="ALL"
              label="All classified"
              tone="bg-blue-900/30 border-blue-700 text-blue-300"
              count={resp.classified.filter(c => c.result).length}
              winRate={null}
              totalPnl={resp.classified.reduce((s, c) => s + (c.pnl ?? 0), 0)}
              active={verdictFilter === 'ALL'}
              onClick={() => setVerdictFilter('ALL')}
            />
            {(Object.keys(VERDICT_META) as BreakRetestVerdict[]).map(v => (
              <SummaryCard
                key={v}
                label={VERDICT_META[v].label}
                tone={VERDICT_META[v].tone}
                count={resp.summary[v].count}
                winRate={resp.summary[v].count > 0 ? resp.summary[v].winRate : null}
                totalPnl={resp.summary[v].totalPnl}
                active={verdictFilter === v}
                onClick={() => setVerdictFilter(verdictFilter === v ? 'ALL' : v)}
                help={VERDICT_META[v].help}
              />
            ))}
          </div>

          {/* Trade table */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
              <div className="text-sm text-gray-300">
                {filteredTrades.length} trade{filteredTrades.length === 1 ? '' : 's'}
                {verdictFilter !== 'ALL' && <span className="text-gray-500"> · filtered to {VERDICT_META[verdictFilter].label}</span>}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wider text-gray-500 border-b border-gray-800">
                    <th className="text-left px-4 py-2">Date</th>
                    <th className="text-left px-3 py-2">Entry</th>
                    <th className="text-left px-3 py-2">Dir</th>
                    <th className="text-right px-3 py-2">PnL</th>
                    <th className="text-left px-3 py-2">Tag</th>
                    <th className="text-left px-3 py-2">Verdict</th>
                    <th className="text-left px-3 py-2">Anchor</th>
                    <th className="text-left px-3 py-2">Reasoning</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTrades.length === 0 && (
                    <tr><td colSpan={8} className="text-center text-gray-500 py-8">No trades match.</td></tr>
                  )}
                  {filteredTrades.map(t => {
                    const v = t.result?.verdict
                    const meta = v ? VERDICT_META[v] : null
                    return (
                      <tr key={t.id} className="border-b border-gray-800/60 hover:bg-gray-800/30">
                        <td className="px-4 py-2 text-gray-300 whitespace-nowrap">
                          <Link href={`/intraday/${t.date}`} className="text-blue-400 hover:text-blue-300">{t.date}</Link>
                        </td>
                        <td className="px-3 py-2 text-gray-400 whitespace-nowrap">
                          {t.entry_price?.toFixed(2) ?? '—'}
                          <span className="text-xs text-gray-600 ml-1">
                            @ {t.entry_time ? format(new Date(t.entry_time), 'HH:mm') : '—'}
                          </span>
                        </td>
                        <td className={`px-3 py-2 ${t.direction === 'long' ? 'text-green-400' : t.direction === 'short' ? 'text-red-400' : 'text-gray-500'}`}>
                          {t.direction ?? '—'}
                        </td>
                        <td className={`px-3 py-2 text-right whitespace-nowrap ${(t.pnl ?? 0) > 0 ? 'text-green-400' : (t.pnl ?? 0) < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                          {t.pnl != null ? `$${t.pnl.toFixed(2)}` : '—'}
                        </td>
                        <td className="px-3 py-2 text-gray-400 text-xs">{t.matched_tag}</td>
                        <td className="px-3 py-2">
                          {meta ? (
                            <span className={`px-2 py-0.5 text-xs rounded border ${meta.tone}`}>{meta.label}</span>
                          ) : (
                            <span className="text-xs text-gray-600">skipped</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-gray-400 text-xs whitespace-nowrap">
                          {t.result?.anchor
                            ? <>{t.result.anchor.name} <span className="text-gray-600">@ {t.result.anchor.value.toFixed(2)}</span></>
                            : '—'}
                        </td>
                        <td className="px-3 py-2 text-gray-500 text-xs max-w-md">
                          {t.result?.reasoning ?? t.skip_reason ?? ''}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function NumField({ label, help, value, onChange }: { label: string; help: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <input
        type="number"
        step="0.25"
        min="0.25"
        value={value}
        onChange={e => {
          const n = Number(e.target.value)
          if (Number.isFinite(n) && n > 0) onChange(n)
        }}
        className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white"
      />
      <div className="text-xs text-gray-600 mt-1">{help}</div>
    </label>
  )
}

function SummaryCard({
  label, tone, count, winRate, totalPnl, active, onClick, help,
}: {
  label: string; tone: string; count: number; winRate: number | null; totalPnl: number;
  active: boolean; onClick: () => void; help?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={help}
      className={`text-left rounded-lg border p-3 transition-all ${tone} ${active ? 'ring-2 ring-blue-500' : 'hover:brightness-110'}`}
    >
      <div className="text-xs uppercase tracking-wider opacity-80">{label}</div>
      <div className="text-xl font-bold mt-1">{count}</div>
      <div className="text-xs opacity-80 mt-1 flex gap-3">
        {winRate != null && <span>WR {(winRate * 100).toFixed(0)}%</span>}
        <span>${totalPnl.toFixed(0)}</span>
      </div>
    </button>
  )
}
