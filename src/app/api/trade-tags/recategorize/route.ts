import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { TagCategory, TradeTag } from '@/lib/supabase/types'
import { normalizeTagArray } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * Move a tag from one category to another. Two-phase:
 *
 *   1. Rewrite every trade + historical_trade row that uses the tag's label
 *      in its CURRENT category — remove the label there, add it to the NEW
 *      category's array (deduped).
 *   2. Update the trade_tags row's category column.
 *
 *  Phase 1 happens before phase 2 so a halfway failure is safe: the tag
 *  still lives in its old category and the rows we already moved have the
 *  label in BOTH categories temporarily. Re-running the recategorize is
 *  idempotent (the second pass on already-moved rows is a no-op).
 *
 *  Body: { tag_id: string, to_category: TagCategory }
 *  Returns: { ok, from_category, to_category, label, trades_updated,
 *             historical_updated }
 */

const PAGE = 1000

const VALID_CATEGORIES: TagCategory[] = [
  'setups', 'confluences', 'order_flow', 'entry_model', 'trade_management',
  'day_type', 'mistakes', 'emotions',
]

async function rewriteTable(
  supabase: AnyClient,
  table: 'trades' | 'historical_trades',
  fromCategory: TagCategory,
  toCategory: TagCategory,
  label: string,
): Promise<number> {
  // Find rows where tags_json[fromCategory] contains the label as an array
  // element (the standard JSONB shape). Day_type legacy single-string handling
  // mirrors the merge route for completeness.
  const ids = new Set<string>()
  const cache = new Map<string, Record<string, unknown>>()

  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from(table)
      .select('id, tags_json')
      .contains('tags_json', { [fromCategory]: [label] })
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

  if (fromCategory === 'day_type') {
    for (let page = 0; ; page++) {
      const { data, error } = await supabase
        .from(table)
        .select('id, tags_json')
        .eq('tags_json->>day_type', label)
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

  let count = 0
  for (const id of ids) {
    const tagsJson = { ...(cache.get(id) ?? {}) }
    // Remove from old category — handles array shape and legacy string shape.
    const fromArr = normalizeTagArray(tagsJson[fromCategory])
    const filtered = fromArr.filter(l => l !== label)
    if (filtered.length > 0) tagsJson[fromCategory] = filtered
    else delete tagsJson[fromCategory]
    // Add to new category — dedupe so re-running is a no-op.
    const toArr = normalizeTagArray(tagsJson[toCategory])
    if (!toArr.includes(label)) toArr.push(label)
    tagsJson[toCategory] = toArr

    const { error } = await supabase.from(table).update({ tags_json: tagsJson }).eq('id', id)
    if (error) throw new Error(`${table} update id=${id}: ${error.message}`)
    count++
  }
  return count
}

export async function POST(req: Request) {
  const supabase: AnyClient = await createClient()
  const body = await req.json().catch(() => ({})) as { tag_id?: string; to_category?: string }
  const tagId = (body.tag_id ?? '').trim()
  const toCategory = (body.to_category ?? '').trim() as TagCategory

  if (!tagId) {
    return NextResponse.json({ error: 'tag_id is required' }, { status: 400 })
  }
  if (!VALID_CATEGORIES.includes(toCategory)) {
    return NextResponse.json(
      { error: `Invalid to_category: ${toCategory}. Must be one of: ${VALID_CATEGORIES.join(', ')}` },
      { status: 400 },
    )
  }

  const { data: tag } = await supabase
    .from('trade_tags')
    .select('id, category, label')
    .eq('id', tagId)
    .maybeSingle() as { data: Pick<TradeTag, 'id' | 'category' | 'label'> | null }
  if (!tag) {
    return NextResponse.json({ error: 'Tag not found' }, { status: 404 })
  }
  if (tag.category === toCategory) {
    return NextResponse.json(
      { error: `Tag is already in category "${toCategory}" — nothing to do` },
      { status: 400 },
    )
  }

  const fromCategory = tag.category as TagCategory

  // Prevent collision: if a DIFFERENT tag with the same label already exists
  // in the destination category, the user almost certainly wants to merge
  // instead. Bail with a clear message rather than creating a confusing state.
  const { data: collision } = await supabase
    .from('trade_tags')
    .select('id')
    .eq('category', toCategory)
    .eq('label', tag.label)
    .maybeSingle() as { data: { id: string } | null }
  if (collision) {
    return NextResponse.json(
      { error: `A tag "${tag.label}" already exists in ${toCategory}. Use the Merge action to combine them instead.` },
      { status: 409 },
    )
  }

  let tradesUpdated = 0
  let historicalUpdated = 0
  try {
    tradesUpdated = await rewriteTable(supabase, 'trades', fromCategory, toCategory, tag.label)
    historicalUpdated = await rewriteTable(supabase, 'historical_trades', fromCategory, toCategory, tag.label)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Rewrite failed' },
      { status: 500 },
    )
  }

  // Phase 2 — flip the tag's category column. If this fails after the data
  // is rewritten, the trade rows have the label in BOTH categories until
  // someone re-runs; the dashboard / analytics handle that gracefully.
  const { error: updErr } = await supabase
    .from('trade_tags')
    .update({ category: toCategory })
    .eq('id', tagId)
  if (updErr) {
    return NextResponse.json(
      { error: `Trade rows rewritten but tag category update failed: ${updErr.message}` },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    from_category: fromCategory,
    to_category: toCategory,
    label: tag.label,
    trades_updated: tradesUpdated,
    historical_updated: historicalUpdated,
  })
}
