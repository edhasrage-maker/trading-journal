/**
 * The entry rules' snapshot of a fill — what had printed BEFORE it — read off
 * the same ticks the trade Score reads (src/lib/entry-rules.ts grades it).
 *
 * Pure: ticks in, snapshot out. No I/O, no clock.
 *
 * WHAT IS KEPT
 *   bars        the last ENTRY_CTX_BARS closed 1-minute regular candles before
 *               the minute the fill is in, oldest first — counted by position
 *               (a minute with no trades is not a candle), each with the
 *               numbers a rule needs about the candles before IT: simple ATR of
 *               the 10 before, median volume and median |delta| of the 10
 *               before, and its Heiken Ashi colour
 *   tape        the Tape Reader as the rules read it: ask share of every trade
 *               in the 480 seconds before the fill, minus 50 (the research's
 *               window — founder's choice, 2026-10-14)
 *   tape_clock  the Tape Reader as the trader's study draws it: the last 8 clock
 *               minutes including the one forming at the fill (what the Score's
 *               fifth fact reads); kept for the coach, not graded
 *
 * NO LOOK-AHEAD. Candles use only trades stamped before the fill's minute; the
 * tape uses only trades stamped before the fill. scripts/test-entry-rules-
 * parity.ts changes every trade at and after the fill and checks nothing moves.
 *
 * MATCHING THE RESEARCH (NQ_backtest/delta_bars/entries_2026-09-30):
 *   true range  max(h, prev c) − min(l, prev c); the first candle's is its range
 *               (o10_lock4_and_deltafade.py:8)
 *   ATR         tr.rolling(10).mean().shift(1)
 *   medians     v.rolling(10).median().shift(1) — the pandas median (mean of the
 *               middle two of ten) (c1_combo.py:23)
 *   Heiken Ashi hc = (o+h+l+c)/4, ho0 = (o0+c0)/2, ho = (ho_prev + hc_prev)/2,
 *               colour = sign(hc − ho) (w2_ha_runs.py:14-16). The research
 *               seeded it on Jan 1 and ran it continuously; here it is seeded
 *               where the ticks start (15:00 PT the day before). The seed's
 *               weight halves every candle, so after the ~900 candles before
 *               the open it cannot change a colour.
 *   tape        8 bins of 60 s counted back from the fill: trades aged
 *               0 ≤ age < 480 s; no volume → 0 (c10_tape_trades.py:33-42)
 */
import type { EntryCtxBar } from '@/lib/supabase/types'
import { flowBars, ptHm, ptHms, US_MIN, type FlowTicks } from './flow-score'

export { ENTRY_CTX_VERSION } from './flow-score-meta'
/** Closed candles kept per fill (entry rules look back at most 10). */
export const ENTRY_CTX_BARS = 12
const TAPE_WINDOW_US = 480 * 1_000_000
const STUDY_BARS = 8

export interface EntryContextRead {
  read_at: string
  bars: EntryCtxBar[]
  tape: number | null
  tape_clock: number | null
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4

function median10(a: number[], end: number): number | null {
  if (end < 10) return null
  const w = a.slice(end - 10, end).sort((x, y) => x - y)
  return (w[4] + w[5]) / 2
}

/** Ticks whose time passes `keep`, file order kept. */
function select(day: FlowTicks, keep: (t: number) => boolean): FlowTicks {
  let n = 0
  for (let i = 0; i < day.n; i++) if (keep(day.t[i])) n++
  const out: FlowTicks = { n, t: new Float64Array(n), px: new Float64Array(n), v: new Uint32Array(n), bv: new Uint32Array(n), av: new Uint32Array(n) }
  let j = 0
  for (let i = 0; i < day.n; i++) {
    if (!keep(day.t[i])) continue
    out.t[j] = day.t[i]; out.px[j] = day.px[i]; out.v[j] = day.v[i]; out.bv[j] = day.bv[i]; out.av[j] = day.av[i]; j++
  }
  return out
}

/**
 * The snapshot for a fill at `e` (PT µs, after snapEntry). `day` = the
 * session's ticks from 15:00 PT the day before, through at least the fill.
 */
export function readEntryContext(day: FlowTicks, e: number): EntryContextRead {
  const eMin = Math.floor(e / US_MIN) * US_MIN

  // ── closed candles: trades stamped before the fill's minute ──
  const b = flowBars(select(day, t => t < eMin), US_MIN)
  const tr: number[] = new Array(b.n)
  for (let i = 0; i < b.n; i++) tr[i] = i === 0 ? b.h[0] - b.l[0] : Math.max(b.h[i], b.c[i - 1]) - Math.min(b.l[i], b.c[i - 1])
  const absD = b.d.map(Math.abs)
  // Heiken Ashi over every candle from the start of the ticks
  const ha: (-1 | 0 | 1)[] = new Array(b.n)
  let ho = 0, hcPrev = 0
  for (let i = 0; i < b.n; i++) {
    const hc = (b.o[i] + b.h[i] + b.l[i] + b.c[i]) / 4
    ho = i === 0 ? (b.o[0] + b.c[0]) / 2 : (ho + hcPrev) / 2
    ha[i] = Math.sign(hc - ho) as -1 | 0 | 1
    hcPrev = hc
  }
  const bars: EntryCtxBar[] = []
  for (let i = Math.max(0, b.n - ENTRY_CTX_BARS); i < b.n; i++) {
    let atr: number | null = null
    if (i >= 10) { let s = 0; for (let k = i - 10; k < i; k++) s += tr[k]; atr = r4(s / 10) }
    bars.push({
      t: ptHm(b.t[i]), o: b.o[i], h: b.h[i], l: b.l[i], c: b.c[i], v: b.v[i], d: b.d[i],
      atr, mv: median10(b.v, i), md: median10(absD, i), ha: ha[i],
    })
  }

  // ── the Tape Reader, research window: every trade aged 0 ≤ age < 480 s ──
  let sa = 0, sb = 0, any = false
  for (let i = 0; i < day.n; i++) {
    const t = day.t[i]
    if (t >= e || e - t >= TAPE_WINDOW_US) continue
    sa += day.av[i]; sb += day.bv[i]; any = true
  }
  const tape = any ? r4(sa + sb > 0 ? (sa / (sa + sb)) * 100 - 50 : 0) : null

  // ── the Tape Reader as the study draws it: last 8 clock minutes, the forming one included ──
  const live = flowBars(select(day, t => t < e), US_MIN)
  let ra = 0, rb = 0
  for (let k = Math.max(0, live.n - STUDY_BARS); k < live.n; k++) { ra += live.av[k]; rb += live.bv[k] }
  const q = (ra / (ra + rb)) * 100 - 50
  const tapeClock = live.n ? r4(Number.isNaN(q) ? 0 : Math.min(50, Math.max(-50, q))) : null

  return { read_at: ptHms(e), bars, tape, tape_clock: tapeClock }
}
