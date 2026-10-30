/**
 * The DB half of bringing tags over on import (src/lib/import-tag-columns.ts is
 * the pure half). Server only, through the CALLER's session client, so RLS
 * confines every read and write to their own library.
 *
 * Given each pending trade's tags (by group) and notes, it:
 *   1. adds any NEW groups to the trader's tag categories (and un-hides a
 *      built-in they chose to fill), so the tags show in every picker;
 *   2. adds the tags the library doesn't have yet, matching existing ones by
 *      tagKey so "break and retest" lands on their "Break & Retest";
 *   3. writes tags_json and notes onto the trade rows about to be inserted,
 *      using the library's spelling.
 */
import type { TagCategory } from '@/lib/supabase/types'
import { alphabetizeTags } from '@/lib/tag-library-server'
import { readCategoryPrefs, writeCategoryPrefs } from '@/lib/tag-categories-server'
import { tagKey } from '@/lib/tradezella-import'
import type { TagMapEntry } from '@/lib/import-tag-columns'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/** The same cap as POST /api/tag-categories (MAX_CUSTOM): a trader's own groups. */
const MAX_CUSTOM_GROUPS = 12

export interface ImportedTagEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  row: Record<string, any>
  tags: Record<string, string[]>
  notes: string | null
}

export interface ImportedTagSummary {
  /** Trades given at least one tag or a note. */
  trades: number
  /** Distinct tags across the upload. */
  tags: number
  /** Of those, how many the library didn't have. */
  newTags: number
  /** New groups added to the trader's categories. */
  groups: number
  /** Columns left out because the trader already has the most groups allowed. */
  overCap: string[]
  /** Trades given a note. */
  notes: number
}

export async function applyImportedTags(
  db: AnyClient,
  entries: ImportedTagEntry[],
  map: TagMapEntry[],
): Promise<ImportedTagSummary> {
  // 1. Groups. Only those that actually receive a tag are added.
  const usedKeys = new Set(entries.flatMap(e => Object.keys(e.tags)))
  const prefs = await readCategoryPrefs(db)
  const custom = Array.isArray(prefs.custom) ? [...prefs.custom] : []
  const hidden = Array.isArray(prefs.hidden) ? [...prefs.hidden] : []
  let groups = 0
  let prefsChanged = false
  const overCap: string[] = []
  const dropKeys = new Set<string>()
  for (const { header, target } of map) {
    if (target.kind !== 'group' || !usedKeys.has(target.key)) continue
    if (target.isNew) {
      if (custom.some(c => c.key === target.key)) continue
      if (custom.length >= MAX_CUSTOM_GROUPS) { overCap.push(header); dropKeys.add(target.key); continue }
      custom.push({ key: target.key, label: target.label }); groups++; prefsChanged = true
    } else if (hidden.includes(target.key)) {
      hidden.splice(hidden.indexOf(target.key), 1)
      prefsChanged = true
    }
  }
  if (dropKeys.size > 0) for (const e of entries) for (const k of dropKeys) delete e.tags[k]
  if (prefsChanged) {
    const err = await writeCategoryPrefs(db, { ...prefs, custom, hidden })
    if (err) throw new Error(`could not add your tag groups: ${err}`)
  }

  // 2. The library: existing spelling wins; add what's missing in one insert.
  const { data: existing, error: readErr } = await db.from('trade_tags').select('category, label')
  if (readErr) throw new Error(`could not read your tags: ${readErr.message}`)
  const canon = new Map<string, Map<string, string>>()
  for (const t of (existing ?? []) as { category: string; label: string }[]) {
    if (!canon.has(t.category)) canon.set(t.category, new Map())
    canon.get(t.category)!.set(tagKey(t.label), t.label)
  }
  const toAdd: { category: string; label: string; sort_order: number }[] = []
  const distinct = new Set<string>()
  for (const e of entries) {
    for (const [category, labels] of Object.entries(e.tags)) {
      if (!canon.has(category)) canon.set(category, new Map())
      const known = canon.get(category)!
      for (const label of labels) {
        const k = tagKey(label)
        distinct.add(`${category}|${k}`)
        if (known.has(k)) continue
        known.set(k, label)
        toAdd.push({ category, label, sort_order: 100000 })
      }
    }
  }
  for (let i = 0; i < toAdd.length; i += 200) {
    const { error } = await db.from('trade_tags').insert(toAdd.slice(i, i + 200))
    if (error) throw new Error(`could not add your tags: ${error.message}`)
  }
  // New chips into their alphabetical slots, once per group touched.
  for (const category of new Set(toAdd.map(t => t.category))) {
    await alphabetizeTags(db, category as TagCategory)
  }

  // 3. The rows, in the library's spelling.
  let trades = 0, notes = 0
  for (const e of entries) {
    const tagsJson: Record<string, string[]> = {}
    for (const [category, labels] of Object.entries(e.tags)) {
      const known = canon.get(category)!
      const out: string[] = []
      for (const l of labels) {
        const label = known.get(tagKey(l)) ?? l
        if (!out.includes(label)) out.push(label)
      }
      if (out.length) tagsJson[category] = out
    }
    const tagged = Object.keys(tagsJson).length > 0
    if (tagged) e.row.tags_json = tagsJson
    if (e.notes) { e.row.notes = e.notes; notes++ }
    if (tagged || e.notes) trades++
  }

  return { trades, tags: distinct.size, newTags: toAdd.length, groups, notes, overCap }
}
