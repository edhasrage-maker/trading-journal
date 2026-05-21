'use client'

import { useRef, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import type { PrepNotes, MarketContext } from '@/lib/supabase/types'

interface Props {
  date: string
  marketContext: Partial<MarketContext>
  prepNotes: PrepNotes
  symbol?: string
}

const LEVEL_LABELS: { key: string; label: string }[] = [
  { key: 'PDH', label: 'PDH' }, { key: 'PDL', label: 'PDL' },
  { key: 'IBH', label: 'IBH' }, { key: 'IBL', label: 'IBL' },
  { key: 'ONH', label: 'ONH' }, { key: 'ONL', label: 'ONL' },
  { key: 'HTF S/R', label: 'HTF S/R' }, { key: 'HTF S/D', label: 'HTF S/D' },
  { key: 'WK-OP', label: 'WK-OP' }, { key: 'PWH', label: 'PWH' }, { key: 'PWL', label: 'PWL' },
]

export default function DiscordDashboard({ date, marketContext: ctx, prepNotes, symbol = 'NQ' }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [exporting, setExporting] = useState(false)

  const exportPng = async () => {
    if (!ref.current) return
    setExporting(true)
    try {
      const html2canvas = (await import('html2canvas')).default
      const canvas = await html2canvas(ref.current, { backgroundColor: '#0f1117', scale: 2 })
      const link = document.createElement('a')
      link.download = `${symbol}-prep-${date}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } finally {
      setExporting(false)
    }
  }

  const biasColor = prepNotes.bias === 'bullish' ? '#22c55e' : prepNotes.bias === 'bearish' ? '#ef4444' : '#9ca3af'
  const ibRatio = ctx.ib_vs_10d_avg
  const ibLabel = ibRatio == null ? '—' : ibRatio >= 1.2 ? 'WIDE' : ibRatio <= 0.8 ? 'NARROW' : 'NORMAL'
  const ibLabelColor = ibRatio == null ? '#9ca3af' : ibRatio >= 1.2 ? '#f97316' : ibRatio <= 0.8 ? '#3b82f6' : '#22c55e'

  const mgi = prepNotes.htf_mgi ?? {}
  const taggedLevels = LEVEL_LABELS.filter(l => mgi[l.key] != null)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-white">Discord Dashboard Preview</h3>
        <button
          onClick={exportPng}
          disabled={exporting}
          className="flex items-center gap-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
        >
          {exporting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
          Export PNG
        </button>
      </div>

      {/* Exported card */}
      <div ref={ref} style={{ fontFamily: 'system-ui, -apple-system, sans-serif', background: '#0f1117', padding: '20px', borderRadius: '12px', width: '520px' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid #1f2937' }}>
          <div>
            <div style={{ color: '#fff', fontSize: '18px', fontWeight: 700 }}>Market Prep Notes</div>
            <div style={{ color: '#6b7280', fontSize: '12px', marginTop: '2px' }}>
              {new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            </div>
          </div>
          {prepNotes.bias && (
            <div style={{ background: biasColor + '22', border: `1px solid ${biasColor}55`, borderRadius: '8px', padding: '6px 14px' }}>
              <div style={{ color: biasColor, fontSize: '13px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{prepNotes.bias}</div>
            </div>
          )}
        </div>

        {/* MGI Level position chips */}
        {taggedLevels.length > 0 && (
          <div style={{ marginBottom: '12px' }}>
            <div style={{ color: '#6b7280', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' }}>Market Structure Position</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {taggedLevels.map(({ key, label }) => {
                const pos = mgi[key]
                const bg = pos === 'above' ? '#14532d' : '#450a0a'
                const border = pos === 'above' ? '#166534' : '#7f1d1d'
                const arrow = pos === 'above' ? '▲' : '▼'
                const clr = pos === 'above' ? '#4ade80' : '#f87171'
                return (
                  <div key={key} style={{ background: bg, border: `1px solid ${border}`, borderRadius: '6px', padding: '3px 8px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ color: clr, fontSize: '9px' }}>{arrow}</span>
                    <span style={{ color: '#e5e7eb', fontSize: '11px', fontWeight: 600 }}>{label}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Stats row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', marginBottom: '12px' }}>
          <StatBox label="RVOL" value={ctx.rvol?.toFixed(2) ?? '—'} />
          <StatBox label="IB SIZE" value={ctx.ib_size?.toString() ?? '—'} />
          <StatBox label="IB VS AVG" value={ibLabel} color={ibLabelColor} />
          <StatBox label="ADR" value={ctx.adr?.toString() ?? '—'} />
        </div>

        {/* GBX context row */}
        {(ctx.onh != null && ctx.onl != null) && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '12px' }}>
            <StatBox label="GBX RANGE" value={((ctx.onh as number) - (ctx.onl as number)).toFixed(2)} />
            {ctx.gbx_pct_adr != null && <StatBox label="GBX % ADR" value={`${ctx.gbx_pct_adr}%`} />}
          </div>
        )}

        {/* IB break timing */}
        {prepNotes.ib_behaviour && (
          <TextBlock label="IB BREAK TIMING" text={prepNotes.ib_behaviour} />
        )}

        {/* Volume profile */}
        {(prepNotes.volume_profile_shape || prepNotes.volume_profile_notes) && (
          <TextBlock
            label="VOLUME PROFILE"
            text={[prepNotes.volume_profile_shape ? `[${prepNotes.volume_profile_shape}]` : null, prepNotes.volume_profile_notes].filter(Boolean).join(' ')}
          />
        )}

        {/* Bias reasoning */}
        {prepNotes.bias_notes && (
          <TextBlock label="BIAS REASONING" text={prepNotes.bias_notes} />
        )}

        {/* Trade plans — market-facing summary, no AI notes */}
        {(prepNotes.trade_plans ?? []).length > 0 && (
          <div style={{ marginBottom: '8px' }}>
            <div style={{ color: '#6b7280', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' }}>Setups on Watch</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {prepNotes.trade_plans!.map((plan, i) => {
                const dirColor = plan.direction === 'long' ? '#22c55e' : '#ef4444'
                const dirBg = plan.direction === 'long' ? '#14532d' : '#450a0a'
                const dirBorder = plan.direction === 'long' ? '#166534' : '#7f1d1d'
                const dirArrow = plan.direction === 'long' ? '▲' : '▼'
                return (
                  <div key={i} style={{ background: '#1f2937', borderRadius: '8px', padding: '10px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                      <div style={{ background: dirBg, border: `1px solid ${dirBorder}`, borderRadius: '4px', padding: '2px 7px', fontSize: '10px', fontWeight: 700, color: dirColor }}>
                        {dirArrow} {plan.direction.toUpperCase()}
                      </div>
                      <span style={{ color: '#fff', fontSize: '13px', fontWeight: 600 }}>{plan.setup_name || 'Setup'}</span>
                      <span style={{ color: '#6b7280', fontSize: '11px', marginLeft: 'auto' }}>{plan.quality}/5</span>
                    </div>
                    {plan.invalidation && (
                      <div style={{ display: 'flex', gap: '6px', marginBottom: '3px' }}>
                        <span style={{ color: '#6b7280', fontSize: '11px', minWidth: '80px' }}>Invalidated:</span>
                        <span style={{ color: '#d1d5db', fontSize: '11px' }}>{plan.invalidation}</span>
                      </div>
                    )}
                    {plan.targets && (
                      <div style={{ display: 'flex', gap: '6px', marginBottom: '3px' }}>
                        <span style={{ color: '#6b7280', fontSize: '11px', minWidth: '80px' }}>Targets:</span>
                        <span style={{ color: '#d1d5db', fontSize: '11px' }}>{plan.targets}</span>
                      </div>
                    )}
                    {plan.scary_factors && (
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <span style={{ color: '#6b7280', fontSize: '11px', minWidth: '80px' }}>Scary if:</span>
                        <span style={{ color: '#d1d5db', fontSize: '11px' }}>{plan.scary_factors}</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div style={{ color: '#374151', fontSize: '10px', textAlign: 'right', marginTop: '10px' }}>Trade Journal • NQ</div>
      </div>
    </div>
  )
}

function StatBox({ label, value, color = '#fff' }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: '#1f2937', borderRadius: '8px', padding: '8px 10px', textAlign: 'center' }}>
      <div style={{ color: '#6b7280', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '2px' }}>{label}</div>
      <div style={{ color, fontSize: '13px', fontWeight: 600 }}>{value}</div>
    </div>
  )
}

function TextBlock({ label, text }: { label: string; text: string }) {
  return (
    <div style={{ background: '#1f2937', borderRadius: '8px', padding: '10px 12px', marginBottom: '8px' }}>
      <div style={{ color: '#6b7280', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '4px' }}>{label}</div>
      <div style={{ color: '#d1d5db', fontSize: '12px', lineHeight: '1.6' }}>{text}</div>
    </div>
  )
}
