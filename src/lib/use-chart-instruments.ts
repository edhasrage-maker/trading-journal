import { useState, useEffect, useMemo } from 'react'
import { chartSeriesRoot } from '@/lib/futures-symbols'
import type { Trade } from '@/lib/supabase/types'

export interface ChartInstruments {
  /** Concrete symbol to load bars for (resolves the active root → a bar symbol). */
  activeSymbol: string | null
  /** Dropdown options for LiveChart — { symbol: bar symbol, label: "ES"/"NQ" }. */
  symbolOptions: Array<{ symbol: string; label: string }>
  onSymbolChange: (symbol: string) => void
  /** Trades filtered to the active product root (so the other instrument's fills
   *  don't plot off-scale). Pass-through when there's only one instrument. */
  chartTrades: Trade[]
  /** Whether a trade's instrument has imported bars (its stored ATR/MFE/MAE are
   *  trustworthy only then). */
  tradeHasBars: (t: Trade) => boolean
}

/**
 * Instrument-switcher state for a LiveChart, shared by the intraday / EOD / prep
 * charts. Builds the ES/NQ dropdown (collapsed to product roots) from the day's
 * traded symbols ∪ every instrument with imported bars, tracks the picked root,
 * resolves it to a concrete bar symbol, and filters the plotted trades to it.
 * `chartSymbol` is the page's default (most-common traded symbol).
 */
export function useChartInstruments(chartSymbol: string | null, trades: Trade[]): ChartInstruments {
  const [availableSymbols, setAvailableSymbols] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    fetch('/api/bars/symbols')
      .then(r => (r.ok ? r.json() : { symbols: [] }))
      .then((d: { symbols?: string[] }) => { if (!cancelled) setAvailableSymbols(Array.isArray(d.symbols) ? d.symbols : []) })
      .catch(() => { /* best-effort — dropdown just won't offer extra products */ })
    return () => { cancelled = true }
  }, [])

  const [rootOverride, setRootOverride] = useState<string | null>(null)
  // Group traded + imported symbols by PRODUCT ROOT (ES, NQ); micros collapse to
  // their mini. Each root → one concrete symbol to load bars for (prefer one
  // that has imported bars).
  const rootOptions = useMemo(() => {
    const byRoot = new Map<string, string>()
    for (const s of availableSymbols) { const r = chartSeriesRoot(s); if (!byRoot.has(r)) byRoot.set(r, s) }
    for (const t of trades) { if (t.symbol) { const r = chartSeriesRoot(t.symbol); if (!byRoot.has(r)) byRoot.set(r, t.symbol) } }
    if (chartSymbol) { const r = chartSeriesRoot(chartSymbol); if (!byRoot.has(r)) byRoot.set(r, chartSymbol) }
    return Array.from(byRoot.entries()).map(([root, symbol]) => ({ root, symbol }))
  }, [availableSymbols, trades, chartSymbol])

  const defaultRoot = chartSymbol ? chartSeriesRoot(chartSymbol) : null
  const activeRoot = (rootOverride && rootOptions.some(o => o.root === rootOverride)) ? rootOverride : defaultRoot
  const activeSymbol = rootOptions.find(o => o.root === activeRoot)?.symbol ?? chartSymbol
  const chartTrades = useMemo(
    () => (rootOptions.length > 1 ? trades.filter(t => !!t.symbol && chartSeriesRoot(t.symbol) === activeRoot) : trades),
    [trades, rootOptions.length, activeRoot],
  )
  const availableRoots = useMemo(() => new Set(availableSymbols.map(chartSeriesRoot)), [availableSymbols])

  return {
    activeSymbol,
    symbolOptions: rootOptions.map(o => ({ symbol: o.symbol, label: o.root })),
    onSymbolChange: (s: string) => setRootOverride(chartSeriesRoot(s)),
    chartTrades,
    tradeHasBars: (t: Trade) => availableRoots.size === 0 || !t.symbol || availableRoots.has(chartSeriesRoot(t.symbol)),
  }
}
