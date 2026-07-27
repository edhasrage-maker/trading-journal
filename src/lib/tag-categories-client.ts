'use client'

/**
 * Client-side access to the trader's tag categories (Pt 16).
 *
 * The trade tagger can have several TradeForms mounted at once, so the fetch is
 * memoized at module scope — every TagSelector on the page shares one request.
 * Settings → Tags calls `invalidateTagCategories()` after a change so a
 * client-side navigation back to the journal picks up the new list without a
 * hard reload.
 *
 * Falls back to the built-in taxonomy on any failure: a network blip should
 * cost the trader their CUSTOM axes at worst, never the ability to tag at all.
 */

import { BUILTIN_TAG_CATEGORIES, type TagCategoryDef } from './tag-categories'
import { useEffect, useState } from 'react'

const FALLBACK: TagCategoryDef[] = BUILTIN_TAG_CATEGORIES.map(c => ({ ...c }))

let cache: Promise<TagCategoryDef[]> | null = null

export function fetchTagCategories(): Promise<TagCategoryDef[]> {
  if (!cache) {
    cache = fetch('/api/tag-categories')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { categories?: TagCategoryDef[] } | null) =>
        Array.isArray(d?.categories) && d.categories.length > 0 ? d.categories : FALLBACK)
      .catch(() => FALLBACK)
  }
  return cache
}

/** Drop the memo so the next read re-fetches (call after add/rename/remove). */
export function invalidateTagCategories(): void {
  cache = null
}

/**
 * The resolved category list, starting from the built-ins so the picker paints
 * immediately and reconciles once the trader's real list arrives.
 */
export function useTagCategories(): TagCategoryDef[] {
  const [cats, setCats] = useState<TagCategoryDef[]>(FALLBACK)
  useEffect(() => {
    let cancelled = false
    void fetchTagCategories().then(c => { if (!cancelled) setCats(c) })
    return () => { cancelled = true }
  }, [])
  return cats
}
