import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { TradeTag } from '@/lib/supabase/types'
import { clientError } from '@/lib/api-error'
import { rewriteTagInTable } from '@/lib/tag-rewrite'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * Edit an existing tag in place: `label`, `description` and/or `aliases`.
 * Any subset may be sent; omitted fields are left alone.
 *
 * WHY RENAME LIVES HERE RATHER THAN "DELETE AND RE-ADD". Deleting a tag strips
 * it from every trade and historical row, so re-adding it under a new name
 * loses the history. Worse, if a detector emits that exact label string, the
 * delete silently disables the detector. Renaming rewrites the rows FIRST and
 * only then updates the tag, so nothing is lost and nothing is unhooked.
 *
 * A rename is refused when the target label already exists in the category —
 * `trade_tags` is unique on (category, label), and the operation the user
 * actually wants there is Merge, which folds the usage together instead of
 * colliding.
 *
 * Aliases are alternative phrasings the notes matcher resolves to this tag; an
 * alias beginning with `!` is an exclusion that suppresses the tag. They are
 * normalised here (trimmed, blanks dropped, deduped case-insensitively) so the
 * matcher never has to defend against junk.
 *
 * Uses the request-scoped client, NOT the service role, so RLS confines every
 * read and write to the signed-in user's own tags.
 */

/** Trim, drop blanks, dedupe case-insensitively, preserve author order. */
function normalizeAliases(input: unknown): string[] | null {
  if (input == null) return null
  if (!Array.isArray(input)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const a = raw.trim()
    if (!a) continue
    // An exclusion that is just "!" would suppress the tag unconditionally.
    if (a === '!') continue
    const key = a.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(a)
  }
  return out
}

export async function POST(req: Request) {
  const supabase: AnyClient = await createClient()
  const body = await req.json().catch(() => ({})) as {
    id?: string
    label?: string
    description?: string | null
    aliases?: unknown
  }

  const id = (body.id ?? '').trim()
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const wantsLabel = typeof body.label === 'string'
  const wantsDescription = 'description' in body
  const wantsAliases = 'aliases' in body
  if (!wantsLabel && !wantsDescription && !wantsAliases) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { data: rows } = await supabase
    .from('trade_tags')
    .select('id, category, label')
    .eq('id', id) as { data: Pick<TradeTag, 'id' | 'category' | 'label'>[] | null }
  const tag = rows?.[0]
  if (!tag) return NextResponse.json({ error: 'Tag not found' }, { status: 404 })

  const patch: Record<string, unknown> = {}

  if (wantsDescription) {
    const d = typeof body.description === 'string' ? body.description.trim() : ''
    patch.description = d || null
  }

  if (wantsAliases) {
    patch.aliases = normalizeAliases(body.aliases) ?? null
  }

  // ---- Rename: rewrite usage BEFORE touching the tag row. -------------------
  let tradesUpdated = 0
  let historicalUpdated = 0
  const newLabel = wantsLabel ? (body.label as string).trim() : ''

  if (wantsLabel && newLabel !== tag.label) {
    if (!newLabel) {
      return NextResponse.json({ error: 'Label cannot be empty' }, { status: 400 })
    }

    // Same category + same label is the unique key. Colliding here means the
    // user wants Merge, which combines usage rather than failing on the index.
    const { data: clash } = await supabase
      .from('trade_tags')
      .select('id')
      .eq('category', tag.category)
      .eq('label', newLabel)
      .neq('id', id) as { data: { id: string }[] | null }
    if (clash && clash.length > 0) {
      return NextResponse.json(
        { error: `"${newLabel}" already exists in this category. Use Merge to combine them.` },
        { status: 409 },
      )
    }

    try {
      tradesUpdated = await rewriteTagInTable(supabase, 'trades', tag.category, tag.label, newLabel)
      historicalUpdated = await rewriteTagInTable(supabase, 'historical_trades', tag.category, tag.label, newLabel)
    } catch (e) {
      // Nothing has been written to trade_tags yet, so the tag still matches
      // whatever rows were rewritten — re-running resumes safely.
      return NextResponse.json({ error: clientError(e, 'Rename failed while rewriting trades') }, { status: 500 })
    }
    patch.label = newLabel
  }

  const { data: updated, error } = await supabase
    .from('trade_tags')
    .update(patch)
    .eq('id', id)
    .select()
    .single() as { data: TradeTag | null; error: { message: string } | null }

  if (error) {
    return NextResponse.json(
      { error: clientError(error.message, 'Could not save the tag') },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    tag: updated,
    renamed: wantsLabel && newLabel !== tag.label,
    from_label: tag.label,
    trades_updated: tradesUpdated,
    historical_updated: historicalUpdated,
  })
}
