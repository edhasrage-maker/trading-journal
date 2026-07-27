/**
 * Server-side helpers for custom tag categories — the read/write half of
 * `src/lib/tag-categories.ts`.
 *
 * A trader's category preferences live on `trader_profile.onboarding_json`
 * under the `tag_categories` key, alongside the onboarding/tour/ui_mode state.
 * Reusing that column is deliberate: it's already per-user, already RLS-scoped
 * and already migrated, so adding a whole taxonomy axis needs no new table and
 * no public-overlay change on the multi-tenant prod DB.
 *
 * Both helpers degrade to defaults when the column isn't migrated yet, matching
 * /api/onboarding — a missing column means "no customizations", never an error.
 */

import type { TagCategoryPrefs } from './tag-categories'
import { userConflict } from './tenant-conflict'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/** Read the trader's category prefs. Returns `{}` if unset or unmigrated. */
export async function readCategoryPrefs(supabase: AnyClient): Promise<TagCategoryPrefs> {
  const { data, error } = await supabase
    .from('trader_profile')
    .select('onboarding_json')
    .eq('id', 'default')
    .maybeSingle()
  if (error) return {}
  const prefs = (data?.onboarding_json as Record<string, unknown> | null)?.tag_categories
  return (prefs ?? {}) as TagCategoryPrefs
}

/**
 * Write the trader's category prefs, shallow-merging into onboarding_json so
 * sibling keys (tour_status, ui_mode, first_read …) survive.
 * Returns null on success, or an error message.
 */
export async function writeCategoryPrefs(
  supabase: AnyClient,
  prefs: TagCategoryPrefs,
): Promise<string | null> {
  const { data: existing } = await supabase
    .from('trader_profile')
    .select('onboarding_json')
    .eq('id', 'default')
    .maybeSingle()

  const merged = { ...(existing?.onboarding_json ?? {}), tag_categories: prefs }
  const { error } = await supabase
    .from('trader_profile')
    .upsert(
      { id: 'default', onboarding_json: merged, updated_at: new Date().toISOString() },
      { onConflict: userConflict('id') },
    )
  return error ? (error.message as string) : null
}

/** The distinct `category` values that actually exist in this trader's tag
 *  library — the safety net that keeps a category reachable even if prefs are
 *  missing or a tag was created straight through the API. */
export async function categoryKeysInUse(supabase: AnyClient): Promise<string[]> {
  const { data } = await supabase.from('trade_tags').select('category')
  const rows = (data ?? []) as { category: string }[]
  return [...new Set(rows.map(r => r.category).filter(Boolean))]
}
