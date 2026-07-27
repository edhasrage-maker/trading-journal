/**
 * Tag categories — the taxonomy axes a trade can be tagged along.
 *
 * Seven (eight with entry_model) categories used to be hardcoded as a string
 * union in ~10 places. Pt 16 makes the list OPEN: a trader can add their own
 * axis ("4h Candle Shape", "News Regime") and hide the built-ins they don't
 * use. This module is the single source of truth every one of those call sites
 * now reads.
 *
 * WHERE IT LIVES
 * - The tag rows themselves stay in `trade_tags` (category is a plain text
 *   column; migration 20260727 swapped the value enum for a slug-SHAPE check).
 * - A trade's tags stay in `trades.tags_json`, which is JSONB — a custom
 *   category is just another key, so no schema change per category.
 * - Which categories a trader SEES lives per-user in
 *   `trader_profile.onboarding_json.tag_categories` ({ custom, hidden }). No new
 *   table means no new RLS policy and no public-overlay work on a multi-tenant
 *   prod DB.
 *
 * The category KEY is a lowercase snake_case slug because it doubles as a JSONB
 * object key and as half of the (category, label) uniqueness key. The LABEL is
 * what the trader reads and can be renamed freely without touching any data.
 */

/** One resolved category, ready to render. */
export interface TagCategoryDef {
  /** Stable slug — the value stored in `trade_tags.category` / `tags_json`. */
  key: string
  /** Display name. Renamable for custom categories; fixed for built-ins. */
  label: string
  /** True for the shipped taxonomy. Built-ins can be hidden but never deleted
   *  outright, so an accidental hide is always reversible. */
  builtin: boolean
}

/** A trader's stored category preferences (on onboarding_json.tag_categories). */
export interface TagCategoryPrefs {
  /** Categories the trader added, in their chosen order. */
  custom?: Array<{ key: string; label: string }>
  /** Built-in keys the trader has hidden. Non-destructive — the tags survive. */
  hidden?: string[]
}

/**
 * The shipped taxonomy, in canonical display order.
 *
 * `entry_model` is included deliberately: it was already in the TS union and in
 * the trade picker's order, but was missing from Tag Management and from the
 * old DB check — so tags could be created there and then become uneditable.
 * Listing it here makes the taxonomy consistent across every surface.
 */
export const BUILTIN_TAG_CATEGORIES: readonly TagCategoryDef[] = [
  { key: 'setups', label: 'Setups', builtin: true },
  { key: 'confluences', label: 'Confluences', builtin: true },
  { key: 'order_flow', label: 'Order Flow', builtin: true },
  { key: 'entry_model', label: 'Entry Model', builtin: true },
  { key: 'trade_management', label: 'Trade Management', builtin: true },
  { key: 'day_type', label: 'Day Type', builtin: true },
  { key: 'mistakes', label: 'Mistakes', builtin: true },
  { key: 'emotions', label: 'Emotions', builtin: true },
] as const

export const BUILTIN_CATEGORY_KEYS: readonly string[] = BUILTIN_TAG_CATEGORIES.map(c => c.key)

/** Shape a category key must have — matches the DB's CHECK constraint exactly. */
export const CATEGORY_KEY_RE = /^[a-z][a-z0-9_]{1,30}$/

export function isValidCategoryKey(key: string): boolean {
  return CATEGORY_KEY_RE.test(key)
}

export function isBuiltinCategory(key: string): boolean {
  return BUILTIN_CATEGORY_KEYS.includes(key)
}

/**
 * Turn a human label into a valid key. "4h Candle Shape" → "c_4h_candle_shape"
 * (the leading-letter rule forces the prefix; the key is never shown to the
 * trader, so an ugly slug costs nothing and a collision-free one is worth more).
 * Returns null when nothing usable survives.
 */
export function slugifyCategoryKey(label: string): string | null {
  let s = label
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  if (!s) return null
  if (!/^[a-z]/.test(s)) s = `c_${s}`
  s = s.slice(0, 31)
  // A trailing underscore left by the truncation would still pass the regex,
  // but it reads like a typo in exports — trim it.
  s = s.replace(/_+$/, '')
  return isValidCategoryKey(s) ? s : null
}

/** "four_hour_candle_shape" → "Four Hour Candle Shape". The fallback label for
 *  a key with no definition (a legacy or externally-created category). */
export function humanizeCategoryKey(key: string): string {
  return key
    .split('_')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Resolve the ordered category list for one trader.
 *
 * Order: visible built-ins (canonical order) → the trader's custom categories
 * (their order) → any key that exists in their DATA but in neither list.
 *
 * That last group is the safety net. A category is never lost because prefs got
 * dropped, a tag was created through the API, or a built-in was hidden while it
 * still held tags — the tags stay reachable and editable either way.
 *
 * @param prefs        onboarding_json.tag_categories (any shape; validated here)
 * @param keysInUse    category values actually present in the trader's tag rows
 */
export function resolveTagCategories(
  prefs: unknown,
  keysInUse: readonly string[] = [],
): TagCategoryDef[] {
  const p = (prefs ?? {}) as TagCategoryPrefs
  const hidden = new Set(Array.isArray(p.hidden) ? p.hidden.filter(k => typeof k === 'string') : [])
  const customRaw = Array.isArray(p.custom) ? p.custom : []

  const out: TagCategoryDef[] = []
  const seen = new Set<string>()

  for (const c of BUILTIN_TAG_CATEGORIES) {
    if (hidden.has(c.key)) continue
    out.push({ ...c })
    seen.add(c.key)
  }

  for (const c of customRaw) {
    const key = typeof c?.key === 'string' ? c.key : ''
    if (!isValidCategoryKey(key) || seen.has(key)) continue
    const label = typeof c?.label === 'string' && c.label.trim() ? c.label.trim() : humanizeCategoryKey(key)
    out.push({ key, label, builtin: false })
    seen.add(key)
  }

  for (const key of keysInUse) {
    if (!isValidCategoryKey(key) || seen.has(key)) continue
    out.push({ key, label: humanizeCategoryKey(key), builtin: isBuiltinCategory(key) })
    seen.add(key)
  }

  return out
}

/** Display label for a key against a resolved list, falling back to the
 *  built-in name and then to a humanized slug. Never returns an empty string. */
export function labelForCategory(key: string, defs: readonly TagCategoryDef[] = []): string {
  return defs.find(d => d.key === key)?.label
    ?? BUILTIN_TAG_CATEGORIES.find(d => d.key === key)?.label
    ?? humanizeCategoryKey(key)
}
