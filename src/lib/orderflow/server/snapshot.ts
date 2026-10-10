/**
 * Deep Dive snapshot: everything the workspace draws for one trade, built from
 * ticks (local .scid, or the published tape on the hosted site — see
 * tick-source.ts) and cut at the fill second. The TypeScript counterpart of
 * the reference server's build_row(); the parity test holds the two to an exact
 * match (scripts/test-orderflow-parity.ts).
 *
 * BLIND CUT. Ticks are read with an exclusive end at the fill second, so the
 * newest trade that can reach any array here is stamped before the fill. The
 * partial entry bar, the live 40-trade bubble, the levels and the profiles are
 * all derived from that cut frame; nothing is read past it except the weekly
 * references (week open, prior week high/low), which are older than the fill
 * by construction.
 *
 * Window: prior RTH open (06:30 PT of the most recent earlier session with RTH
 * trading) → fill. Front-month per minute by trading date (15:00 PT roll of the
 * day), from the shared roll table in futures-contracts.ts.
 */
import { SIERRA_DATA_DIR } from '@/lib/import-scid-day'
import { ScidTickSource, priorRthDate, type TickSource } from './tick-source'
import type { OfRoot, TickFrame } from '../ticks'
import { TICK, asOf, emptyTicks, isTimeSorted, keepBefore, stableSortTicks, utcMsToSierraUs, sierraUsToUtcMs } from '../ticks'
import { utcToPtMs, tradingDate, ptMidnight, ptClock, ptDate, PT_DAY_MS, PT_HOUR_MS } from '../pt-clock'
import { aggregateMinutes, type MinuteBars, type VapByMinute } from '../minute-bars'
import { bubbles40t, BUBBLE_CFG, type BubbleChart } from '../bubbles40t'
import { levelsAsOf, weeklyAnchor, type Level } from '../levels'
import { plannedBracket, atrFallback14, type PlannedBracket } from '../bracket'
import { pyRound } from '../pymath'

export interface SnapshotRequest {
  root: OfRoot
  /** Fill time, UTC ms (seconds precision). */
  entryUtcMs: number
  direction: 'long' | 'short'
  entryPrice: number
  /** Rubric for the assumed bracket (resolveRubric). */
  atrStopTarget: number
  tp1RMultiple: number
  recordedStop?: number | null
  recordedTp?: number | null
  entryAtr?: number | null
  dataDir?: string
  /**
   * Blind (default): every array ends before the fill second. Set only for the
   * NON-blind deep chart review: bars, profile and bubbles then run on to this
   * instant, while the levels, bracket and ATR stay computed as of the fill.
   */
  displayEndUtcMs?: number
}

export interface SnapshotTimes {
  entry: number; rth_open: number; rth_close: number; ib_end: number
  prior_open: number; prior_close: number; eth_start: number; profile_anchor: number
  in_rth: boolean
}

export interface DeepDiveSnapshot {
  row: { date: string; weekday: string; time: string; inst: OfRoot; direction: 'long' | 'short'; price: number }
  /** Last second the chart covers (HH:MM:SS PT). */
  cutoff_label: string
  has_partial: boolean
  tick: number
  /** PT-clock epoch seconds. */
  times: SnapshotTimes
  bars: MinuteBars
  vap: VapByMinute
  levels: Level[]
  lpt: number
  bracket: PlannedBracket
  bubbles: BubbleChart | null
  /** Proof of the cut: the fill instant, where the data ends and the newest tick that made it in. */
  cut: { blind: boolean; fill_utc: string; data_end_utc: string; last_tick_utc: string | null; ticks: number; contracts: string[] }
}

const HOUR = PT_HOUR_MS, DAY = PT_DAY_MS
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const addDays = (date: string, n: number) => ptDate(ptMidnight(date) + n * DAY)
/**
 * The two orderings of the cut window (see stableSortTicks): `ticks` sorted by
 * time for the bubbles / partial bar / volume-at-price, and `byMinute` in file
 * order within each minute for the completed bars.
 */
function cutWindow(src: TickSource, startPt: number, endPt: number, cutoffUs: number) {
  const raw = keepBefore(src.readWindow(startPt, endPt, cutoffUs), cutoffUs)
  const ticks = asOf(stableSortTicks(raw, 'us'), cutoffUs)
  const byMinute = isTimeSorted(raw) ? ticks : stableSortTicks(raw, 'ptMin')
  return { ticks, byMinute }
}

/**
 * 1m bars + volume-at-price for a cut window. Completed bars take their
 * order-sensitive fields (open, close, delta path) from file order within the
 * minute; the bar of `partialMinutePt` (the fill's minute) is the partial entry
 * bar built from time-sorted ticks. Pass NaN when there's no partial bar.
 */
function windowBars(ticks: TickFrame, byMinute: TickFrame, partialMinutePt: number) {
  const { bars, vap } = aggregateMinutes(ticks)
  const nBars = bars.t.length
  const hasPartial = nBars > 0 && bars.t[nBars - 1] * 1000 === partialMinutePt
  const nDone = hasPartial ? nBars - 1 : nBars
  if (byMinute !== ticks) {
    const m = aggregateMinutes(byMinute).bars
    for (let i = 0; i < nDone; i++) {
      bars.o[i] = m.o[i]; bars.c[i] = m.c[i]; bars.d[i] = m.d[i]; bars.dmin[i] = m.dmin[i]; bars.dmax[i] = m.dmax[i]
    }
  }
  return { bars, vap, hasPartial, nDone }
}

/**
 * Where a snapshot's window starts: 06:30 PT of the most recent earlier session
 * with RTH trading. The hosted route uses this to know which tape hours to
 * fetch before it can build.
 */
export function snapshotWindow(src: TickSource, entryUtcMs: number): { startPt: number; entryPt: number; priorDate: string } | null {
  const entryPt = utcToPtMs(entryUtcMs)
  const prior = priorRthDate(src, tradingDate(Math.floor(entryPt / 60_000) * 60_000))
  return prior ? { startPt: ptMidnight(prior) + 6.5 * HOUR, entryPt, priorDate: prior } : null
}

/** `source` defaults to the local Sierra files; the hosted route passes the published tape. */
export function buildSnapshot(req: SnapshotRequest, source?: TickSource): DeepDiveSnapshot {
  const fs = source ?? new ScidTickSource(req.root, req.dataDir ?? SIERRA_DATA_DIR)
  try {
    const entryPt = utcToPtMs(req.entryUtcMs)
    const emin = Math.floor(entryPt / 60_000) * 60_000
    const tdate = tradingDate(emin)
    const cal = ptMidnight(tdate)
    const rthOpen = cal + 6.5 * HOUR, rthClose = cal + 13 * HOUR, ibEnd = cal + 7.5 * HOUR
    const prior = priorRthDate(fs, tdate)
    if (!prior) throw new Error(`no prior RTH session found before ${tdate}`)
    const pOpen = ptMidnight(prior) + 6.5 * HOUR, pClose = ptMidnight(prior) + 13 * HOUR

    // ---- the blind cut: nothing at or after the fill second ----
    const cutoffUs = utcMsToSierraUs(req.entryUtcMs)
    const blind = !(req.displayEndUtcMs != null && req.displayEndUtcMs > req.entryUtcMs)
    const endUtcMs = blind ? req.entryUtcMs : req.displayEndUtcMs!
    const endUs = utcMsToSierraUs(endUtcMs)
    const all = cutWindow(fs, pOpen, utcToPtMs(endUtcMs), endUs)
    const ticks = blind ? all.ticks : asOf(all.ticks, cutoffUs)
    const byMinute = all.byMinute === all.ticks ? ticks : keepBefore(all.byMinute, cutoffUs)

    const { bars, vap, hasPartial, nDone } = windowBars(ticks, byMinute, emin)
    const nBars = bars.t.length

    // ---- weekly references ----
    const anchor = weeklyAnchor(entryPt)
    let weekOpen: number | null = null
    if (anchor >= pOpen) {
      // the week opened inside the window: its first completed bar at/after the anchor
      for (let i = 0; i < nDone; i++) if (bars.t[i] * 1000 >= anchor) { weekOpen = bars.o[i]; break }
    } else {
      // the week opened before the window: first trade at/after Sunday 15:00 in that day's front month
      weekOpen = fs.firstTradePrice(anchor, Math.min(anchor + DAY, emin))
    }
    if (weekOpen == null && hasPartial) weekOpen = bars.o[nBars - 1]
    let pwh: number | null = null, pwl: number | null = null
    for (let d = tradingDate(anchor - 7 * DAY); d <= tradingDate(anchor - 1); d = addDays(d, 1)) {
      const x = fs.extremes(d, anchor - 7 * DAY, anchor)
      if (x.h != null && (pwh == null || x.h > pwh)) pwh = x.h
      if (x.l != null && (pwl == null || x.l < pwl)) pwl = x.l
    }

    const levels = levelsAsOf({
      bars, vap, entry: entryPt, rthOpen, rthClose, ibEnd, priorOpen: pOpen, priorClose: pClose, tdate,
      weekOpen, priorWeek: { high: pwh, low: pwl },
    })

    // ---- session times (PT-clock seconds) ----
    let ethStart = emin
    for (let i = 0; i < nDone; i++) if (tradingDate(bars.t[i] * 1000) === tdate) { ethStart = bars.t[i] * 1000; break }
    const inRth = rthOpen <= entryPt && entryPt < rthClose
    const sec = (ms: number) => Math.floor(ms / 1000)

    const atrFb = atrFallback14(bars.h.slice(0, nDone), bars.l.slice(0, nDone), bars.c.slice(0, nDone))
    const bracket = plannedBracket({
      entryPrice: req.entryPrice, direction: req.direction,
      recordedStop: req.recordedStop, recordedTp: req.recordedTp, entryAtr: req.entryAtr,
      atrFallback: atrFb, atrStopTarget: req.atrStopTarget, tp1RMultiple: req.tp1RMultiple,
    })

    // what the chart shows: the blind cut, or (non-blind review) the window run on past the fill
    const shown = blind ? { bars, vap, hasPartial } : windowBars(all.ticks, all.byMinute, NaN)
    const shownTicks = blind ? ticks : all.ticks
    const B = shown.bars

    const r2 = (a: number[]) => a.map(v => pyRound(v, 2))
    const r0 = (a: number[]) => a.map(v => pyRound(v, 0))
    return {
      row: {
        date: ptDate(entryPt), weekday: WEEKDAY[new Date(entryPt).getUTCDay()], time: ptClock(entryPt),
        inst: req.root, direction: req.direction, price: req.entryPrice,
      },
      cutoff_label: ptClock(entryPt - 1000),
      has_partial: shown.hasPartial,
      tick: TICK,
      times: {
        entry: sec(entryPt), rth_open: sec(rthOpen), rth_close: sec(rthClose), ib_end: sec(ibEnd),
        prior_open: sec(pOpen), prior_close: sec(pClose), eth_start: sec(ethStart),
        profile_anchor: sec(inRth ? rthOpen : ethStart), in_rth: inRth,
      },
      bars: {
        t: B.t, o: r2(B.o), h: r2(B.h), l: r2(B.l), c: r2(B.c),
        v: r0(B.v), bv: r0(B.bv), av: r0(B.av), d: r0(B.d), dmin: r0(B.dmin), dmax: r0(B.dmax),
        pv: r2(B.pv), vv: r0(B.vv),
      },
      vap: shown.vap,
      levels,
      lpt: BUBBLE_CFG[req.root].lpt,
      bracket,
      bubbles: bubbles40t(shownTicks, req.root),
      cut: {
        blind,
        fill_utc: new Date(req.entryUtcMs).toISOString(),
        data_end_utc: new Date(endUtcMs).toISOString(),
        last_tick_utc: shownTicks.n ? new Date(sierraUsToUtcMs(shownTicks.us[shownTicks.n - 1])).toISOString() : null,
        ticks: shownTicks.n,
        contracts: fs.names(),
      },
    }
  } finally {
    fs.close()
  }
}

/** Internal: the raw cut tick frame for a request (parity diagnostics only). */
export function snapshotTicksForTest(req: SnapshotRequest, source?: TickSource): TickFrame {
  const fs = source ?? new ScidTickSource(req.root, req.dataDir ?? SIERRA_DATA_DIR)
  try {
    const entryPt = utcToPtMs(req.entryUtcMs)
    const tdate = tradingDate(Math.floor(entryPt / 60_000) * 60_000)
    const prior = priorRthDate(fs, tdate)
    if (!prior) return emptyTicks()
    return cutWindow(fs, ptMidnight(prior) + 6.5 * HOUR, entryPt, utcMsToSierraUs(req.entryUtcMs)).ticks
  } finally {
    fs.close()
  }
}
