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
  // Overnight session windows (PT seconds-since-midnight). Asia opens the
  // evening before the RTH day and closes at 02:00; London runs 00:00 → RTH
  // open. Each session's IB is the first hour after its open.
  asiaStartSec: number
  asiaEndSec: number
  asiaIbEndSec: number
  londonStartSec: number
  londonEndSec: number
  londonIbEndSec: number
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
  asiaStartSec: 17 * 3600,          // Asia (Tokyo cash) open 17:00 PT
  asiaEndSec: 2 * 3600,             // Asia close 02:00 PT (next PT date)
  asiaIbEndSec: 18 * 3600,          // Asia IB end 18:00 PT
  londonStartSec: 0,                // London open 00:00 PT
  londonEndSec: 6 * 3600 + 30 * 60, // London close 06:30 PT (RTH open)
  londonIbEndSec: 1 * 3600,         // London IB end 01:00 PT
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
  // Session-aware additions. ibh/ibl/ibhExt/iblExt above reflect the ACTIVE
  // session's IB (per the sessionKind arg); these are the static prior-cycle
  // overnight references drawn regardless of the active session, computed off
  // the same prior trading day as PDH/PDL. sessionOpen = the active session's
  // opening print (equals rthOpen when sessionKind is 'rth').
  priorAsiaH: number | null
  priorAsiaL: number | null
  priorLondonH: number | null
  priorLondonL: number | null
  sessionOpen: number | null
}

export interface LevelSeriesPoint {
  ts: string
  vwap: number | null
  weeklyVwap: number | null
  ema9: number | null
  ema20: number | null
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

function hl(bars: AnnotatedBar[]): { high: number | null; low: number | null } {
  if (bars.length === 0) return { high: null, low: null }
  let high = -Infinity, low = Infinity
  for (const b of bars) {
    if (b.high > high) high = b.high
    if (b.low < low) low = b.low
  }
  return { high, low }
}

/** Which session's IB + high/low the levels are anchored to. Default 'rth'
 *  reproduces the original RTH-only behaviour. */
export type SessionKind = 'rth' | 'asia' | 'london'

export interface SessionWindowSpec {
  ibStartOffset: number; ibStartSec: number
  ibEndOffset: number; ibEndSec: number
  hlStartOffset: number; hlStartSec: number
  hlEndOffset: number; hlEndSec: number
}

/** IB and full high/low windows for each session, as PT-date offsets from the
 *  cycle date C plus seconds-since-PT-midnight. Asia opens the evening BEFORE
 *  the cycle's RTH day (offset -1) and closes 02:00 on C; London and RTH sit
 *  entirely on C. Exported so bar-derived market-context stats reuse the SAME
 *  window definitions instead of duplicating them. */
export function sessionWindow(kind: SessionKind, cfg: LevelsConfig = DEFAULT_LEVELS_CONFIG): SessionWindowSpec {
  switch (kind) {
    case 'asia':
      return {
        ibStartOffset: -1, ibStartSec: cfg.asiaStartSec, ibEndOffset: -1, ibEndSec: cfg.asiaIbEndSec,
        hlStartOffset: -1, hlStartSec: cfg.asiaStartSec, hlEndOffset: 0, hlEndSec: cfg.asiaEndSec,
      }
    case 'london':
      return {
        ibStartOffset: 0, ibStartSec: cfg.londonStartSec, ibEndOffset: 0, ibEndSec: cfg.londonIbEndSec,
        hlStartOffset: 0, hlStartSec: cfg.londonStartSec, hlEndOffset: 0, hlEndSec: cfg.londonEndSec,
      }
    case 'rth':
    default:
      return {
        ibStartOffset: 0, ibStartSec: cfg.rthStartSec, ibEndOffset: 0, ibEndSec: cfg.ibEndSec,
        hlStartOffset: 0, hlStartSec: cfg.rthStartSec, hlEndOffset: 0, hlEndSec: cfg.rthEndSec,
      }
  }
}

/** Add `days` to a YYYY-MM-DD PT date string (noon-UTC anchor dodges DST). */
function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** True when a bar falls in [startDate startSec, endDate endSec) (PT). Handles
 *  windows that cross midnight into the next PT date (startDate !== endDate). */
function inRange(b: AnnotatedBar, startDate: string, startSec: number, endDate: string, endSec: number): boolean {
  if (startDate === endDate) return b.ptDate === startDate && b.sod >= startSec && b.sod < endSec
  if (b.ptDate === startDate) return b.sod >= startSec
  if (b.ptDate === endDate) return b.sod < endSec
  return b.ptDate > startDate && b.ptDate < endDate
}

/** High/low over a session window anchored at cycle date C with the given
 *  offsets/seconds (from sessionWindow). */
function rangeHL(
  annotated: AnnotatedBar[],
  cycleDate: string,
  startOffset: number, startSec: number,
  endOffset: number, endSec: number,
): { high: number | null; low: number | null } {
  const startDate = shiftDate(cycleDate, startOffset)
  const endDate = shiftDate(cycleDate, endOffset)
  return hl(annotated.filter(b => inRange(b, startDate, startSec, endDate, endSec)))
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
  sessionKind: SessionKind = 'rth',
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
  const inFull = (b: AnnotatedBar) => b.sod >= cfg.rthStartSec && b.sod < cfg.fullEndSec

  // Distinct PT dates that have any RTH activity, ascending.
  const rthDates = Array.from(new Set(annotated.filter(inRTH).map(b => b.ptDate))).sort()

  // --- Target-day windows ---
  const targetBars = onPtDate(targetDatePT)
  const targetRTH = targetBars.filter(inRTH)
  const rthOpen = targetRTH.length > 0 ? targetRTH[0].open : null

  // --- Active-session IB (re-anchored per sessionKind) ---
  // RTH IB = 06:30-07:30 on D; Asia IB = 17:00-18:00 on D-1 (Asia opens the
  // evening before D's RTH close); London IB = 00:00-01:00 on D. The full
  // active-session window also yields the session's opening print.
  const sess = sessionWindow(sessionKind, cfg)
  const ibHL = rangeHL(annotated, targetDatePT, sess.ibStartOffset, sess.ibStartSec, sess.ibEndOffset, sess.ibEndSec)
  const ibh = ibHL.high
  const ibl = ibHL.low
  const activeStartDate = shiftDate(targetDatePT, sess.hlStartOffset)
  const activeEndDate = shiftDate(targetDatePT, sess.hlEndOffset)
  const activeBars = annotated.filter(b => inRange(b, activeStartDate, sess.hlStartSec, activeEndDate, sess.hlEndSec))
  const sessionOpen = activeBars.length > 0 ? activeBars[0].open : null

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
  let priorAsiaH: number | null = null, priorAsiaL: number | null = null
  let priorLondonH: number | null = null, priorLondonL: number | null = null
  if (priorDate) {
    const pd = onPtDate(priorDate)
    const pdRTH = hl(pd.filter(inRTH))
    pdh = pdRTH.high
    pdl = pdRTH.low
    const pdFull = hl(pd.filter(inFull))
    pdhFull = pdFull.high
    pdlFull = pdFull.low
    // Prior-cycle Asia + London ranges — the static overnight references you
    // trade against, anchored to the same prior trading day as PDH/PDL.
    const aw = sessionWindow('asia', cfg)
    const pa = rangeHL(annotated, priorDate, aw.hlStartOffset, aw.hlStartSec, aw.hlEndOffset, aw.hlEndSec)
    priorAsiaH = pa.high; priorAsiaL = pa.low
    const lw = sessionWindow('london', cfg)
    const pl = rangeHL(annotated, priorDate, lw.hlStartOffset, lw.hlStartSec, lw.hlEndOffset, lw.hlEndSec)
    priorLondonH = pl.high; priorLondonL = pl.low
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
      })
    }
  }
  const series = Array.from(seriesByMs.values()).sort((a, b) => (a.ts < b.ts ? -1 : 1))

  return {
    levels: {
      pdh, pdl, pdhFull, pdlFull, onh: onHL.high, onl: onHL.low, ibh, ibl, rthOpen, weeklyOpen, ibhExt, iblExt,
      priorAsiaH, priorAsiaL, priorLondonH, priorLondonL, sessionOpen,
    },
    series,
  }
}
