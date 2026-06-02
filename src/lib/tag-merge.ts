/**
 * Tag-library merge: fold a set of "victim" labels into a single canonical
 * label across `trades.tags_json`, `historical_trades.tags_json`, and the
 * `trade_tags` library. Idempotent — re-running with the same args is a no-op.
 *
 * Used by the Settings → Tags page to clean up Tradezella-import dupes like
 * "Break And Retest" vs "Break & Retest", or "IB Fade" vs "Initial Balance
 * Fade Back Into Balance".
 *
 * `category` is one of the 7 canonical tag categories. For `day_type` (which
 * stores a single string, not an array), the rewrite swaps the string itself
 * when it matches a victim. For all other categories the array is rewritten
 * (victims replaced with canonical, duplicates collapsed).
 */

import { TAG_CATEGORIES, tagKey, type TagCategory } from './tradezella-import'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SbClient = any

const PAGE = 1000

type TagsJson = Record<string, unknown>

function rewriteArray(arr: unknown, victims: Set<string>, canonical: string): { changed: boolean; next: string[] } {
  if (!Array.isArray(arr)) return { changed: false, next: [] }
  let changed = false
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of arr) {
    if (typeof item !== 'string') continue
    const replaced = victims.has(item) ? canonical : item
    if (replaced !== item) changed = true
    if (!seen.has(replaced)) {
      seen.add(replaced)
      out.push(replaced)
    } else {
      changed = true // duplicate collapsed
    }
  }
  return { changed, next: out }
}

function rewriteTagsJson(
  tags: TagsJson | null,
  category: TagCategory,
  victims: Set<string>,
  canonical: string,
): { changed: boolean; next: TagsJson } {
  const next: TagsJson = { ...(tags ?? {}) }
  if (category === 'day_type') {
    const cur = next.day_type
    if (typeof cur === 'string' && victims.has(cur)) {
      next.day_type = canonical
      return { changed: true, next }
    }
    return { changed: false, next }
  }
  const cur = next[category]
  const { changed, next: nextArr } = rewriteArray(cur, victims, canonical)
  if (changed) next[category] = nextArr
  return { changed, next }
}

export interface TagMergeResult {
  category: TagCategory
  canonical: string
  victims: string[]
  tradesUpdated: number
  historicalUpdated: number
  trade_tagsDeleted: number
  errors: string[]
}

export async function mergeTags(
  supabase: SbClient,
  args: { category: TagCategory; canonical: string; victims: string[] },
): Promise<TagMergeResult> {
  const { category, canonical } = args
  // Defensive: strip canonical out of victims and dedupe.
  const victimSet = new Set(args.victims.filter(v => v && v !== canonical))
  const errors: string[] = []
  let tradesUpdated = 0
  let historicalUpdated = 0

  if (victimSet.size === 0) {
    return { category, canonical, victims: [], tradesUpdated: 0, historicalUpdated: 0, trade_tagsDeleted: 0, errors: [] }
  }

  const rewriteTable = async (
    table: 'trades' | 'historical_trades',
  ): Promise<number> => {
    let updated = 0
    for (let p = 0; p < 100; p++) {
      const { data, error } = await supabase
        .from(table)
        .select('id, tags_json')
        .order('id', { ascending: true })
        .range(p * PAGE, p * PAGE + PAGE - 1)
      if (error) { errors.push(`${table} page ${p}: ${error.message}`); break }
      const rows = (data ?? []) as Array<{ id: string; tags_json: TagsJson | null }>
      for (const row of rows) {
        const { changed, next } = rewriteTagsJson(row.tags_json, category, victimSet, canonical)
        if (!changed) continue
        const { error: upErr } = await supabase
          .from(table)
          .update({ tags_json: next })
          .eq('id', row.id)
        if (upErr) { errors.push(`${table} id=${row.id}: ${upErr.message}`); continue }
        updated++
      }
      if (rows.length < PAGE) break
    }
    return updated
  }

  tradesUpdated = await rewriteTable('trades')
  historicalUpdated = await rewriteTable('historical_trades')

  // Drop the victim rows from the tag library.
  let trade_tagsDeleted = 0
  const { data: del, error: delErr } = await supabase
    .from('trade_tags')
    .delete()
    .eq('category', category)
    .in('label', Array.from(victimSet))
    .select('id')
  if (delErr) errors.push(`trade_tags delete: ${delErr.message}`)
  else trade_tagsDeleted = (del ?? []).length

  return {
    category,
    canonical,
    victims: Array.from(victimSet),
    tradesUpdated,
    historicalUpdated,
    trade_tagsDeleted,
    errors,
  }
}

/**
 * Loose key for cluster suggestions: drops spaces, punctuation, and folds
 * `&` ↔ `and` to catch the Tradezella dual-form dupes. Stricter than
 * `tagKey()` already covers — but exposed separately so callers can group
 * with broader equivalences (e.g. ignoring trailing pluralization).
 */
export function looseKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '')
}

export interface AutoMergeResult {
  clustersMerged: number
  totalVictimsFolded: number
  mergeResults: TagMergeResult[]
}

/**
 * Find every cluster of tag library entries (within a category) that share the
 * same `tagKey` — the importer's canonical match key, which already folds
 * `&` ↔ `and` — and fold them into a single canonical label per cluster. The
 * canonical is the most-used label across both `trades` and `historical_trades`,
 * with the alphabetically-first label as a stable tiebreaker.
 *
 * Idempotent and conservative: only same-`tagKey` collisions are merged here
 * (e.g. "Break & Retest" ↔ "Break And Retest"). Semantic dupes that share no
 * letters (e.g. "IB Fade" vs "Initial Balance Fade Back Into Balance") still
 * need the manual /settings/tags UI.
 *
 * Intended to run pre-import in the Tradezella flow so each re-import leaves
 * the library clean rather than re-surfacing the same dupes.
 */
export async function autoMergeDuplicateTags(supabase: SbClient): Promise<AutoMergeResult> {
  const { data: tagRows } = await supabase.from('trade_tags').select('category, label')
  const tags = (tagRows ?? []) as Array<{ category: string; label: string }>
  if (tags.length === 0) return { clustersMerged: 0, totalVictimsFolded: 0, mergeResults: [] }

  // Tally usage across both tables so we can pick canonical = most-used.
  const counts = new Map<string, number>()
  const bump = (cat: string, label: string) => {
    const k = `${cat}|${label}`
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  for (const table of ['trades', 'historical_trades'] as const) {
    for (let p = 0; p < 50; p++) {
      const { data, error } = await supabase
        .from(table)
        .select('id, tags_json')
        .order('id', { ascending: true })
        .range(p * PAGE, p * PAGE + PAGE - 1)
      if (error) break
      const rows = (data ?? []) as Array<{ tags_json: unknown }>
      for (const r of rows) {
        if (!r.tags_json || typeof r.tags_json !== 'object') continue
        const j = r.tags_json as Record<string, unknown>
        for (const cat of TAG_CATEGORIES) {
          const v = j[cat]
          if (cat === 'day_type') {
            if (typeof v === 'string' && v) bump(cat, v)
          } else if (Array.isArray(v)) {
            for (const item of v) {
              if (typeof item === 'string' && item) bump(cat, item)
            }
          }
        }
      }
      if (rows.length < PAGE) break
    }
  }

  // Cluster library labels by tagKey within each category.
  const clusters = new Map<string, string[]>()
  for (const t of tags) {
    if (!TAG_CATEGORIES.includes(t.category as TagCategory)) continue
    const k = `${t.category}|${tagKey(t.label)}`
    const arr = clusters.get(k) ?? []
    arr.push(t.label)
    clusters.set(k, arr)
  }

  const mergeResults: TagMergeResult[] = []
  let totalVictimsFolded = 0
  for (const [key, labels] of clusters.entries()) {
    if (labels.length < 2) continue
    const cat = key.split('|')[0] as TagCategory
    // Sort by usage desc, then alpha asc — alpha tiebreaker keeps the choice
    // deterministic across re-runs even if usage counts tie at zero.
    const ranked = [...labels].sort((a, b) => {
      const ua = counts.get(`${cat}|${a}`) ?? 0
      const ub = counts.get(`${cat}|${b}`) ?? 0
      if (ub !== ua) return ub - ua
      return a.localeCompare(b)
    })
    const canonical = ranked[0]
    const victims = ranked.slice(1)
    const r = await mergeTags(supabase, { category: cat, canonical, victims })
    mergeResults.push(r)
    totalVictimsFolded += r.victims.length
  }

  return { clustersMerged: mergeResults.length, totalVictimsFolded, mergeResults }
}
