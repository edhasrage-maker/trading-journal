import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { TagCategory } from '@/lib/supabase/types'
import { normalizeTagArray } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * Per-tag usage counts across native `trades` + imported `historical_trades`.
 * Returns `{ usage: { "category|label": count } }` — the merge UI joins this
 * with the tag library to show "Used by N trades" beside each chip.
 *
 * Counts are exact (full paginated scan); cheap enough that we don't bother
 * caching. ~5k rows × <10 categories × O(small array) per row finishes in
 * well under a second.
 */

const PAGE = 1000
const CATEGORIES: TagCategory[] = [
  'setups', 'confluences', 'order_flow', 'trade_management', 'day_type', 'mistakes', 'emotions',
]

async function tallyTable(
  supabase: AnyClient,
  table: 'trades' | 'historical_trades',
  counts: Map<string, number>,
): Promise<void> {
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from(table)
      .select('id, tags_json')
      .order('id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) throw new Error(`${table} usage scan: ${error.message}`)
    const rows = (data ?? []) as { tags_json: Record<string, unknown> | null }[]
    for (const r of rows) {
      const tj = r.tags_json ?? {}
      for (const cat of CATEGORIES) {
        for (const label of normalizeTagArray(tj[cat])) {
          if (!label) continue
          const key = `${cat}|${label}`
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
      }
    }
    if (rows.length < PAGE) break
  }
}

export async function GET() {
  const supabase: AnyClient = await createClient()
  const counts = new Map<string, number>()
  try {
    await tallyTable(supabase, 'trades', counts)
    await tallyTable(supabase, 'historical_trades', counts)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Tally failed' },
      { status: 500 },
    )
  }

  const usage: Record<string, number> = {}
  for (const [k, v] of counts) usage[k] = v
  return NextResponse.json({ usage })
}
