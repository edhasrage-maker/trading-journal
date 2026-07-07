import type { TagCategory } from '@/lib/supabase/types'
import { normalizeTagArray } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const PAGE = 1000

/**
 * Rewrite one tag label across every row of `table`, in place.
 *   toLabel = string → replace `fromLabel` with it (merge / recategorize).
 *   toLabel = null   → REMOVE `fromLabel` entirely (delete).
 *
 * Handles both JSONB shapes: the standard array (`tags_json[category]` is a
 * string[]) and the legacy single-string `day_type`. Deduped. Returns the
 * number of rows updated. Shared by the merge and delete tag routes so both
 * use the same paginated, legacy-aware rewrite.
 */
export async function rewriteTagInTable(
  supabase: AnyClient,
  table: 'trades' | 'historical_trades',
  category: TagCategory,
  fromLabel: string,
  toLabel: string | null,
): Promise<number> {
  const ids = new Set<string>()
  const cache = new Map<string, Record<string, unknown>>()

  // Pass 1: contains-array (the standard JSONB shape).
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from(table)
      .select('id, tags_json')
      .contains('tags_json', { [category]: [fromLabel] })
      .order('id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) throw new Error(`${table} contains-query: ${error.message}`)
    const rows = (data ?? []) as { id: string; tags_json: Record<string, unknown> | null }[]
    for (const r of rows) {
      ids.add(r.id)
      cache.set(r.id, r.tags_json ?? {})
    }
    if (rows.length < PAGE) break
  }

  // Pass 2: legacy single-string day_type. Only meaningful for day_type tags.
  if (category === 'day_type') {
    for (let page = 0; ; page++) {
      const { data, error } = await supabase
        .from(table)
        .select('id, tags_json')
        .eq('tags_json->>day_type', fromLabel)
        .order('id', { ascending: true })
        .range(page * PAGE, page * PAGE + PAGE - 1)
      if (error) throw new Error(`${table} legacy-day_type query: ${error.message}`)
      const rows = (data ?? []) as { id: string; tags_json: Record<string, unknown> | null }[]
      for (const r of rows) {
        ids.add(r.id)
        cache.set(r.id, r.tags_json ?? {})
      }
      if (rows.length < PAGE) break
    }
  }

  // Rewrite each matching row and update in place. One UPDATE per row keeps it
  // simple; merge/delete volumes are small enough that this is fine.
  let count = 0
  for (const id of ids) {
    const tagsJson = { ...(cache.get(id) ?? {}) }
    const arr = normalizeTagArray(tagsJson[category])
    const rewritten = Array.from(new Set(
      toLabel == null
        ? arr.filter(l => l !== fromLabel)
        : arr.map(l => (l === fromLabel ? toLabel : l)),
    ))
    if (rewritten.length > 0) {
      tagsJson[category] = rewritten
    } else {
      delete tagsJson[category]
    }
    const { error } = await supabase
      .from(table)
      .update({ tags_json: tagsJson })
      .eq('id', id)
    if (error) throw new Error(`${table} update id=${id}: ${error.message}`)
    count++
  }
  return count
}
