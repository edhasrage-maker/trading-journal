'use client'

/**
 * Play forward's controls: play / pause, one bar back / on, the speed, and a
 * slider from the fill to the end of the data. Desktop = one row under the
 * trade header; phone = one compact row under the chart, where the speed
 * button cycles 1× → 5× → 20×. Buttons drop focus after a click so Space keeps
 * playing / pausing instead of pressing the button again.
 */
import { cn } from '@/lib/utils'

export const SPEEDS = [1, 5, 20] as const
export type Speed = (typeof SPEEDS)[number]
const SPEED_TITLE: Record<Speed, string> = { 1: 'Real time', 5: '5 times real time', 20: '20 times real time' }

const Triangle = ({ size, fill = 'currentColor' }: { size: number; fill?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden><path d="M6 3.5v17l14-8.5z" fill={fill} /></svg>
)
const Pause = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden><rect x="5" y="4" width="5" height="16" rx="1" fill="currentColor" /><rect x="14" y="4" width="5" height="16" rx="1" fill="currentColor" /></svg>
)
const Back = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden><rect x="4" y="5" width="2.6" height="14" fill="currentColor" /><path d="M19 5v14L8 12z" fill="currentColor" /></svg>
)
const On = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden><path d="M5 5v14l11-7z" fill="currentColor" /><rect x="17.4" y="5" width="2.6" height="14" fill="currentColor" /></svg>
)

/** Run a click handler, then let go of focus. */
const tap = (fn: () => void) => (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.blur(); fn() }

/** The trade header's way in (desktop). Pressed while replaying; pressing it again starts over from the fill. */
export function PlayFromFillButton({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={tap(onClick)} aria-pressed={on} title="Watch the trade bar by bar from your fill"
      className={cn('flex-none inline-flex items-center gap-[7px] px-[13px] py-1.5 border rounded-md text-[12.5px] font-semibold text-gray-100 whitespace-nowrap transition-colors',
        on ? 'border-blue-500 bg-blue-500/15' : 'border-gray-800 hover:border-gray-600')}>
      <Triangle size={11} fill="var(--color-blue-500)" />Play from the fill
    </button>
  )
}

/** The phone's way in: a button on the chart's bottom-right. */
export function PlayFromFillPill({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={tap(onClick)}
      className="absolute right-[66px] bottom-[30px] z-20 h-11 inline-flex items-center gap-2 pl-3.5 pr-4 rounded-full bg-blue-500 text-white text-[13.5px] font-semibold shadow-[0_2px_8px_rgba(23,28,44,.25)]">
      <Triangle size={12} />Play from the fill
    </button>
  )
}

export default function ReplayControls({
  running, ready, atStart, atEnd, e, end, speed, onToggle, onBack, onOn, onSpeed, onScrub, clock, since, compact = false,
}: {
  running: boolean
  /** The Full review data is in: until then everything waits at the fill. */
  ready: boolean
  atStart: boolean; atEnd: boolean
  /** Seconds after the fill, and where the data ends. */
  e: number; end: number
  speed: Speed
  onToggle: () => void; onBack: () => void; onOn: () => void
  onSpeed: (s: Speed) => void
  onScrub: (e: number) => void
  /** HH:MM:SS PT at the cursor, and "2m 06s". */
  clock: string; since: string
  compact?: boolean
}) {
  const label = atEnd ? 'Play again from the fill' : running ? 'Pause' : 'Play'
  const slider = (
    <input type="range" min={0} max={Math.max(1, end)} step={1} value={Math.round(e)} disabled={!ready}
      onChange={ev => onScrub(Number(ev.target.value))} aria-label="Replay position" aria-valuetext={`${clock} PT, ${since} after the fill`}
      className={cn('flex-1 cursor-pointer disabled:cursor-default', compact ? 'min-w-0 h-11 m-0' : 'min-w-[120px]')}
      style={{ accentColor: 'var(--color-blue-500)' }} />
  )

  if (compact) {
    const sq = 'w-11 h-11 flex-none inline-flex items-center justify-center rounded-lg disabled:opacity-40'
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]
    return (
      <div role="group" aria-label="Replay controls" className="h-[52px] flex-none flex items-center gap-1.5">
        <button type="button" onClick={tap(onToggle)} disabled={!ready} aria-label={label} className={cn(sq, 'bg-blue-500 text-white')}>
          {running ? <Pause size={15} /> : <Triangle size={15} />}
        </button>
        <button type="button" onClick={tap(onBack)} disabled={!ready || atStart} aria-label="One bar back" className={cn(sq, 'border border-gray-800 text-gray-100')}><Back size={14} /></button>
        <button type="button" onClick={tap(onOn)} disabled={!ready || atEnd} aria-label="One bar on" className={cn(sq, 'border border-gray-800 text-gray-100')}><On size={14} /></button>
        {slider}
        <button type="button" onClick={tap(() => onSpeed(next))} aria-label={`Speed ${speed} times, tap to change`}
          className={cn(sq, 'border border-gray-800 text-gray-100 font-mono text-[13px] font-semibold')}>{speed}×</button>
      </div>
    )
  }

  const ib = 'inline-flex items-center justify-center w-[26px] h-[26px] border border-gray-800 rounded-[4px] text-gray-400 hover:text-gray-100 disabled:opacity-40 disabled:hover:text-gray-400'
  return (
    <div role="group" aria-label="Replay controls" className="h-[44px] flex-none flex items-center gap-2.5 border-b" style={{ borderColor: 'var(--ts-line)' }}>
      <button type="button" onClick={tap(onToggle)} disabled={!ready} aria-label={label} title={`${label} (Space)`}
        className="w-[30px] h-[30px] flex-none inline-flex items-center justify-center rounded-md bg-blue-500 text-white disabled:opacity-50">
        {running ? <Pause size={13} /> : <Triangle size={13} />}
      </button>
      <button type="button" onClick={tap(onBack)} disabled={!ready || atStart} aria-label="One bar back" title="One bar back" className={ib}><Back size={13} /></button>
      <button type="button" onClick={tap(onOn)} disabled={!ready || atEnd} aria-label="One bar on" title="One bar on" className={ib}><On size={13} /></button>
      <span role="group" aria-label="Speed" className="inline-flex flex-none gap-0.5 ml-1">
        {SPEEDS.map(s => (
          <button key={s} type="button" onClick={tap(() => onSpeed(s))} aria-pressed={speed === s} title={SPEED_TITLE[s]}
            className={cn('px-2 py-[3px] text-[12px] rounded-[3px] transition-colors', speed === s ? 'bg-blue-500/15 text-gray-100 shadow-[inset_0_-2px_0_var(--color-blue-500)]' : 'text-gray-400 hover:text-gray-100')}>
            {s}×
          </button>
        ))}
      </span>
      {slider}
      <span className="flex-none font-mono text-[12px] tabular-nums text-gray-100 whitespace-nowrap">
        {clock} PT <span className="text-gray-400">· {since} after the fill</span>
      </span>
    </div>
  )
}
