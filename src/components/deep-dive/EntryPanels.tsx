'use client'

/**
 * Right-rail reference panels: the planned bracket at entry, and every level
 * near the entry sorted by distance (points and × ATR). Reference only — the
 * table never ticks a tag.
 */
import type { PlannedBracket } from '@/lib/orderflow/bracket'
import { bracketLabel } from './time-chart'

export function BracketBox({ bracket: B, entryPrice }: { bracket: PlannedBracket; entryPrice: number }) {
  const a = B.atr
  if (B.stop == null && B.tp == null) return <p className="text-[12px]" style={{ color: 'var(--ts-faint)' }}>No stop / TP recorded and no ATR to assume one.</p>
  const leg = (label: string, cls: string, v: number, src: 'recorded' | 'assumed', which: 'stop' | 'tp') => {
    const d = v - entryPrice, k = a ? Math.abs(d) / a : null
    return (
      <div className="flex items-baseline gap-2 tabular-nums">
        <span className={cls}>{label} {v.toFixed(2)}</span>
        <span style={{ color: 'var(--ts-mut)' }}>{d >= 0 ? '+' : ''}{d.toFixed(2)} pts{k != null ? ` · ${k.toFixed(2)} ATR` : ''}</span>
        <span className="ml-auto text-[11px]" style={{ color: src === 'recorded' ? 'var(--ts-faint)' : '#d6b24e' }}>
          {src === 'recorded' ? 'recorded' : bracketLabel(src, which, B).replace(/^(STOP|TP) \((.*)\)$/, '$2')}
        </span>
      </div>
    )
  }
  const R = B.stop != null && B.tp != null ? Math.abs(B.tp - entryPrice) / Math.abs(entryPrice - B.stop) : null
  return (
    <div className="font-mono text-[12px] leading-relaxed">
      {B.stop != null && leg('Stop', 'text-red-400', B.stop, B.stop_src, 'stop')}
      {B.tp != null && leg('TP  ', 'text-green-400', B.tp, B.tp_src, 'tp')}
      <div className="text-[11px] mt-1" style={{ color: 'var(--ts-faint)' }}>
        {R != null ? `TP : stop = ${R.toFixed(2)}R · ` : ''}ATR {a != null ? a.toFixed(2) : '—'} ({B.atr_src})
      </div>
    </div>
  )
}

export interface NearLevel { name: string; price: number }

export function LevelsNearEntry({ items, entryPrice, atr }: { items: NearLevel[]; entryPrice: number; atr: number | null }) {
  const a1 = atr || 1
  const rows = items.map(it => ({ ...it, dist: it.price - entryPrice })).sort((x, y) => Math.abs(x.dist) - Math.abs(y.dist))
  return (
    <table className="w-full font-mono text-[12px] tabular-nums border-collapse">
      <thead>
        <tr style={{ color: 'var(--ts-faint)' }}>
          <td className="py-1 pr-2">level</td><td className="text-right pr-2">price</td><td className="text-right pr-2">vs entry</td><td className="text-right">× ATR</td>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => {
          const k = Math.abs(r.dist) / a1
          return (
            <tr key={r.name} className="border-t" style={{ borderColor: 'var(--ts-hair)', color: k > 4 ? 'var(--ts-faint)' : 'var(--ts-ink)', background: k <= 1 ? 'rgba(79,151,206,.10)' : undefined }}>
              <td className="py-[3px] pr-2 whitespace-nowrap">{r.name}</td>
              <td className="text-right pr-2">{r.price.toFixed(2)}</td>
              <td className="text-right pr-2">{r.dist >= 0 ? '+' : ''}{r.dist.toFixed(2)}</td>
              <td className="text-right">{k.toFixed(1)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
