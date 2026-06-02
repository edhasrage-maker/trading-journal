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

/** Map "MNQM6.CME" → "MNQ", "ESM6.CME" → "ES", "6EM6.CME" → "6E". */
export function symbolRoot(symbol: string): string {
  // Take the part before the first "." (drops .CME, .NYMEX, etc.)
  const noExchange = symbol.split('.')[0]
  // Strip the last contract month code (one letter + one or two digit year)
  // e.g. "MNQM6" → "MNQ", "ZNH26" → "ZN"
  return noExchange.replace(/[A-Z]\d{1,2}$/, '')
}

export function symbolToMultiplier(symbol: string): number {
  return MULTIPLIERS[symbolRoot(symbol)] ?? 1
}
