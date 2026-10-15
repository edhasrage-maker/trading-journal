/**
 * Adding to a trader's tag library — server only, through the CALLER's
 * session client, so RLS confines every read and write to their own tags.
 * Shared by POST /api/trade-tags (a tag typed in the picker) and the rule
 * mistake tags (src/lib/rule-tags-server.ts).
 */
import type { TagCategory, TradeTag } from '@/lib/supabase/types'
import { tagKey } from '@/lib/tradezella-import'

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
 * Case-insensitive and numeric-aware, so "9 EMA Hold" sorts before "20 EMA Hold"
 * rather than after it, which is what a person expects and what a plain string
 * sort gets wrong.
 */
export async function alphabetizeTags(supabase: AnyClient, category: TagCategory): Promise<TradeTag[]> {
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

/**
 * Add a tag to the library, or return the one already there. Key-based dedup
 * (tagKey: lowercase, non-alphanumerics stripped, & ↔ and) so case-only or
 * punctuation-only variants return the existing row instead of a duplicate.
 * Throws on a failed insert; `alphabetize: false` skips the renumbering (the
 * caller adds several and renumbers once).
 */
export async function ensureTag(
  supabase: AnyClient, category: TagCategory, label: string, opts: { alphabetize?: boolean } = {},
): Promise<{ tag: TradeTag; created: boolean }> {
  const incomingKey = tagKey(label)
  const { data: existingRows } = await supabase
    .from('trade_tags')
    .select('*')
    .eq('category', category) as { data: TradeTag[] | null }
  const existing = (existingRows ?? []).find(r => tagKey(r.label) === incomingKey) ?? null
  if (existing) return { tag: existing, created: false }

  // Place after the current last chip, then renumber the category so the new
  // tag lands in its ALPHABETICAL slot rather than at the bottom.
  const nextSort = Math.max(0, ...(existingRows ?? []).map(r => r.sort_order ?? 0)) + 10
  const { data: inserted, error } = await supabase
    .from('trade_tags')
    .insert({ category, label, sort_order: nextSort })
    .select('*')
    .single() as { data: TradeTag | null; error: { message: string } | null }
  if (error || !inserted) throw new Error(error?.message ?? 'could not add the tag')
  if (opts.alphabetize === false) return { tag: inserted, created: true }
  // Best-effort: a failure here costs alphabetical order for one chip.
  const reordered = await alphabetizeTags(supabase, category)
  return { tag: reordered.find(t => t.id === inserted.id) ?? inserted, created: true }
}
