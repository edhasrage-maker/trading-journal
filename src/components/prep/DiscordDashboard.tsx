'use client'

import { useRef, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import type { PrepNotes, MarketContext, PriceScenario } from '@/lib/supabase/types'

interface Props {
  date: string
  marketContext: Partial<MarketContext>
  prepNotes: PrepNotes
  symbol?: string
}

// Day-stance → verdict-banner styling + headline. The one thing a casual viewer
// reads first, so it's a plain traffic-light verdict, not a number.
const STANCE: Record<'go' | 'caution' | 'avoid', { title: string; bg: string; title2: string; sub: string }> = {
  go:      { title: 'Green light',   bg: '#14532d', title2: '#bbf7d0', sub: '#86efac' },
  caution: { title: 'Be selective',  bg: '#78350f', title2: '#fde68a', sub: '#fcd34d' },
  avoid:   { title: 'Sit on hands',  bg: '#450a0a', title2: '#fecaca', sub: '#fca5a5' },
}

// Bias → directional badge. "Lean higher/lower" reads plainer than bullish/bearish.
const BIAS_BADGE: Record<'bullish' | 'bearish' | 'neutral', { label: string; color: string }> = {
  bullish: { label: 'Lean higher', color: '#22c55e' },
  bearish: { label: 'Lean lower', color: '#ef4444' },
  neutral: { label: 'Neutral', color: '#9ca3af' },
}

// Trailing-decimal-free number: 29190 stays "29190", 29192.5 → "29192.50".
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2))

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

  const stance = prepNotes.day_stance ? STANCE[prepNotes.day_stance] : null
  const bias = prepNotes.bias ? BIAS_BADGE[prepNotes.bias] : null

  // Plain-language chips — each derived from the numeric context, omitted when
  // its stat hasn't filled (so a stale feed yields fewer chips, never dashes).
  const chips: string[] = []
  if (ctx.rvol != null) chips.push(`Volume: ${ctx.rvol >= 110 ? 'high' : ctx.rvol < 90 ? 'light' : 'normal'}`)
  if (ctx.ib_vs_10d_avg != null) chips.push(`Ranges: ${ctx.ib_vs_10d_avg >= 1.2 ? 'wide' : ctx.ib_vs_10d_avg <= 0.8 ? 'small' : 'normal'}`)
  const slopes = [prepNotes.vwap_slope, prepNotes.ema_slope].filter(Boolean)
  if (slopes.length) chips.push(`Trend: ${slopes.includes('sloped') ? 'building' : 'none'}`)

  // "Where price can go" — favored first, skip rows with neither trigger nor target.
  const scenarios = (prepNotes.price_scenarios ?? [])
    .filter(s => (s.trigger?.trim() || s.target?.trim()))
    .sort((a) => (a.role === 'favored' ? -1 : 1))

  const resistance = ctx.ibh ?? ctx.pdh ?? null
  const support = ctx.ibl ?? ctx.pdl ?? null

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
      <div ref={ref} style={{ fontFamily: 'system-ui, -apple-system, sans-serif', background: '#0f1117', padding: '20px', borderRadius: '12px', width: '440px' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', paddingBottom: '12px', borderBottom: '1px solid #1f2937' }}>
          <div>
            <div style={{ color: '#fff', fontSize: '17px', fontWeight: 700 }}>{symbol} morning read</div>
            <div style={{ color: '#6b7280', fontSize: '12px', marginTop: '2px' }}>
              {new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            </div>
          </div>
          {bias && (
            <div style={{ background: bias.color + '22', border: `1px solid ${bias.color}55`, borderRadius: '8px', padding: '5px 12px' }}>
              <div style={{ color: bias.color, fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{bias.label}</div>
            </div>
          )}
        </div>

        {/* Verdict banner — the headline takeaway. Colored by stance; falls back to
            a neutral panel when only a one-line read (no stance) is set. */}
        {(stance || prepNotes.day_read) && (
          <div style={{ background: stance?.bg ?? '#1f2937', borderRadius: '10px', padding: '12px 14px', marginBottom: '12px' }}>
            {stance && <div style={{ color: stance.title2, fontSize: '16px', fontWeight: 600 }}>{stance.title}</div>}
            {prepNotes.day_read && (
              <div style={{ color: stance?.sub ?? '#d1d5db', fontSize: '13px', lineHeight: 1.5, marginTop: stance ? '2px' : 0 }}>{prepNotes.day_read}</div>
            )}
          </div>
        )}

        {/* Plain-language chips */}
        {chips.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '14px' }}>
            {chips.map(c => (
              <span key={c} style={{ background: '#1f2937', borderRadius: '6px', padding: '4px 9px', color: '#9ca3af', fontSize: '11px' }}>{c}</span>
            ))}
          </div>
        )}

        {/* Where price can go */}
        {scenarios.length > 0 && (
          <div style={{ marginBottom: '14px' }}>
            <div style={{ color: '#6b7280', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '7px' }}>Where price can go</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {scenarios.map((s: PriceScenario, i) => {
                const up = s.direction === 'up'
                const accent = up ? '#22c55e' : '#ef4444'
                const tag = up ? '#4ade80' : '#f87171'
                const path = [s.trigger?.trim(), s.target?.trim()].filter(Boolean).join(' → ')
                return (
                  <div key={i} style={{ background: '#1f2937', borderLeft: `3px solid ${accent}`, borderRadius: '0 8px 8px 0', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ color: tag, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase' }}>
                      {up ? '▲' : '▼'} {s.role === 'favored' ? 'Plan A' : 'Plan B'}
                    </span>
                    <span style={{ color: '#e5e7eb', fontSize: '12px' }}>{path}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Levels that matter */}
        {(resistance != null || support != null) && (
          <div style={{ marginBottom: '14px' }}>
            <div style={{ color: '#6b7280', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '7px' }}>Levels that matter</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
              <LevelBox label="Resistance" value={resistance != null ? fmt(resistance) : '—'} bg="#450a0a" labelColor="#f87171" valueColor="#fca5a5" />
              <LevelBox label="Support" value={support != null ? fmt(support) : '—'} bg="#14532d" labelColor="#4ade80" valueColor="#86efac" />
            </div>
          </div>
        )}

        {/* Setups on watch — market-facing summary, no AI notes */}
        {(prepNotes.trade_plans ?? []).length > 0 && (
          <div style={{ marginBottom: '8px' }}>
            <div style={{ color: '#6b7280', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '7px' }}>Setups on watch</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {prepNotes.trade_plans!.map((plan, i) => {
                const dirColor = plan.direction === 'long' ? '#22c55e' : '#ef4444'
                const dirBg = plan.direction === 'long' ? '#14532d' : '#450a0a'
                const dirBorder = plan.direction === 'long' ? '#166534' : '#7f1d1d'
                const dirArrow = plan.direction === 'long' ? '▲' : '▼'
                return (
                  <div key={i} style={{ background: '#1f2937', borderRadius: '8px', padding: '10px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ background: dirBg, border: `1px solid ${dirBorder}`, borderRadius: '4px', padding: '2px 7px', fontSize: '10px', fontWeight: 700, color: dirColor }}>
                        {dirArrow} {plan.direction.toUpperCase()}
                      </div>
                      <span style={{ color: '#fff', fontSize: '13px', fontWeight: 600 }}>{plan.setup_name || 'Setup'}</span>
                      <span style={{ color: '#6b7280', fontSize: '11px', marginLeft: 'auto' }}>{plan.quality}/5</span>
                    </div>
                    {plan.invalidation && (
                      <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                        <span style={{ color: '#6b7280', fontSize: '11px', minWidth: '70px' }}>Invalid if:</span>
                        <span style={{ color: '#d1d5db', fontSize: '11px' }}>{plan.invalidation}</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div style={{ color: '#374151', fontSize: '10px', textAlign: 'right', marginTop: '10px' }}>TapeScore • {symbol}</div>
      </div>
    </div>
  )
}

function LevelBox({ label, value, bg, labelColor, valueColor }: { label: string; value: string; bg: string; labelColor: string; valueColor: string }) {
  return (
    <div style={{ background: bg, borderRadius: '8px', padding: '8px 10px' }}>
      <div style={{ color: labelColor, fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ color: valueColor, fontSize: '14px', fontWeight: 600, marginTop: '2px' }}>{value}</div>
    </div>
  )
}
