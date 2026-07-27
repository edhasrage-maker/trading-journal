/**
 * Tag categories API (Pt 16) — the trader's own taxonomy axes.
 *
 * GET    → { categories, hidden } — the ordered list every tag surface renders,
 *          plus the built-ins they've hidden (so the UI can offer a restore).
 * POST   { label } → create a custom category. Typing the name of a HIDDEN
 *          built-in restores it instead of creating a near-duplicate.
 *          { key }  → restore a hidden built-in explicitly.
 * PATCH  { key, label } → rename a custom category (label only — the key is
 *          load-bearing: it's the JSONB key on every tagged trade).
 *
 * Deleting a category is destructive (it takes its tags with it), so it lives
 * at POST /api/tag-categories/delete, matching the tag merge/delete routes.
 *
 * RLS scopes every read and write to the caller.
 */

import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { clientError } from '@/lib/api-error'
import {
  BUILTIN_TAG_CATEGORIES,
  isBuiltinCategory,
  isValidCategoryKey,
  resolveTagCategories,
  slugifyCategoryKey,
  type TagCategoryPrefs,
} from '@/lib/tag-categories'
import { categoryKeysInUse, readCategoryPrefs, writeCategoryPrefs } from '@/lib/tag-categories-server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const MAX_LABEL = 40
const MAX_CUSTOM = 12

/** Hidden built-ins, as defs, for the "restore" row in Tag Management. */
function hiddenDefs(prefs: TagCategoryPrefs) {
  const hidden = new Set(prefs.hidden ?? [])
  return BUILTIN_TAG_CATEGORIES.filter(c => hidden.has(c.key)).map(c => ({ ...c }))
}

export async function GET() {
  const supabase: AnyClient = await createClient()
  const prefs = await readCategoryPrefs(supabase)
  const inUse = await categoryKeysInUse(supabase)
  return NextResponse.json({
    categories: resolveTagCategories(prefs, inUse),
    hidden: hiddenDefs(prefs),
  })
}

export async function POST(req: Request) {
  const supabase: AnyClient = await createClient()
  const body = await req.json().catch(() => ({})) as { label?: string; key?: string }
  const prefs = await readCategoryPrefs(supabase)
  const hidden = new Set(prefs.hidden ?? [])
  const custom = [...(prefs.custom ?? [])]

  // --- Explicit restore of a hidden built-in ---
  const restoreKey = (body.key ?? '').trim()
  if (restoreKey) {
    if (!hidden.has(restoreKey)) {
      return NextResponse.json({ error: `"${restoreKey}" isn't a hidden category.` }, { status: 400 })
    }
    hidden.delete(restoreKey)
    const err = await writeCategoryPrefs(supabase, { ...prefs, hidden: [...hidden] })
    if (err) return NextResponse.json({ error: clientError(err) }, { status: 500 })
    const inUse = await categoryKeysInUse(supabase)
    return NextResponse.json({
      ok: true,
      restored: true,
      key: restoreKey,
      categories: resolveTagCategories({ ...prefs, hidden: [...hidden] }, inUse),
    })
  }

  // --- Create a custom category ---
  const label = (body.label ?? '').trim()
  if (!label) return NextResponse.json({ error: 'Name cannot be empty.' }, { status: 400 })
  if (label.length > MAX_LABEL) {
    return NextResponse.json({ error: `Name too long (max ${MAX_LABEL} characters).` }, { status: 400 })
  }

  const key = slugifyCategoryKey(label)
  if (!key) {
    return NextResponse.json({ error: 'Use at least one letter or number in the name.' }, { status: 400 })
  }

  // Naming a hidden built-in brings it back rather than creating a shadow copy.
  if (hidden.has(key)) {
    hidden.delete(key)
    const err = await writeCategoryPrefs(supabase, { ...prefs, hidden: [...hidden] })
    if (err) return NextResponse.json({ error: clientError(err) }, { status: 500 })
    const inUse = await categoryKeysInUse(supabase)
    return NextResponse.json({
      ok: true,
      restored: true,
      key,
      categories: resolveTagCategories({ ...prefs, hidden: [...hidden] }, inUse),
    })
  }

  if (isBuiltinCategory(key) || custom.some(c => c.key === key)) {
    return NextResponse.json({ error: `You already have a "${label}" category.` }, { status: 409 })
  }
  if (custom.length >= MAX_CUSTOM) {
    return NextResponse.json(
      { error: `That's ${MAX_CUSTOM} custom categories — remove one before adding another.` },
      { status: 409 },
    )
  }

  custom.push({ key, label })
  const err = await writeCategoryPrefs(supabase, { ...prefs, custom, hidden: [...hidden] })
  if (err) return NextResponse.json({ error: clientError(err) }, { status: 500 })

  const inUse = await categoryKeysInUse(supabase)
  return NextResponse.json({
    ok: true,
    created: true,
    category: { key, label, builtin: false },
    categories: resolveTagCategories({ ...prefs, custom, hidden: [...hidden] }, inUse),
  })
}

/** Rename a custom category. The KEY never changes — it's the JSONB key on
 *  every trade already tagged, so renaming is display-only by design. */
export async function PATCH(req: Request) {
  const supabase: AnyClient = await createClient()
  const body = await req.json().catch(() => ({})) as { key?: string; label?: string }
  const key = (body.key ?? '').trim()
  const label = (body.label ?? '').trim()

  if (!isValidCategoryKey(key)) return NextResponse.json({ error: 'Unknown category.' }, { status: 400 })
  if (!label) return NextResponse.json({ error: 'Name cannot be empty.' }, { status: 400 })
  if (label.length > MAX_LABEL) {
    return NextResponse.json({ error: `Name too long (max ${MAX_LABEL} characters).` }, { status: 400 })
  }
  if (isBuiltinCategory(key)) {
    return NextResponse.json({ error: 'Built-in categories can’t be renamed.' }, { status: 400 })
  }

  const prefs = await readCategoryPrefs(supabase)
  const custom = [...(prefs.custom ?? [])]
  const idx = custom.findIndex(c => c.key === key)
  if (idx < 0) return NextResponse.json({ error: 'Unknown category.' }, { status: 404 })

  custom[idx] = { ...custom[idx], label }
  const err = await writeCategoryPrefs(supabase, { ...prefs, custom })
  if (err) return NextResponse.json({ error: clientError(err) }, { status: 500 })

  const inUse = await categoryKeysInUse(supabase)
  return NextResponse.json({
    ok: true,
    category: { key, label, builtin: false },
    categories: resolveTagCategories({ ...prefs, custom }, inUse),
  })
}
