/**
 * Replay Review's view settings. The working copy lives in this browser
 * (localStorage) and changes as you go; "Save layout" puts everything but the
 * per-device bits (chart sizes, the Chart Settings switch) on the account
 * (useReplayLayout), so the other machine and the phone open the same way.
 * The footprint colours are separate (useFootprintColors) and always follow
 * the account.
 */
import type { OfRoot } from '@/lib/orderflow/ticks'
import type { ProfileWindow } from '@/lib/orderflow/profile'

/** Candle timeframes, in minutes: 15s · 30s · 1m · 5m · 30m · 4h. */
export const TFS = [0.25, 0.5, 1, 5, 30, 240] as const
export type Tf = (typeof TFS)[number]
export const tfLabel = (t: Tf) => (t === 240 ? '4h' : t < 1 ? `${t * 60}s` : `${t}m`)
/** 30m and 4h run on the 30-minute history, not just the 1m window. */
export const isHtf = (t: Tf) => t >= 30
/** 15s and 30s run on the sub-minute bars (asked for only when picked). */
export const isSub = (t: Tf) => t < 1

/** Footprint timeframes, in minutes. */
export const FP_TFS = [1, 5] as const
export type FpTf = (typeof FP_TFS)[number]

export interface ReplaySettings {
  tf: Tf; ha: boolean
  fpTf: FpTf
  /** Charts shown. bubbles / fp: null = follow the trader's profile (order flow on or off). */
  candles: boolean; bubbles: boolean | null; fp: boolean | null
  /** Bubbles: one bar left as Sierra draws them; the 40-trade bars behind. */
  boff: boolean; b40: boolean
  prof: ProfileWindow | 'off'; lv: boolean; vwap: boolean; ema: boolean; poc: boolean; dv: boolean
  /** Levels near entry panel. */
  rail: boolean
  /** "Your trade" panel (screenshot + tags) — Full review only. */
  yours: boolean
  /** Bar details box always on (off = only while hovering). */
  details: boolean
  /** The Chart Settings switch. Per device. */
  open: boolean
  /** Candles' share of the charts row; footprint height in px. Per device. */
  split: number; fpH: number
  fpN: number; fpR: number
  g: Record<OfRoot, { fp: number; prof: number; min: number }>
}

export const DEFAULTS: ReplaySettings = {
  tf: 1, ha: false, fpTf: 1, candles: true, bubbles: null, fp: null, boff: true, b40: true,
  prof: 'session', lv: true, vwap: true, ema: true, poc: true, dv: false,
  rail: false, yours: true, details: false, open: false, split: 0.5, fpH: 246, fpN: 10, fpR: 3,
  g: { NQ: { fp: 4, prof: 4, min: 5 }, ES: { fp: 1, prof: 1, min: 20 } },
}

export const SETTINGS_KEY = 'replay-settings-v3'
/** Deep Dive's settings, read once so nobody loses their setup in the rename. */
const OLD_KEY = 'deepdive-settings-v2'

/** Everything but the per-device bits: what "Save layout" keeps on the account. */
export type ReplayLayout = Omit<ReplaySettings, 'open' | 'split' | 'fpH'>
const LAYOUT_KEYS = (Object.keys(DEFAULTS) as (keyof ReplaySettings)[]).filter(k => k !== 'open' && k !== 'split' && k !== 'fpH') as (keyof ReplayLayout)[]
const ROOTS: OfRoot[] = ['NQ', 'ES']

/** The layout part of a full settings object, in a fixed key order. */
export function layoutOf(s: ReplaySettings): ReplayLayout {
  const out = Object.fromEntries(LAYOUT_KEYS.map(k => [k, s[k]])) as unknown as ReplayLayout
  out.g = Object.fromEntries(ROOTS.map(r => [r, { fp: s.g[r].fp, prof: s.g[r].prof, min: s.g[r].min }])) as ReplayLayout['g']
  return out
}

export const sameLayout = (a: ReplayLayout, b: ReplayLayout) => JSON.stringify(a) === JSON.stringify(b)

/**
 * A stored layout (or saved settings) made safe to lay over the current
 * settings: unknown keys and values this build can't show are dropped, so an
 * older or newer copy never breaks the page.
 */
export function cleanLayout(raw: unknown): Partial<ReplayLayout> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>, out: Record<string, unknown> = {}
  for (const k of LAYOUT_KEYS) {
    if (!(k in r) || k === 'g') continue
    const v = r[k], d = DEFAULTS[k]
    if (k === 'tf') { if (TFS.includes(v as Tf)) out.tf = v; continue }
    if (k === 'fpTf') { if (FP_TFS.includes(v as FpTf)) out.fpTf = v; continue }
    if (k === 'bubbles' || k === 'fp') { if (v === null || typeof v === 'boolean') out[k] = v; continue }
    if (k === 'prof') { if (['session', 'on', 'prior', 'off'].includes(v as string)) out.prof = v; continue }
    if (typeof v === typeof d) out[k] = v
  }
  if (r.g && typeof r.g === 'object') {
    const g = r.g as Record<string, unknown>, cg: Record<string, unknown> = {}
    for (const root of ROOTS) {
      const x = g[root] as Record<string, unknown> | undefined
      if (x && typeof x === 'object' && ['fp', 'prof', 'min'].every(f => typeof x[f] === 'number')) cg[root] = { fp: x.fp, prof: x.prof, min: x.min }
    }
    if (Object.keys(cg).length) out.g = cg
  }
  return out as Partial<ReplayLayout>
}

/** Lay a (clean) layout over full settings; the per-device bits stay as they are. */
export const withLayout = (s: ReplaySettings, l: Partial<ReplayLayout>): ReplaySettings => ({ ...s, ...l, g: { ...s.g, ...(l.g ?? {}) } })

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
  if (!FP_TFS.includes(s.fpTf as FpTf)) delete s.fpTf
  return s
}
