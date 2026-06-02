import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

interface DistributionStats {
  count: number
  min: number | null
  p33: number | null   // 33rd percentile — anything below = LOW bucket
  p67: number | null   // 67th percentile — anything above = HIGH bucket
  max: number | null
  median: number | null
}

const FIELDS = ['rvol', 'adr', 'atr_1m'] as const
type Field = typeof FIELDS[number]

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

/**
 * GET /api/market-context/distribution
 *
 * Returns the historical distribution (p33 / p67 / median / range) of the
 * three stats the prep MarketContextForm asks about: rvol, adr, atr_1m.
 * Drives the auto LOW/MID/HIGH pills in the form — anything below p33 is LOW,
 * between p33 and p67 is MID, above p67 is HIGH. Tertile split matches the
 * journal's existing condition_lookup convention.
 *
 * Paginates through market_context past the Supabase 1000-row cap. Returns
 * `null` percentiles when fewer than 5 non-null values exist for a field
 * (not enough signal to classify).
 */
export async function GET() {
  const supabase: AnyClient = await createClient()

  const PAGE = 1000
  const rows: Array<Partial<Record<Field, number | null>>> = []
  for (let p = 0; p < 20; p++) {
    const { data, error } = await supabase
      .from('market_context')
      .select('rvol, adr, atr_1m, id')
      .order('id')
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const batch = (data ?? []) as Array<Partial<Record<Field, number | null>>>
    rows.push(...batch)
    if (batch.length < PAGE) break
  }

  const result: Record<Field, DistributionStats> = {} as never
  for (const f of FIELDS) {
    const values: number[] = []
    for (const r of rows) {
      const v = r[f]
      if (v != null && Number.isFinite(v)) values.push(v as number)
    }
    if (values.length < 5) {
      result[f] = { count: values.length, min: null, p33: null, p67: null, max: null, median: null }
      continue
    }
    values.sort((a, b) => a - b)
    result[f] = {
      count: values.length,
      min: values[0],
      max: values[values.length - 1],
      median: percentile(values, 0.5),
      p33: percentile(values, 1 / 3),
      p67: percentile(values, 2 / 3),
    }
  }

  return NextResponse.json(result)
}
