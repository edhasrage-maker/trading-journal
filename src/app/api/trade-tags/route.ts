import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { TagCategory, TradeTag } from '@/lib/supabase/types'
import { tagKey } from '@/lib/tradezella-import'
import { clientError } from '@/lib/api-error'
import { resolveTagCategories } from '@/lib/tag-categories'
import { categoryKeysInUse, readCategoryPrefs } from '@/lib/tag-categories-server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * Renumber one category's tags into alphabetical order, 10 apart.
 *
 * Sorting lives in the DATA, not the queries: every read of `trade_tags` across
 * the app already orders by `sort_order`, so keeping that column alphabetical
 * makes the tag picker, settings page, prompts and pickers all alphabetical
 * without touching a single query.
 *
 * Uses the request-scoped client, so RLS confines the rewrite to the caller's
 * own tags — it can never renumber another trader's library. Case-insensitive
 * and numeric-aware, so "9 EMA Hold" sorts before "20 EMA Hold" rather than
 * after it, which is what a person expects and what a plain string sort gets
 * wrong.
 */
async function alphabetize(supabase: AnyClient, category: TagCategory): Promise<TradeTag[]> {
  const { data: rows } = await supabase
    .from('trade_tags')
    .select('*')
    .eq('category', category) as { data: TradeTag[] | null }
  if (!rows || rows.length === 0) return []

  const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })
  const sorted = [...rows].sort((a, b) => collator.compare(a.label, b.label))

  const updated: TradeTag[] = []
  for (let i = 0; i < sorted.length; i++) {
    const want = (i + 1) * 10
    if (sorted[i].sort_order === want) { updated.push(sorted[i]); continue }
    const { error } = await supabase
      .from('trade_tags').update({ sort_order: want }).eq('id', sorted[i].id)
    if (error) { updated.push(sorted[i]); continue }
    updated.push({ ...sorted[i], sort_order: want })
  }
  return updated
}

export async function GET() {
  const supabase: AnyClient = await createClient()
  const { data } = await supabase.from('trade_tags').select('*').order('sort_order')
  return NextResponse.json(data ?? [])
}

/** Create a custom tag. Idempotent — duplicates (same category+label) return
 *  the existing row instead of erroring, so the client can pre-select it
 *  without caring whether it was just created or already existed. */
export async function POST(req: Request) {
  const supabase: AnyClient = await createClient()
  const body = await req.json().catch(() => ({})) as { category?: string; label?: string }
  const category = (body.category ?? '').trim() as TagCategory
  const label = (body.label ?? '').trim()

  // The category list is per-trader now (built-ins minus hidden, plus their own
  // axes), so validate against what THIS trader actually has rather than a
  // hardcoded union — otherwise a custom category could never hold a tag.
  const categories = resolveTagCategories(
    await readCategoryPrefs(supabase),
    await categoryKeysInUse(supabase),
  )
  if (!category || !categories.some(c => c.key === category)) {
    return NextResponse.json({ error: `Invalid category: ${category}` }, { status: 400 })
  }
  if (!label) {
    return NextResponse.json({ error: 'Label cannot be empty' }, { status: 400 })
  }
  if (label.length > 80) {
    return NextResponse.json({ error: 'Label too long (max 80 chars)' }, { status: 400 })
  }

  // Key-based dedup: match the importer's tagKey() (lowercase, strip non-alnum,
  // & ↔ and) so case-only or punctuation-only variants ("Waited For 2x" vs
  // "Waited for 2x", "Break & Retest" vs "Break And Retest") return the existing
  // row instead of creating a duplicate.
  const incomingKey = tagKey(label)
  const { data: existingRows } = await supabase
    .from('trade_tags')
    .select('*')
    .eq('category', category) as { data: TradeTag[] | null }
  const existing = (existingRows ?? []).find(r => tagKey(r.label) === incomingKey) ?? null
  if (existing) return NextResponse.json({ tag: existing, created: false })

  // Place after the current last chip, then renumber the category below so the
  // new tag lands in its ALPHABETICAL slot rather than at the bottom. Every
  // read of trade_tags orders by sort_order, so keeping that column sorted is
  // what makes the whole app alphabetical — no query needs to change.
  const { data: maxRow } = await supabase
    .from('trade_tags')
    .select('sort_order')
    .eq('category', category)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle() as { data: { sort_order: number | null } | null }
  const nextSort = (maxRow?.sort_order ?? 0) + 10

  const { data: inserted, error } = await supabase
    .from('trade_tags')
    .insert({ category, label, sort_order: nextSort })
    .select('*')
    .single() as { data: TradeTag | null; error: { message: string } | null }
  if (error) return NextResponse.json({ error: clientError(error) }, { status: 500 })

  // Best-effort: a failure here costs alphabetical order for one chip, which is
  // not worth failing a successful tag creation over.
  const reordered = await alphabetize(supabase, category)
  const tag = reordered.find(t => t.id === inserted?.id) ?? inserted

  return NextResponse.json({ tag, created: true })
}
