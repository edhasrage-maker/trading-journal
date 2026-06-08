import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { TagCategory, TradeTag } from '@/lib/supabase/types'
import { normalizeTagArray } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * Merge one tag into another. Rewrites every trade + historical_trade row
 * whose `tags_json[category]` contains `from.label` to use `to.label` instead
 * (deduped), then deletes the `from` row from `trade_tags`.
 *
 * Both tags must be in the same category. The `from` tag is destructively
 * removed; the change is non-reversible (re-create the tag manually if you
 * change your mind). Mirrors `tagKey()`-aware normalisation by replacing the
 * RAW LABEL, not the key — the caller is expected to have already verified
 * the pair via the merge UI.
 *
 * Returns `{ trades_updated, historical_updated, from_label, to_label }` so
 * the UI can show "Merged X into Y — touched N rows".
 */

const PAGE = 1000

async function rewriteTable(
  supabase: AnyClient,
  table: 'trades' | 'historical_trades',
  category: TagCategory,
  fromLabel: string,
  toLabel: string,
): Promise<number> {
  // Two passes: rows whose tags_json[cat] contains fromLabel as an array
  // element (the normal shape), and rows where tags_json.day_type is the
  // RAW STRING fromLabel (legacy single-value shape — only possible when
  // category === 'day_type'). Dedupe the id set so we don't double-update.
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

  // Pass 2: legacy single-string day_type. Only meaningful when merging day_type tags.
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

  // Rewrite each matching row and update in place. One UPDATE per row keeps
  // it simple; merge volumes are small enough that this is fine.
  let count = 0
  for (const id of ids) {
    const tagsJson = { ...(cache.get(id) ?? {}) }
    const arr = normalizeTagArray(tagsJson[category])
    const rewritten = Array.from(new Set(arr.map(l => (l === fromLabel ? toLabel : l))))
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

export async function POST(req: Request) {
  const supabase: AnyClient = await createClient()
  const body = await req.json().catch(() => ({})) as { from_id?: string; to_id?: string }
  const fromId = (body.from_id ?? '').trim()
  const toId = (body.to_id ?? '').trim()

  if (!fromId || !toId) {
    return NextResponse.json({ error: 'from_id and to_id are both required' }, { status: 400 })
  }
  if (fromId === toId) {
    return NextResponse.json({ error: "Can't merge a tag into itself" }, { status: 400 })
  }

  const { data: rows } = await supabase
    .from('trade_tags')
    .select('id, category, label')
    .in('id', [fromId, toId]) as { data: Pick<TradeTag, 'id' | 'category' | 'label'>[] | null }

  const from = rows?.find(r => r.id === fromId)
  const to = rows?.find(r => r.id === toId)
  if (!from || !to) {
    return NextResponse.json({ error: 'One or both tag ids not found' }, { status: 404 })
  }
  if (from.category !== to.category) {
    return NextResponse.json(
      { error: `Category mismatch: ${from.category} vs ${to.category}` },
      { status: 400 },
    )
  }

  let tradesUpdated = 0
  let historicalUpdated = 0
  try {
    tradesUpdated = await rewriteTable(supabase, 'trades', from.category, from.label, to.label)
    historicalUpdated = await rewriteTable(supabase, 'historical_trades', from.category, from.label, to.label)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Rewrite failed' },
      { status: 500 },
    )
  }

  // Only delete the from-tag once both tables have been rewritten. If a
  // rewrite throws halfway through, the from-tag survives — re-running the
  // merge resumes safely (no-op on already-rewritten rows).
  const { error: delErr } = await supabase
    .from('trade_tags')
    .delete()
    .eq('id', fromId)
  if (delErr) {
    return NextResponse.json(
      { error: `Tag rows rewritten but delete failed: ${delErr.message}` },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    trades_updated: tradesUpdated,
    historical_updated: historicalUpdated,
    from_label: from.label,
    to_label: to.label,
    category: from.category,
  })
}
