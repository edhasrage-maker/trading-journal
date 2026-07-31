/**
 * READ-ONLY. Does the condition-verdict banding transfer from NQ to ES?
 *
 * The cuts in src/lib/condition-verdicts.ts were anchored to an NQ 1-minute
 * distribution. Every band is a RATIO (1-min ATR vs its own 10-day ATR, IB vs
 * its own 10-day IB, overnight and day range vs ADR), so in principle they are
 * instrument-neutral. This measures whether that actually holds: if ES's ratio
 * distribution lands where NQ's does, the cuts carry over untouched; if it is
 * shifted, ES sessions get systematically mislabelled.
 *
 * Uses the app's OWN engine (contextStatsForDate) rather than reimplementing
 * the metrics — otherwise this would be testing a second implementation, not
 * the bands the product ships.
 *
 * Writes nothing. Run: npx tsx scripts/check-band-cuts-es-nq.ts [--from YYYY-MM-DD]
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { contextStatsForDate } from '../src/lib/market-context-from-bars.ts'
import type { OneMinBar } from '../src/lib/scid-reader.ts'

for (const l of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const sb = createClient(process.env.PUBLIC_SUPABASE_URL!, process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY!)

const flag = (n: string) => {
  const i = process.argv.indexOf(n)
  return i >= 0 ? process.argv[i + 1] : null
}
const FROM = flag('--from') ?? '2025-09-01'   // ~1 trading year, keeps the pull sane
const TO = flag('--to') ?? '2026-07-30'

/** The cuts as shipped, so the report can show where each percentile FALLS. */
const CUTS = {
  barVol: [
    { max: 0.55, word: 'very compressed' },
    { max: 0.8, word: 'compressed' },
    { max: 1.15, word: 'normal' },
    { max: 1.5, word: 'expanded' },
    { max: Infinity, word: 'very expanded' },
  ],
  rangeUsed: [
    { max: 45, word: 'very tight' },
    { max: 75, word: 'below normal' },
    { max: 115, word: 'normal' },
    { max: 150, word: 'wide' },
    { max: Infinity, word: 'very wide' },
  ],
  overnight: [
    { max: 45, word: 'quiet' },
    { max: 70, word: 'below normal' },
    { max: 100, word: 'normal' },
    { max: 135, word: 'large' },
    { max: Infinity, word: 'very large' },
  ],
  ib: [
    { max: 0.6, word: 'very narrow' },
    { max: 0.85, word: 'narrow' },
    { max: 1.25, word: 'normal' },
    { max: 1.7, word: 'wide' },
    { max: Infinity, word: 'very wide' },
  ],
  rvol: [
    { max: 60, word: 'very quiet' },
    { max: 85, word: 'quiet' },
    { max: 120, word: 'normal' },
    { max: 160, word: 'busy' },
    { max: Infinity, word: 'very busy' },
  ],
} as const

function wordFor(cuts: readonly { max: number; word: string }[], v: number) {
  for (const c of cuts) if (v <= c.max) return c.word
  return cuts[cuts.length - 1].word
}
function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))]
}

async function fetchBars(symbol: string, startIso: string, endIso: string): Promise<OneMinBar[]> {
  const PAGE = 1000
  const out: OneMinBar[] = []
  for (let from = 0; from < 2_000_000; from += PAGE) {
    const { data, error } = await sb
      .from('ohlcv_bars')
      .select('ts, open, high, low, close, volume')
      .eq('symbol', symbol)
      .gte('ts', startIso).lte('ts', endIso)
      .order('ts', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) { console.error(symbol, error.message); break }
    const rows = (data ?? []) as OneMinBar[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

/** Share of sessions landing in each verdict word — the thing that actually
 *  matters. A band that fires on 2% of ES days but 20% of NQ days is broken
 *  even if the medians look close. */
function distribution(label: string, vals: number[], cuts: readonly { max: number; word: string }[]) {
  const s = [...vals].sort((a, b) => a - b)
  const f = (v: number | null) => (v == null ? '—' : v.toFixed(2))
  console.log(`  ${label}`)
  console.log(`    n=${s.length}  p10=${f(pct(s, 10))}  p30=${f(pct(s, 30))}  p50=${f(pct(s, 50))}  p70=${f(pct(s, 70))}  p90=${f(pct(s, 90))}`)
  const counts = new Map<string, number>()
  for (const v of s) counts.set(wordFor(cuts, v), (counts.get(wordFor(cuts, v)) ?? 0) + 1)
  const parts = cuts.map(c => {
    const n = counts.get(c.word) ?? 0
    return `${c.word} ${s.length ? Math.round((n / s.length) * 100) : 0}%`
  })
  console.log(`    ${parts.join(' · ')}`)
}

async function main() {
  const startIso = `${FROM}T00:00:00Z`
  const endIso = `${TO}T23:59:59Z`
  const result: Record<string, Record<string, number[]>> = {}

  for (const sym of ['NQ', 'ES']) {
    process.stdout.write(`\nloading ${sym} bars ${FROM}…${TO} … `)
    const bars = await fetchBars(sym, startIso, endIso)
    console.log(`${bars.length} bars`)
    if (bars.length === 0) continue

    // Distinct PT session dates present in the pull.
    const dates = [...new Set(bars.map(b => b.ts.slice(0, 10)))].sort()
    const acc: Record<string, number[]> = { barVol: [], rangeUsed: [], overnight: [], ib: [], rvol: [] }

    // contextStatsForDate recomputes over EVERY bar it is handed, so passing the
    // full series per sample is quadratic — the first attempt at this ran past
    // ten minutes without finishing. Hand each call only the trailing window it
    // needs: the longest lookback in the engine is a 10-day average, so ~40
    // calendar days is generous cover including weekends and holidays.
    const LOOKBACK_DAYS = 40
    const byDate = new Map<string, OneMinBar[]>()
    for (const b of bars) {
      const d = b.ts.slice(0, 10)
      const arr = byDate.get(d)
      if (arr) arr.push(b); else byDate.set(d, [b])
    }
    const step = Math.max(1, Math.floor(dates.length / 60))
    let used = 0
    for (let i = 0; i < dates.length; i += step) {
      const d = dates[i]
      const cutoff = new Date(new Date(`${d}T00:00:00Z`).getTime() - LOOKBACK_DAYS * 86400_000)
        .toISOString().slice(0, 10)
      const window: OneMinBar[] = []
      for (const dd of dates) {
        if (dd < cutoff || dd > d) continue
        const arr = byDate.get(dd)
        if (arr) window.push(...arr)
      }
      const s = contextStatsForDate(window, d, 'rth')
      if (!s || !s.realized) continue
      used++
      if (s.atr_1m != null && s.atr_eod_10d_avg != null && s.atr_eod_10d_avg > 0) acc.barVol.push(s.atr_1m / s.atr_eod_10d_avg)
      if (s.day_range != null && s.adr != null && s.adr > 0) acc.rangeUsed.push((s.day_range / s.adr) * 100)
      if (s.ib_vs_10d_avg != null) acc.ib.push(s.ib_vs_10d_avg)
      if (s.rvol != null) acc.rvol.push(s.rvol)
    }
    console.log(`  sampled ${used} realized sessions of ${dates.length} dates`)
    result[sym] = acc
  }

  console.log('\n════ Do the NQ-anchored cuts transfer to ES? ════')
  console.log('(percentiles, then the share of sessions each verdict word claims)')
  for (const [key, cuts] of [
    ['barVol', CUTS.barVol], ['rangeUsed', CUTS.rangeUsed], ['ib', CUTS.ib], ['rvol', CUTS.rvol],
  ] as const) {
    console.log(`\n── ${key} ──`)
    for (const sym of ['NQ', 'ES']) {
      if (!result[sym]) continue
      distribution(sym, result[sym][key] ?? [], cuts)
    }
  }
}

main().catch(e => { console.error(e); process.exitCode = 1 })
