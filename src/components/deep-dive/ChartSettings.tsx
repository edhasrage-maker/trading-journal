'use client'

/**
 * Chart Settings — one on/off switch at the top of Replay Review's left
 * column; on opens every chart option right there, in plain groups, and the
 * charts change as you go. On the phone the same groups open as a sheet
 * (compact: the options that matter on a small screen).
 */
import { cn } from '@/lib/utils'
import type { OfRoot } from '@/lib/orderflow/ticks'
import { FP_COLOR_KEYS, FP_COLOR_LABELS, type FpColorKey } from './palette'
import type { ReplaySettings } from './replay-settings'

const SlidersIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" />
  </svg>
)

function Track({ on, big }: { on: boolean; big?: boolean }) {
  return (
    <span className={cn('relative flex-none rounded-full transition-colors', big ? 'w-10 h-6' : 'w-7 h-4')} style={{ background: on ? 'var(--color-blue-500)' : 'var(--ts-line)' }}>
      <span className={cn('absolute rounded-full bg-white transition-all', big ? 'top-[3px] w-[18px] h-[18px]' : 'top-[2px] w-3 h-3')} style={{ left: on ? (big ? 19 : 14) : (big ? 3 : 2) }} />
    </span>
  )
}

/** The switch itself — obvious on / off. */
export function ChartSettingsToggle({ open, onChange, label = 'Chart Settings' }: { open: boolean; onChange: (open: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={open}
      onClick={() => onChange(!open)}
      className={cn('flex items-center justify-between w-full px-2.5 py-[9px] border rounded-md text-gray-100 transition-colors', open ? 'border-blue-500 bg-blue-500/10' : 'border-gray-800 hover:border-gray-600')}
    >
      <span className="flex items-center gap-2 text-[13.5px] font-semibold"><SlidersIcon />{label}</span>
      <span className="flex items-center gap-[7px] text-[11.5px] text-gray-400">
        {open ? 'On' : 'Off'}
        <span className="relative w-[34px] h-[19px] rounded-full flex-none" style={{ background: open ? 'var(--color-blue-500)' : 'var(--ts-line)' }}>
          <span className="absolute top-[2px] w-[15px] h-[15px] rounded-full bg-white transition-all" style={{ left: open ? 17 : 2 }} />
        </span>
      </span>
    </button>
  )
}

export function SettingsIconButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="h-11 inline-flex items-center gap-1.5 px-2.5 border border-gray-800 rounded-lg text-[13px] text-gray-100">
      <SlidersIcon />Chart Settings
    </button>
  )
}

const sel = 'bg-transparent border border-gray-800 rounded-[4px] px-1 py-[2px] text-[12px] text-gray-100'

export default function ChartSettingsPanel({
  s, update, inst, ofDefault, colors, onResetAll, compact = false,
}: {
  s: ReplaySettings
  update: (patch: Partial<ReplaySettings>) => void
  inst: OfRoot
  /** What bubbles / footprint follow when untouched: the profile's order-flow setting. */
  ofDefault: boolean
  colors: { values: Record<FpColorKey, string>; set: (k: FpColorKey, hex: string) => void; reset: () => void }
  onResetAll: () => void
  /** Phone sheet: bigger rows, fewer options. */
  compact?: boolean
}) {
  const G = s.g[inst]
  const setG = (patch: Partial<typeof G>) => update({ g: { ...s.g, [inst]: { ...G, ...patch } } })
  const cap = cn('font-semibold uppercase tracking-[.8px] text-gray-400', compact ? 'text-[11px] mt-4 mb-0.5' : 'text-[10.5px] mt-3.5 mb-1')
  const sw = (label: string, on: boolean, set: (v: boolean) => void) => (
    <button
      key={label}
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => set(!on)}
      className={cn('flex items-center justify-between w-full text-left text-gray-100', compact ? 'h-11 text-[14px] border-b border-gray-800' : 'py-1 text-[12.5px]')}
    >
      <span>{label}</span><Track on={on} big={compact} />
    </button>
  )
  const bubbles = s.bubbles ?? ofDefault, fp = s.fp ?? ofDefault

  return (
    <div className={compact ? '' : 'pt-0.5 pb-2.5 border-b'} style={compact ? undefined : { borderColor: 'var(--ts-line)' }}>
      <div className={cap}>Charts shown</div>
      {sw('Candles', s.candles, v => update({ candles: v }))}
      {sw('Bubbles', bubbles, v => update({ bubbles: v }))}
      {sw('Footprint', fp, v => update({ fp: v }))}

      <div className={cap}>Candles</div>
      {sw('Heiken-Ashi', s.ha, v => update({ ha: v }))}
      {sw('Key levels', s.lv, v => update({ lv: v }))}
      {sw('VWAP', s.vwap, v => update({ vwap: v }))}
      {sw('EMA 9 / 20 (5m)', s.ema, v => update({ ema: v }))}
      {sw('Bar POC', s.poc, v => update({ poc: v }))}
      {!compact && sw('Delta and volume panes', s.dv, v => update({ dv: v }))}
      {!compact && (
        <div className="flex items-center justify-between py-1 text-[12.5px] text-gray-100">
          <label htmlFor="replay-prof">Volume profile</label>
          <span className="flex gap-1">
            <select id="replay-prof" className={sel} value={s.prof} onChange={e => update({ prof: e.target.value as ReplaySettings['prof'] })}>
              <option value="session">Session</option><option value="on">Overnight</option><option value="prior">Prior day</option><option value="off">Off</option>
            </select>
            <select className={sel} aria-label="Profile row size" value={G.prof} onChange={e => setG({ prof: +e.target.value })}>
              {[1, 2, 4, 8, 16].map(x => <option key={x} value={x}>{x} tick{x === 1 ? '' : 's'}</option>)}
            </select>
          </span>
        </div>
      )}

      <div className={cap}>Bubbles</div>
      {sw('Shift one bar left (as in Sierra)', s.boff, v => update({ boff: v }))}
      {sw('Show the 40-trade bars', s.b40, v => update({ b40: v }))}

      {!compact && (
        <>
          <div className={cap}>Footprint</div>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 text-[12px] text-gray-400">
            <label className="flex flex-col gap-0.5">Bars shown
              <select className={sel} value={s.fpN} onChange={e => update({ fpN: +e.target.value })}>{[4, 6, 8, 10, 12, 15].map(x => <option key={x} value={x}>{x}</option>)}</select>
            </label>
            <label className="flex flex-col gap-0.5">Row size
              <select className={sel} value={G.fp} onChange={e => setG({ fp: +e.target.value })}>{[1, 2, 4, 8].map(x => <option key={x} value={x}>{x} tick{x === 1 ? '' : 's'}</option>)}</select>
            </label>
            <label className="flex flex-col gap-0.5">Imbalance
              <select className={sel} value={s.fpR} onChange={e => update({ fpR: +e.target.value })}>{[2, 2.5, 3, 4].map(x => <option key={x} value={x}>{x * 100}%</option>)}</select>
            </label>
            <label className="flex flex-col gap-0.5">Min volume
              <select className={sel} value={G.min} onChange={e => setG({ min: +e.target.value })}>{[1, 3, 5, 10, 20, 40].map(x => <option key={x} value={x}>{x}</option>)}</select>
            </label>
          </div>
        </>
      )}

      {compact ? <div className={cap}>Footprint colours</div> : <div className="mt-3 mb-1 text-[12px] font-semibold text-gray-100">Footprint colours</div>}
      <div className={compact ? '' : 'grid grid-cols-2 gap-x-2 gap-y-1'}>
        {FP_COLOR_KEYS.map(k => (
          <label key={k} className={cn('flex items-center cursor-pointer text-gray-100', compact ? 'justify-between h-11 text-[14px] border-b border-gray-800' : 'gap-1.5 text-[12px]')}>
            {compact && <span>{FP_COLOR_LABELS[k]}</span>}
            <input
              type="color"
              value={colors.values[k]}
              onChange={e => colors.set(k, e.target.value)}
              className={cn('flex-none p-0 border border-gray-800 bg-transparent cursor-pointer', compact ? 'w-11 h-7 rounded-md' : 'w-[26px] h-[18px] rounded-[3px]')}
            />
            {!compact && FP_COLOR_LABELS[k]}
          </label>
        ))}
      </div>
      {!compact && <button type="button" onClick={colors.reset} className="mt-1.5 text-[12px] text-blue-400 hover:text-blue-300">Reset colours</button>}

      <div className={cap}>Extras</div>
      {!compact && sw('Levels near entry panel', s.rail, v => update({ rail: v }))}
      {sw('Always show bar details', s.details, v => update({ details: v }))}
      {!compact && <button type="button" onClick={onResetAll} className="block mt-2 text-[12px] text-blue-400 hover:text-blue-300">Back to my defaults</button>}
    </div>
  )
}
