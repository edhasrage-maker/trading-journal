/**
 * Session-level computation — TypeScript port of the EdhasrageSessionLevels
 * Sierra Chart study (ACS_Source/EdhasrageSessionLevels.cpp).
 *
 * Computes, for a target Pacific-time trading day, the static horizontal
 * levels (PDH/PDL, ONH/ONL, IBH/IBL + extensions, RTH/Weekly open) plus the
 * per-bar dynamic series (24H VWAP anchored at ETH start, Weekly VWAP, and
 * EMA9/EMA20 using Sierra's progressive-warmup formula).
 *
 * Windows are Pacific-time wall-clock (study defaults):
 *   ETH (Globex) start 15:00 · RTH 06:30–13:00 · IB 06:30–07:30 ·
 *   full-session end 14:00 · weekly anchor Sunday 15:00.
 *
 * Bar timestamps are UTC (from the SCID reader / ohlcv_bars). Each bar is
 * converted to PT wall-clock to bucket it into the right session window;
 * DST is handled by Intl with America/Los_Angeles.
 */

export interface LevelsConfig {
  ethStartSec: number
  rthStartSec: number
  rthEndSec: number
  fullEndSec: number
  ibEndSec: number
  weeklyAnchorDow: number // 0 = Sunday
  weeklyAnchorSec: number
  extPercents: [number, number, number]
  emaTimeframeMins: number // EMA computed on this bar timeframe (study default 1; common 5)
}

export const DEFAULT_LEVELS_CONFIG: LevelsConfig = {
  ethStartSec: 15 * 3600,        // 15:00
  rthStartSec: 6 * 3600 + 30 * 60, // 06:30
  rthEndSec: 13 * 3600,          // 13:00
  fullEndSec: 14 * 3600,         // 14:00
  ibEndSec: 7 * 3600 + 30 * 60,  // 07:30
  weeklyAnchorDow: 0,
  weeklyAnchorSec: 15 * 3600,    // Sunday 15:00
  extPercents: [25, 50, 100],
  emaTimeframeMins: 5,           // 9/20 EMA on the 5-minute by default
}

export interface SessionLevels {
  pdh: number | null
  pdl: number | null
  pdhFull: number | null
  pdlFull: number | null
  onh: number | null
  onl: number | null
  ibh: number | null
  ibl: number | null
  rthOpen: number | null
  weeklyOpen: number | null
  ibhExt: (number | null)[]
  iblExt: (number | null)[]
}

export interface LevelSeriesPoint {
  ts: string
  vwap: number | null
  weeklyVwap: number | null
  ema9: number | null
  ema20: number | null
  /** 1-minute ATR-10 using Wilder's smoothing. Null until enough bars have warmed up. */
  atr: number | null
}

export interface LevelsResult {
  levels: SessionLevels
  series: LevelSeriesPoint[]
}

export interface RawBar {
  ts: string
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

interface AnnotatedBar extends RawBar {
  ms: number
  ptDate: string // YYYY-MM-DD in PT
  sod: number    // seconds since PT midnight
  dow: number    // 0=Sun
}

const PT_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  weekday: 'short',
})
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function ptInfo(ms: number): { date: string; sod: number; dow: number } {
  const parts = PT_FMT.formatToParts(new Date(ms))
  const m: Record<string, string> = {}
  for (const p of parts) m[p.type] = p.value
  return {
    date: `${m.year}-${m.month}-${m.day}`,
    sod: Number(m.hour) * 3600 + Number(m.minute) * 60 + Number(m.second),
    dow: DOW[m.weekday] ?? 0,
  }
}

/** Sierra Chart's progressive-warmup EMA (matches the native EMA study). */
function sierraEma(closes: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null)
  if (closes.length === 0) return out
  let ema = closes[0]
  out[0] = ema
  for (let i = 1; i < closes.length; i++) {
    const t = i + 1 // 1-indexed bar position
    const alpha = t < length - 1 ? 2 / (t + 2) : 2 / (length + 1)
    ema = alpha * closes[i] + (1 - alpha) * ema
    out[i] = ema
  }
  return out
}

/**
 * EMA computed on an N-minute timeframe, returned aligned 1:1 with the input
 * 1-minute bars but populated only at each bucket's closing bar (every other
 * index is null). Bars are grouped into N-minute buckets (by UTC ms); the EMA
 * runs over the per-bucket closes, and the resulting value is anchored to the
 * last 1-minute bar of its bucket.
 *
 * The client filters out the nulls when drawing the line, so plotting only
 * these per-bucket points draws a clean polyline through the N-minute EMA
 * values. (The previous approach repeated each bucket's value across all five
 * 1-minute bars, producing a flat-then-jump staircase that looked jagged.)
 * The values at each N-minute mark are identical to a native N-minute EMA, so
 * this still matches a Sierra N-minute chart exactly. tfMins <= 1 falls back
 * to a plain 1-minute EMA on every bar.
 */
function emaOnTimeframe(annotated: AnnotatedBar[], tfMins: number, length: number): (number | null)[] {
  if (tfMins <= 1) return sierraEma(annotated.map(b => b.close), length)
  const bucketMs = tfMins * 60_000
  const bucketKeys: number[] = []
  const bucketClose = new Map<number, number>()
  const bucketLastIdx = new Map<number, number>()
  for (let i = 0; i < annotated.length; i++) {
    const b = annotated[i]
    const bk = Math.floor(b.ms / bucketMs) * bucketMs
    if (!bucketClose.has(bk)) bucketKeys.push(bk)
    bucketClose.set(bk, b.close)   // bucket closes on its last 1-min bar
    bucketLastIdx.set(bk, i)       // ...remember where that bar is
  }
  const ema = sierraEma(bucketKeys.map(k => bucketClose.get(k)!), length)
  const out: (number | null)[] = new Array(annotated.length).fill(null)
  bucketKeys.forEach((k, j) => { out[bucketLastIdx.get(k)!] = ema[j] })
  return out
}

/**
 * Wilder's ATR over the bar series (always on the underlying 1-minute bars).
 * Seed = SMA of the first `length` true ranges; subsequent values use
 * ATR = (ATR_prev * (length - 1) + TR) / length. Indices before the seed are
 * null. Computed over the entire lookback so the target day's first value is
 * already fully warmed up.
 */
function wilderAtr(annotated: AnnotatedBar[], length: number): (number | null)[] {
  const n = annotated.length
  const out: (number | null)[] = new Array(n).fill(null)
  if (n === 0 || length <= 0 || n < length) return out
  const tr: number[] = new Array(n)
  tr[0] = annotated[0].high - annotated[0].low
  for (let i = 1; i < n; i++) {
    const b = annotated[i]
    const prevClose = annotated[i - 1].close
    tr[i] = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose))
  }
  let sum = 0
  for (let i = 0; i < length; i++) sum += tr[i]
  let atr = sum / length
  out[length - 1] = atr
  for (let i = length; i < n; i++) {
    atr = (atr * (length - 1) + tr[i]) / length
    out[i] = atr
  }
  return out
}

function hl(bars: AnnotatedBar[]): { high: number | null; low: number | null } {
  if (bars.length === 0) return { high: null, low: null }
  let high = -Infinity, low = Infinity
  for (const b of bars) {
    if (b.high > high) high = b.high
    if (b.low < low) low = b.low
  }
  return { high, low }
}

/** Most recent Sunday-15:00-PT anchor at or before the target day's RTH. */
function weeklyAnchorMs(annotated: AnnotatedBar[], targetDate: string, cfg: LevelsConfig): number | null {
  // Find the first bar that is at/after the most-recent weekly anchor preceding
  // the target day. We scan from the target day backwards for a bar whose PT
  // dow == anchor dow and sod >= anchorSec, taking the latest such moment <= target.
  // Simpler: walk all bars, track the latest bar whose (dow,sod) crosses the anchor.
  let anchor: number | null = null
  for (const b of annotated) {
    if (b.ptDate > targetDate) break
    if (b.dow === cfg.weeklyAnchorDow && b.sod >= cfg.weeklyAnchorSec) {
      anchor = b.ms
    }
  }
  return anchor
}

export function computeSessionLevels(
  bars: RawBar[],
  targetDatePT: string,
  config: LevelsConfig = DEFAULT_LEVELS_CONFIG,
): LevelsResult {
  const cfg = config
  const annotated: AnnotatedBar[] = bars
    .map(b => {
      const ms = new Date(b.ts).getTime()
      const { date, sod, dow } = ptInfo(ms)
      return { ...b, ms, ptDate: date, sod, dow }
    })
    .sort((a, b) => a.ms - b.ms)

  const onPtDate = (d: string) => annotated.filter(b => b.ptDate === d)
  const inRTH = (b: AnnotatedBar) => b.sod >= cfg.rthStartSec && b.sod < cfg.rthEndSec
  const inIB = (b: AnnotatedBar) => b.sod >= cfg.rthStartSec && b.sod < cfg.ibEndSec
  const inFull = (b: AnnotatedBar) => b.sod >= cfg.rthStartSec && b.sod < cfg.fullEndSec

  // Distinct PT dates that have any RTH activity, ascending.
  const rthDates = Array.from(new Set(annotated.filter(inRTH).map(b => b.ptDate))).sort()

  // --- Target-day windows ---
  const targetBars = onPtDate(targetDatePT)
  const targetRTH = targetBars.filter(inRTH)
  const targetIB = targetBars.filter(inIB)

  const ibHL = hl(targetIB)
  const ibh = ibHL.high
  const ibl = ibHL.low

  const rthOpen = targetRTH.length > 0 ? targetRTH[0].open : null

  // IB extensions
  const ibhExt: (number | null)[] = [null, null, null]
  const iblExt: (number | null)[] = [null, null, null]
  if (ibh != null && ibl != null) {
    const range = ibh - ibl
    cfg.extPercents.forEach((pct, i) => {
      ibhExt[i] = ibh + (pct / 100) * range
      iblExt[i] = ibl - (pct / 100) * range
    })
  }

  // Overnight (ETH) for target: prior PT date sod >= ethStart, plus target PT date sod < rthStart.
  // Prior calendar date in PT:
  const prevCalDate = (() => {
    const d = new Date(`${targetDatePT}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() - 1)
    return d.toISOString().slice(0, 10)
  })()
  const onBars = annotated.filter(
    b =>
      (b.ptDate === prevCalDate && b.sod >= cfg.ethStartSec) ||
      (b.ptDate === targetDatePT && b.sod < cfg.rthStartSec),
  )
  const onHL = hl(onBars)

  // Prior trading day (most recent rthDate before target).
  const priorIdx = rthDates.indexOf(targetDatePT) - 1
  const priorDate = priorIdx >= 0 ? rthDates[priorIdx] : null
  let pdh: number | null = null, pdl: number | null = null
  let pdhFull: number | null = null, pdlFull: number | null = null
  if (priorDate) {
    const pd = onPtDate(priorDate)
    const pdRTH = hl(pd.filter(inRTH))
    pdh = pdRTH.high
    pdl = pdRTH.low
    const pdFull = hl(pd.filter(inFull))
    pdhFull = pdFull.high
    pdlFull = pdFull.low
  }

  // Weekly open
  const wAnchorMs = weeklyAnchorMs(annotated, targetDatePT, cfg)
  let weeklyOpen: number | null = null
  if (wAnchorMs != null) {
    const firstAfter = annotated.find(b => b.ms >= wAnchorMs)
    weeklyOpen = firstAfter ? firstAfter.open : null
  }

  // --- Per-bar series for the target day ---
  // 24H VWAP anchored at the ETH start preceding the target RTH = ethStart on
  // prevCalDate (15:00 PT the evening before). Weekly VWAP anchored at weekly
  // anchor. EMA over all bars (continuous), values sliced to target day.
  const ethAnchorMs = (() => {
    const anchorBar = annotated.find(b => b.ptDate === prevCalDate && b.sod >= cfg.ethStartSec)
    return anchorBar ? anchorBar.ms : (targetBars[0]?.ms ?? null)
  })()

  // EMA over full series, on the configured timeframe (default 5m)
  const ema9All = emaOnTimeframe(annotated, cfg.emaTimeframeMins, 9)
  const ema20All = emaOnTimeframe(annotated, cfg.emaTimeframeMins, 20)
  // ATR-10 (Wilder) on the underlying 1-min bars — always on 1m regardless of
  // the EMA timeframe pref (the user spec is "1 min ATR-10 Wilders Method").
  const atrAll = wilderAtr(annotated, 10)

  // VWAP accumulators
  let dPV = 0, dV = 0, wPV = 0, wV = 0
  const seriesByMs = new Map<number, LevelSeriesPoint>()
  for (let i = 0; i < annotated.length; i++) {
    const b = annotated[i]
    const hlc = (b.high + b.low + b.close) / 3
    const vol = b.volume ?? 0
    if (ethAnchorMs != null && b.ms >= ethAnchorMs) { dPV += hlc * vol; dV += vol }
    if (wAnchorMs != null && b.ms >= wAnchorMs) { wPV += hlc * vol; wV += vol }
    if (b.ptDate === targetDatePT) {
      seriesByMs.set(b.ms, {
        ts: b.ts,
        vwap: dV > 0 ? dPV / dV : null,
        weeklyVwap: wV > 0 ? wPV / wV : null,
        ema9: ema9All[i],
        ema20: ema20All[i],
        atr: atrAll[i],
      })
    }
  }
  const series = Array.from(seriesByMs.values()).sort((a, b) => (a.ts < b.ts ? -1 : 1))

  return {
    levels: { pdh, pdl, pdhFull, pdlFull, onh: onHL.high, onl: onHL.low, ibh, ibl, rthOpen, weeklyOpen, ibhExt, iblExt },
    series,
  }
}
