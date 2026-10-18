/**
 * Replay Review's view settings — per browser (localStorage). The footprint
 * colours are separate (useFootprintColors) because they follow the account.
 */
import type { OfRoot } from '@/lib/orderflow/ticks'
import type { ProfileWindow } from '@/lib/orderflow/profile'

/** Chart timeframes, in minutes: 1m · 5m · 30m · 4h. */
export const TFS = [1, 5, 30, 240] as const
export type Tf = (typeof TFS)[number]
export const tfLabel = (t: Tf) => (t === 240 ? '4h' : `${t}m`)
/** 30m and 4h run on the 30-minute history, not just the 1m window. */
export const isHtf = (t: Tf) => t >= 30

export interface ReplaySettings {
  tf: Tf; ha: boolean
  /** Charts shown. bubbles / fp: null = follow the trader's profile (order flow on or off). */
  candles: boolean; bubbles: boolean | null; fp: boolean | null
  /** Bubbles: one bar left as Sierra draws them; the 40-trade bars behind. */
  boff: boolean; b40: boolean
  prof: ProfileWindow | 'off'; lv: boolean; vwap: boolean; ema: boolean; poc: boolean; dv: boolean
  /** Levels near entry panel. */
  rail: boolean
  /** Bar details box always on (off = only while hovering). */
  details: boolean
  /** The Chart Settings switch. */
  open: boolean
  /** Candles' share of the charts row; footprint height in px. */
  split: number; fpH: number
  fpN: number; fpR: number
  g: Record<OfRoot, { fp: number; prof: number; min: number }>
}

export const DEFAULTS: ReplaySettings = {
  tf: 1, ha: false, candles: true, bubbles: null, fp: null, boff: true, b40: true,
  prof: 'session', lv: true, vwap: true, ema: true, poc: true, dv: false,
  rail: false, details: false, open: false, split: 0.5, fpH: 246, fpN: 10, fpR: 3,
  g: { NQ: { fp: 4, prof: 4, min: 5 }, ES: { fp: 1, prof: 1, min: 20 } },
}

export const SETTINGS_KEY = 'replay-settings-v3'
/** Deep Dive's settings, read once so nobody loses their setup in the rename. */
const OLD_KEY = 'deepdive-settings-v2'

/** Saved settings (or the old Deep Dive ones, mapped), ready to lay over DEFAULTS. */
export function loadSettings(): Partial<ReplaySettings> | null {
  const raw = localStorage.getItem(SETTINGS_KEY)
  let s: Partial<ReplaySettings>
  if (raw) s = JSON.parse(raw)
  else {
    const old = localStorage.getItem(OLD_KEY)
    if (!old) return null
    const o = JSON.parse(old) as Record<string, unknown>
    const { view, of, bubbles, fp, ...rest } = o
    s = {
      ...(rest as Partial<ReplaySettings>),
      candles: view !== 'bubble',
      bubbles: of === false || bubbles === false || view === 'time' ? false : of === true ? true : null,
      fp: of === false || fp === false ? false : of === true ? true : null,
    }
  }
  if (!TFS.includes(s.tf as Tf)) delete s.tf
  return s
}
