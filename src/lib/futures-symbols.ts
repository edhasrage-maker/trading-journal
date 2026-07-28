/**
 * Futures contract multipliers and symbol-root extraction.
 *
 * Single source of truth used by both the SCID importer (to compute P&L) and
 * the analytics layer (to convert between per-contract points and dollar PnL
 * for ratio metrics like capture % and MFE/MAE in $).
 *
 * Defaults to 1 when the symbol root isn't in the table, which gives raw
 * points P&L for unknown instruments — wrong unit but won't crash.
 */

export const MULTIPLIERS: Record<string, number> = {
  // Equity index — E-mini
  ES: 50, NQ: 20, RTY: 50, YM: 5,
  // Equity index — Micro
  MES: 5, MNQ: 2, M2K: 5, MYM: 0.5,
  // Metals
  GC: 100, MGC: 10, SI: 5000, SIL: 1000, HG: 25000, MHG: 2500, PL: 50,
  // Energy
  CL: 1000, MCL: 100, NG: 10000, RB: 42000, HO: 42000,
  // Currencies (per full point)
  '6E': 125000, '6B': 62500, '6J': 12500000, '6A': 100000, '6C': 100000,
  // Interest rate / bonds
  ZN: 1000, ZB: 1000, ZF: 1000, ZT: 2000,
  // Grains
  ZC: 50, ZS: 50, ZW: 50,
}

/**
 * Map "MNQM6.CME" → "MNQ", "ESM6.CME" → "ES", "6EM6.CME" → "6E",
 * "NQU26-CME" → "NQ".
 *
 * Sierra writes the exchange suffix with EITHER separator depending on where
 * the symbol came from — "NQU26.CME" in some exports, "NQU26-CME" in others.
 * Splitting on "." alone left the hyphen form entirely unparsed, so
 * "NQU26-CME" came back as its own root. The visible symptom was a duplicate
 * raw contract sitting next to "NQ" in the chart's instrument dropdown, but
 * that was the harmless half: `symbolToMultiplier` keys off this too, and an
 * unrecognised root silently falls back to a multiplier of 1 — so every dollar
 * figure derived from such a trade (MFE/MAE in $, capture %, per-leg MFE) came
 * out 20× too small for NQ and 50× for ES.
 *
 * No futures root contains "." or "-", so splitting on either is safe.
 */
export function symbolRoot(symbol: string): string {
  // Take the part before the first "." or "-" (drops .CME / -CME / .NYMEX …)
  const noExchange = symbol.split(/[.-]/)[0]
  // Strip the last contract month code (one letter + one or two digit year)
  // e.g. "MNQM6" → "MNQ", "ZNH26" → "ZN"
  return noExchange.replace(/[A-Z]\d{1,2}$/, '')
}

/**
 * Micro → mini price-series collapse. Micros trade at the SAME price as their
 * mini (MNQ≈NQ, MES≈ES, …), so one shared bar series serves both. Used by the
 * cloud LiveChart so any trade symbol (micro, mini, or dated contract) resolves
 * to the single root the central bar feed stores bars under. Falls back to the
 * plain root for anything not in the map.
 */
const MICRO_TO_MINI: Record<string, string> = {
  MNQ: 'NQ', MES: 'ES', MYM: 'YM', M2K: 'RTY', MCL: 'CL', MGC: 'GC',
}
export function chartSeriesRoot(symbol: string): string {
  const root = symbolRoot(symbol)
  return MICRO_TO_MINI[root] ?? root
}

export function symbolToMultiplier(symbol: string): number {
  return MULTIPLIERS[symbolRoot(symbol)] ?? 1
}

/**
 * Micro contract → its MINI contract symbol, keeping the contract suffix:
 * "MESU6.CME" → "ESU6.CME", "MNQU6.CME" → "NQU6.CME". Non-micros unchanged.
 * Micros trade the same price series as their mini, so when a micro trade's
 * bars aren't stored under its own symbol we fall back to the mini's bars.
 */
export function miniContractSymbol(symbol: string): string {
  const root = symbolRoot(symbol)
  const mini = MICRO_TO_MINI[root]
  if (!mini) return symbol
  return mini + symbol.slice(root.length)
}
