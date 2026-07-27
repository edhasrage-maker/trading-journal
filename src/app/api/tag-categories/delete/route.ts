/**
 * Delete a tag category (Pt 16).
 *
 * POST { key, delete_tags? } — POST rather than DELETE so the body survives the
 * auth proxy uniformly, matching /api/trade-tags/delete and /merge.
 *
 * A category can't outlive its tags: leaving them behind would strand labels in
 * `tags_json` under a heading nothing renders. So a category holding tags
 * returns 409 with the count, and the caller re-sends `delete_tags: true` once
 * the trader has confirmed. Then each tag is stripped from every trade +
 * historical row before its library row goes.
 *
 * Built-in vs custom:
 *   built-in → HIDDEN (recorded in onboarding_json.tag_categories.hidden and
 *              restorable from Tag Management — an accidental delete of a
 *              shipped axis should never be a one-way door).
 *   custom   → removed from the list outright.
 * Either way the tags are gone, which is what makes the removal stick: the
 * resolver's "keys still in use" safety net would otherwise resurrect it.
 */

import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { TradeTag } from '@/lib/supabase/types'
import { clientError } from '@/lib/api-error'
import { rewriteTagInTable } from '@/lib/tag-rewrite'
import { isBuiltinCategory, isValidCategoryKey, resolveTagCategories } from '@/lib/tag-categories'
import { categoryKeysInUse, readCategoryPrefs, writeCategoryPrefs } from '@/lib/tag-categories-server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export async function POST(req: Request) {
  const supabase: AnyClient = await createClient()
  const body = await req.json().catch(() => ({})) as { key?: string; delete_tags?: boolean }
  const key = (body.key ?? '').trim()

  if (!isValidCategoryKey(key)) {
    return NextResponse.json({ error: 'Unknown category.' }, { status: 400 })
  }

  const prefs = await readCategoryPrefs(supabase)
  const custom = prefs.custom ?? []
  const hidden = new Set(prefs.hidden ?? [])
  const builtin = isBuiltinCategory(key)
  if (!builtin && !custom.some(c => c.key === key)) {
    // Not in prefs and not built-in — only legitimate if tags exist under it
    // (a legacy or API-created category surfaced by the resolver's safety net).
    const inUse = await categoryKeysInUse(supabase)
    if (!inUse.includes(key)) {
      return NextResponse.json({ error: 'Unknown category.' }, { status: 404 })
    }
  }
  if (builtin && hidden.has(key)) {
    return NextResponse.json({ error: 'That category is already removed.' }, { status: 409 })
  }

  const { data: tagRows, error: readErr } = await supabase
    .from('trade_tags')
    .select('id, category, label')
    .eq('category', key) as { data: Pick<TradeTag, 'id' | 'category' | 'label'>[] | null; error: { message: string } | null }
  if (readErr) return NextResponse.json({ error: clientError(readErr) }, { status: 500 })
  const tags = tagRows ?? []

  if (tags.length > 0 && body.delete_tags !== true) {
    return NextResponse.json(
      {
        error: `That category still has ${tags.length} tag${tags.length === 1 ? '' : 's'}.`,
        tag_count: tags.length,
        needs_confirmation: true,
      },
      { status: 409 },
    )
  }

  // Strip every tag from the data BEFORE dropping the library rows, so a
  // failure part-way leaves a retryable state rather than orphaned labels.
  let tradesUpdated = 0
  let historicalUpdated = 0
  try {
    for (const t of tags) {
      tradesUpdated += await rewriteTagInTable(supabase, 'trades', t.category, t.label, null)
      historicalUpdated += await rewriteTagInTable(supabase, 'historical_trades', t.category, t.label, null)
    }
  } catch (e) {
    return NextResponse.json(
      { error: clientError(e, 'Failed to strip the category’s tags from your trades. Nothing was deleted — please retry.') },
      { status: 500 },
    )
  }

  if (tags.length > 0) {
    const { error: delErr } = await supabase.from('trade_tags').delete().eq('category', key)
    if (delErr) {
      return NextResponse.json(
        { error: clientError(delErr, 'Your trades were updated but the tags could not be deleted. Please retry.') },
        { status: 500 },
      )
    }
  }

  const nextPrefs = builtin
    ? { ...prefs, hidden: [...hidden, key] }
    : { ...prefs, custom: custom.filter(c => c.key !== key) }
  const prefErr = await writeCategoryPrefs(supabase, nextPrefs)
  if (prefErr) return NextResponse.json({ error: clientError(prefErr) }, { status: 500 })

  const inUse = await categoryKeysInUse(supabase)
  return NextResponse.json({
    ok: true,
    key,
    builtin,
    tags_deleted: tags.length,
    trades_updated: tradesUpdated,
    historical_updated: historicalUpdated,
    categories: resolveTagCategories(nextPrefs, inUse),
  })
}
