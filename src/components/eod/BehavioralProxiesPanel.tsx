'use client'

import { useMemo } from 'react'
import { Activity } from 'lucide-react'
import { computeBehavioralProxies, type ProxyTrade, type ProxySeverity } from '@/lib/behavioral-proxies'

/**
 * Session-behavior readout — derives tilt/revenge re-entries, shrinking hold
 * time, stacking one direction, and pressing size into a drawdown from the
 * day's fill sequence (no planned stop or tags needed). Renders a steady-session
 * note when nothing fires, so a clean day gets positive reinforcement.
 */

const TONE: Record<Exclude<ProxySeverity, 'none'>, { dot: string; text: string; bg: string; border: string }> = {
  flag: { dot: 'bg-amber-400', text: 'text-amber-200', bg: 'rgba(224,163,60,0.09)', border: 'rgba(224,163,60,0.32)' },
  mild: { dot: 'bg-gray-400', text: 'text-gray-300', bg: 'rgba(107,114,128,0.10)', border: 'rgba(107,114,128,0.30)' },
}

export default function BehavioralProxiesPanel({ trades }: { trades: ProxyTrade[] }) {
  const { tradeCount, hasSignal, proxies } = useMemo(
    () => computeBehavioralProxies(trades),
    [trades],
  )
  if (tradeCount < 2) return null

  const signals = proxies.filter(p => p.severity !== 'none')

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-3">
        <Activity className="w-3.5 h-3.5" />
        Session behavior · {tradeCount} trade{tradeCount === 1 ? '' : 's'} · derived from your fills
      </div>

      {!hasSignal ? (
        <div
          className="rounded-lg px-3 py-2.5 border"
          style={{ background: 'rgba(52,211,153,0.08)', borderColor: 'rgba(52,211,153,0.30)' }}
        >
          <p className="text-[13px] leading-relaxed text-green-200">
            No tilt, stacking, or hold-time drift detected — a steady, patient session.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {signals.map(p => {
            const tone = TONE[p.severity as 'flag' | 'mild']
            return (
              <div
                key={p.key}
                className="rounded-lg px-3 py-2 border flex items-start gap-2.5"
                style={{ background: tone.bg, borderColor: tone.border }}
              >
                <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${tone.dot}`} />
                <div className="min-w-0">
                  <div className={`text-[13px] font-medium ${tone.text}`}>
                    {p.label}
                    {p.evidence.length > 0 && (
                      <span className="ml-1.5 font-normal text-gray-500">
                        trade{p.evidence.length === 1 ? '' : 's'} {p.evidence.join(', ')}
                      </span>
                    )}
                  </div>
                  <div className="text-[12px] text-gray-400 leading-snug">{p.detail}</div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
