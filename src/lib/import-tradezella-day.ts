/**
 * Server-side Tradezella CSV importer. Reads a CSV from disk, normalizes rows
 * via `tradezella-import.ts`, upserts into `historical_trades`, and inserts
 * any newly-discovered tags into `trade_tags`. Idempotent on `dedup_key`.
 *
 * Shared between the CLI script (scripts/import-tradezella.ts) and the
 * Settings → Tradezella web UI (POST /api/historical/import-tradezella).
 */

import { readFileSync } from 'fs'
import Papa from 'papaparse'
import {
  normalizeRow, emptyTagLookup, tagKey, TAG_CATEGORIES,
  type TZRow, type TagCategory, type NormalizedHistoricalTrade,
} from './tradezella-import'
import { autoMergeDuplicateTags, type AutoMergeResult } from './tag-merge'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SbClient = any

export interface TradezellaImportOptions {
  /**
   * Run autoMergeDuplicateTags() BEFORE normalizing rows. Folds any library
   * labels that share a tagKey (e.g. "Break & Retest" → "Break And Retest"),
   * picking the most-used label as canonical. Existing dupes from prior
   * imports get cleaned up so this import doesn't re-surface them.
   */
  autoMerge?: boolean
}

export interface TradezellaImportResult {
  parsedRows: number
  upserted: number
  newTags: number
  tagsByCategory: Record<string, number>
  totalHistorical: number
  errors: string[]
  /** Populated only when options.autoMerge was true. */
  autoMerge: AutoMergeResult | null
}

export async function importTradezellaCsv(
  supabase: SbClient,
  csvPath: string,
  options: TradezellaImportOptions = {},
): Promise<TradezellaImportResult> {
  const text = readFileSync(csvPath, 'utf8')
  const parsed = Papa.parse<TZRow>(text, { header: true, skipEmptyLines: true })
  const rows = parsed.data.filter(r => r['Open Date'])

  // Pre-import pass: fold any same-tagKey clusters in the library (most-used
  // label wins canonical). Runs BEFORE we seed the lookup so the seed picks
  // up the freshly-merged canonicals.
  let autoMerge: AutoMergeResult | null = null
  if (options.autoMerge) {
    autoMerge = await autoMergeDuplicateTags(supabase)
  }

  // Seed the tag lookup with existing trade_tags so labels match the canonical
  // forms already in the library.
  const lookup = emptyTagLookup()
  const { data: existingTags } = await supabase.from('trade_tags').select('category, label')
  for (const t of (existingTags ?? []) as { category: string; label: string }[]) {
    if (TAG_CATEGORIES.includes(t.category as TagCategory)) {
      lookup[t.category as TagCategory].set(tagKey(t.label), t.label)
    }
  }

  const newTags: Array<{ category: TagCategory; label: string }> = []
  const records: NormalizedHistoricalTrade[] = rows.map(r => normalizeRow(r, lookup, newTags))

  // Dedupe new tags and insert. sort_order pushed high so curated tags lead.
  const seen = new Set<string>()
  const uniqueNew = newTags.filter(t => {
    const k = `${t.category}|${tagKey(t.label)}`
    if (seen.has(k)) return false
    seen.add(k); return true
  })
  const errors: string[] = []
  if (uniqueNew.length) {
    const payload = uniqueNew.map((t, i) => ({ category: t.category, label: t.label, sort_order: 1000 + i }))
    const { error } = await supabase
      .from('trade_tags')
      .upsert(payload, { onConflict: 'category,label', ignoreDuplicates: true })
    if (error) errors.push(`tag insert: ${error.message}`)
  }

  // Upsert historical_trades in chunks (Supabase row cap = 1000; 500 is safe).
  const CHUNK = 500
  let upserted = 0
  for (let i = 0; i < records.length; i += CHUNK) {
    const chunk = records.slice(i, i + CHUNK)
    const { error } = await supabase
      .from('historical_trades')
      .upsert(chunk, { onConflict: 'dedup_key' })
    if (error) {
      errors.push(`upsert at row ${i}: ${error.message}`)
      break
    }
    upserted += chunk.length
  }

  const { count } = await supabase.from('historical_trades').select('*', { count: 'exact', head: true })
  const tagsByCategory: Record<string, number> = {}
  for (const r of records) {
    for (const c of TAG_CATEGORIES) {
      const v = r.tags_json[c]
      if (Array.isArray(v) ? v.length : v) tagsByCategory[c] = (tagsByCategory[c] ?? 0) + 1
    }
  }

  return {
    parsedRows: rows.length,
    upserted,
    newTags: uniqueNew.length,
    tagsByCategory,
    totalHistorical: count ?? 0,
    errors,
    autoMerge,
  }
}
