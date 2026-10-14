import { mfeMaePoints, type TradeWithExcursion } from '@/lib/analytics'
import { symbolToMultiplier } from '@/lib/futures-symbols'

/**
 * Trade management — the ONE definition behind every "how much did I keep"
 * number in the app (dashboard card, recap card, trade rows, recent days).
 *
 * Before this module there were eight different "capture" formulas: per-trade,
 * dollar-pooled, a mean of daily values, a trade-weighted mean of daily values,
 * a mean of clamped ratios, winners-only, losers-as-zero, and an AI estimate.
 * The same two trades read 0%, 50%, 54%, 80% and 100% depending on the page.
 * They also all counted a trade that never went anywhere as a failed EXIT,
 * which points the trader at the wrong mistake.
 *
 * So every trade is sorted into one of two groups first:
 *
 *   went your way    — it was up at least 1×ATR at some point
 *   never got going  — it wasn't (an entry problem, not an exit one)
 *
 * and carries three raw facts in one unit: MFE (best point), MAE (worst point)
 * and the result. "Kept" is then just result ÷ MFE over the trades that went
 * your way, with losses subtracted — what actually ended up in the account.
 *
 * Everything is stored as SUMS + COUNTS so a week, a month or a setup is the
 * same arithmetic over more trades, never an average of daily averages.
 */

export type MgmtUnit = 'pts' | 'dollars' | 'atr'
export const MGMT_UNITS: readonly MgmtUnit[] = ['pts', 'dollars', 'atr']

/** How far a trade must travel in your favor to count as "went your way". */
export const WENT_YOUR_WAY_ATR = 1

/** The trade fields the classification reads (superset-safe). */
export interface MgmtTradeInput {
  id?: string | null
  pnl: number | null
  direction: 'long' | 'short' | null
  entry_price: number | null
  exit_price?: number | null
  stop_price?: number | null
  high_during_position: number | null
  low_during_position: number | null
  quantity: number | null
  symbol: string | null
  entry_atr_1m?: number | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exits_json?: any
}

/** One trade's read, in all three units. Magnitudes for MFE/MAE; result signed. */
export interface TradeMgmt {
  went: boolean
  mfe: Record<MgmtUnit, number | null>
  mae: Record<MgmtUnit, number | null>
  result: Record<MgmtUnit, number | null>
  /** Result ÷ MFE for THIS trade, 0..1. Null unless it went your way. */
  kept: number | null
}

export interface MgmtSums { n: number; mfe: number; mae: number; res: number }
export type MgmtUnitSums = Record<MgmtUnit, MgmtSums>

/** Sums + counts for a set of trades. JSON-safe — cached in `stats_json`. */
export interface MgmtTotals {
  went: { count: number; red: number; sums: MgmtUnitSums }
  never: { count: number; sums: MgmtUnitSums }
  /** Trades that could not be sorted (no price range, or no ATR and no stop). */
  unclassified: number
}

const zeroSums = (): MgmtSums => ({ n: 0, mfe: 0, mae: 0, res: 0 })
const zeroUnitSums = (): MgmtUnitSums => ({ pts: zeroSums(), dollars: zeroSums(), atr: zeroSums() })

export function emptyMgmtTotals(): MgmtTotals {
  return {
    went: { count: 0, red: 0, sums: zeroUnitSums() },
    never: { count: 0, sums: zeroUnitSums() },
    unclassified: 0,
  }
}

/** Contracts actually traded: the exit fills when present, else the quantity
 *  field. The two can disagree on edited rows, and P&L follows the fills. */
function tradedQty(t: MgmtTradeInput): number | null {
  const legs = Array.isArray(t.exits_json) ? t.exits_json : []
  let fills = 0
  for (const l of legs) fills += Number(l?.qty) || 0
  if (fills > 0) return fills
  return t.quantity != null && t.quantity > 0 ? t.quantity : null
}

/** The three raw facts of one trade, in every unit. No sorting — a trade with
 *  no ATR and no stop still has a best point, a worst point and a result. */
export interface TradeFacts {
  mfe: Record<MgmtUnit, number | null>
  mae: Record<MgmtUnit, number | null>
  result: Record<MgmtUnit, number | null>
  /** ATR used for the ×ATR values (live override, else stored). Null = none. */
  atr: number | null
  /** Planned risk in points, when a stop is logged. */
  riskPts: number | null
}

/**
 * MFE, MAE and result for one trade in points, dollars and ×ATR. Null when the
 * trade has no P&L or no usable price range.
 *
 * `atr` overrides the trade's stored entry ATR (the recap passes the trader's
 * configured live ATR).
 */
export function tradeFacts(t: MgmtTradeInput, opts: { atr?: number | null } = {}): TradeFacts | null {
  if (t.pnl == null || t.entry_price == null || t.direction == null) return null
  const xc = mfeMaePoints(t as unknown as TradeWithExcursion)
  if (!xc) return null
  const qty = tradedQty(t)
  if (qty == null) return null
  const mult = symbolToMultiplier(t.symbol ?? '')
  if (!(mult > 0)) return null

  const atrRaw = opts.atr ?? t.entry_atr_1m ?? null
  const atr = atrRaw != null && atrRaw > 0 ? atrRaw : null
  const riskRaw = t.stop_price != null ? Math.abs(t.entry_price - t.stop_price) : null
  const riskPts = riskRaw != null && riskRaw > 0 ? riskRaw : null

  const resPts = t.pnl / (qty * mult)
  // You cannot bank more than the best price the trade reached, so a positive
  // result is a floor on the favorable move. Fill-vs-logged-price rounding
  // otherwise leaves a perfect exit reading a hair over 100%.
  const mfePts = resPts > 0 ? Math.max(xc.mfe, resPts) : xc.mfe
  const maePts = xc.mae
  const usd = qty * mult
  return {
    mfe: { pts: mfePts, dollars: mfePts * usd, atr: atr != null ? mfePts / atr : null },
    mae: { pts: maePts, dollars: maePts * usd, atr: atr != null ? maePts / atr : null },
    result: { pts: resPts, dollars: t.pnl, atr: atr != null ? resPts / atr : null },
    atr,
    riskPts,
  }
}

/**
 * Sort one trade and express it in every unit. Null when it can't be sorted:
 * no P&L, no price range, or nothing to measure "1 unit" against (no ATR at
 * entry and no stop).
 *
 * `atr` overrides the trade's stored entry ATR; `thresholdAtr` is the trader's
 * "was up" multiple (Settings → ATR measurement).
 */
export function tradeMgmt(
  t: MgmtTradeInput,
  opts: { atr?: number | null; thresholdAtr?: number } = {},
): TradeMgmt | null {
  const f = tradeFacts(t, opts)
  if (!f) return null
  const multiple = opts.thresholdAtr != null && opts.thresholdAtr > 0 ? opts.thresholdAtr : WENT_YOUR_WAY_ATR
  // 1×ATR is the unit; a trade with no ATR falls back to its own planned risk.
  const threshold = f.atr != null ? multiple * f.atr : f.riskPts
  if (threshold == null) return null
  const mfePts = f.mfe.pts as number, resPts = f.result.pts as number
  const went = mfePts >= threshold - 1e-9
  return {
    went,
    mfe: f.mfe,
    mae: f.mae,
    result: f.result,
    kept: went && mfePts > 0 ? Math.max(0, Math.min(1, resPts / mfePts)) : null,
  }
}

function addInto(sums: MgmtUnitSums, m: TradeMgmt): void {
  for (const u of MGMT_UNITS) {
    const mfe = m.mfe[u], mae = m.mae[u], res = m.result[u]
    if (mfe == null || mae == null || res == null) continue
    const s = sums[u]
    s.n += 1; s.mfe += mfe; s.mae += mae; s.res += res
  }
}

/** Sort and sum a set of trades. `atrByTradeId` supplies live ATRs by id. */
export function mgmtTotals(
  trades: MgmtTradeInput[],
  opts: { atrByTradeId?: Record<string, number>; thresholdAtr?: number } = {},
): MgmtTotals {
  const tot = emptyMgmtTotals()
  for (const t of trades) {
    const live = t.id != null ? opts.atrByTradeId?.[t.id] : undefined
    const m = tradeMgmt(t, { atr: live, thresholdAtr: opts.thresholdAtr })
    if (!m) { tot.unclassified += 1; continue }
    if (m.went) {
      tot.went.count += 1
      if ((t.pnl ?? 0) < 0) tot.went.red += 1
      addInto(tot.went.sums, m)
    } else {
      tot.never.count += 1
      addInto(tot.never.sums, m)
    }
  }
  return tot
}

function mergeSums(a: MgmtUnitSums, b: MgmtUnitSums | undefined): void {
  if (!b) return
  for (const u of MGMT_UNITS) {
    const s = b[u]
    if (!s) continue
    a[u].n += s.n || 0; a[u].mfe += s.mfe || 0; a[u].mae += s.mae || 0; a[u].res += s.res || 0
  }
}

/** Pool several sets (e.g. a period's days) into one — plain addition. */
export function mergeMgmtTotals(list: (MgmtTotals | null | undefined)[]): MgmtTotals {
  const tot = emptyMgmtTotals()
  for (const t of list) {
    if (!t) continue
    tot.went.count += t.went?.count || 0
    tot.went.red += t.went?.red || 0
    tot.never.count += t.never?.count || 0
    tot.unclassified += t.unclassified || 0
    mergeSums(tot.went.sums, t.went?.sums)
    mergeSums(tot.never.sums, t.never?.sums)
  }
  return tot
}

export interface MgmtGroupView {
  count: number
  /** Per-trade averages in the chosen unit; null when no trade carries it. */
  mfe: number | null
  mae: number | null
  result: number | null
}

export interface MgmtView {
  went: MgmtGroupView & {
    /** Result ÷ MFE over the group, 0..1, losses subtracted. Null when empty. */
    keptPct: number | null
    /** How many of these still closed at a loss. */
    red: number
  }
  never: MgmtGroupView
  /** Average result per sorted trade, in the chosen unit. */
  net: number | null
  /** What `net` is made of: how many trades it averages over, and their summed
   *  result. The card names the count on the line itself — "Net per trade"
   *  alone was read as the two rows above subtracted. */
  netCount: number
  netTotal: number | null
  classified: number
  unclassified: number
}

const avg = (sum: number, n: number): number | null => (n > 0 ? sum / n : null)

/** Read a set of totals in one unit — what the card and the tables render. */
export function mgmtView(tot: MgmtTotals, unit: MgmtUnit): MgmtView {
  const w = tot.went.sums[unit], n = tot.never.sums[unit]
  const netN = w.n + n.n
  return {
    went: {
      count: tot.went.count,
      mfe: avg(w.mfe, w.n),
      mae: avg(w.mae, w.n),
      result: avg(w.res, w.n),
      keptPct: w.n > 0 && w.mfe > 0 ? Math.max(0, Math.min(1, w.res / w.mfe)) : null,
      red: tot.went.red,
    },
    never: {
      count: tot.never.count,
      mfe: avg(n.mfe, n.n),
      mae: avg(n.mae, n.n),
      result: avg(n.res, n.n),
    },
    net: netN > 0 ? (w.res + n.res) / netN : null,
    netCount: netN,
    netTotal: netN > 0 ? w.res + n.res : null,
    classified: tot.went.count + tot.never.count,
    unclassified: tot.unclassified,
  }
}

/**
 * Shared geometry for the two card rows (and a trade row): one scale and one
 * entry line for both, so red always runs left of entry and green right of it.
 * Returns percentages of the bar width.
 */
export interface MgmtBarGeometry {
  /** Where the entry line sits, 0..100. */
  zero: number
  maeLeft: number
  maeWidth: number
  mfeWidth: number
  /** The solid part: what was kept (right of entry) or lost (left of it). */
  solidLeft: number
  solidWidth: number
  solidSide: 'kept' | 'lost' | 'none'
}

export function mgmtBarGeometry(
  row: { mfe: number | null; mae: number | null; result: number | null },
  scale: { maxMae: number; maxMfe: number },
): MgmtBarGeometry | null {
  const total = scale.maxMae + scale.maxMfe
  if (!(total > 0) || row.mfe == null || row.mae == null) return null
  const pct = (x: number) => (Math.max(0, x) / total) * 100
  const zero = pct(scale.maxMae)
  const res = row.result ?? 0
  const solidWidth = res > 0 ? pct(Math.min(res, row.mfe)) : pct(Math.min(-res, scale.maxMae))
  return {
    zero,
    maeLeft: zero - pct(row.mae),
    maeWidth: pct(row.mae),
    mfeWidth: pct(row.mfe),
    solidLeft: res > 0 ? zero : zero - solidWidth,
    solidWidth,
    solidSide: res > 0 ? 'kept' : res < 0 ? 'lost' : 'none',
  }
}

/** "45%" for a 0..1 ratio; "—" when there is nothing to measure. */
export function formatKept(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—'
  return `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`
}

/**
 * How a trade ended, read off its own fills against its own plan:
 *
 *   target  — some exit fill printed at or through the logged target
 *   stopped — it closed for a loss at (or within a hair of) the logged stop
 *   manual  — anything else: the trader closed it by hand
 *
 * The first two are the plan running its course; only a manual exit is a
 * decision worth a verdict. Null when there is nothing to read (no fills).
 */
export type ExitKind = 'target' | 'stopped' | 'manual'

/** Share of planned risk a losing exit must give up to count as "at the stop".
 *  A stop logged off a screenshot can sit a point from the working order. */
const STOPPED_RISK_SHARE = 0.85

export function exitKind(t: MgmtTradeInput & { tp1_price?: number | null }): ExitKind | null {
  if (t.entry_price == null || t.direction == null) return null
  const sign = t.direction === 'long' ? 1 : -1
  const legs = Array.isArray(t.exits_json) ? t.exits_json : []
  const prices: number[] = []
  for (const l of legs) { const p = Number(l?.price); if (Number.isFinite(p)) prices.push(p) }
  if (prices.length === 0 && t.exit_price != null) prices.push(t.exit_price)
  if (prices.length === 0) return null
  const entry = t.entry_price
  const tp = t.tp1_price
  if (tp != null && (tp - entry) * sign > 0 && prices.some(p => (p - tp) * sign >= -1e-9)) return 'target'
  const stop = t.stop_price
  if (stop != null && (stop - entry) * sign < 0 && (t.pnl ?? 0) < 0) {
    const risk = Math.abs(entry - stop)
    const last = prices[prices.length - 1]
    if (risk > 0 && (entry - last) * sign >= STOPPED_RISK_SHARE * risk) return 'stopped'
  }
  return 'manual'
}
