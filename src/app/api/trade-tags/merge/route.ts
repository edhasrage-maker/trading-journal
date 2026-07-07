import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { TradeTag } from '@/lib/supabase/types'
import { clientError } from '@/lib/api-error'
import { rewriteTagInTable } from '@/lib/tag-rewrite'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * Merge one tag into another. Rewrites every trade + historical_trade row
 * whose `tags_json[category]` contains `from.label` to use `to.label` instead
 * (deduped, via the shared rewriteTagInTable), then deletes the `from` row
 * from `trade_tags`.
 *
 * Both tags must be in the same category. The `from` tag is destructively
 * removed; the change is non-reversible (re-create the tag manually if you
 * change your mind). Mirrors `tagKey()`-aware normalisation by replacing the
 * RAW LABEL, not the key — the caller is expected to have already verified
 * the pair via the merge UI.
 *
 * Returns `{ trades_updated, historical_updated, from_label, to_label }` so
 * the UI can show "Merged X into Y — touched N rows".
 */

export async function POST(req: Request) {
  const supabase: AnyClient = await createClient()
  const body = await req.json().catch(() => ({})) as { from_id?: string; to_id?: string }
  const fromId = (body.from_id ?? '').trim()
  const toId = (body.to_id ?? '').trim()

  if (!fromId || !toId) {
    return NextResponse.json({ error: 'from_id and to_id are both required' }, { status: 400 })
  }
  if (fromId === toId) {
    return NextResponse.json({ error: "Can't merge a tag into itself" }, { status: 400 })
  }

  const { data: rows } = await supabase
    .from('trade_tags')
    .select('id, category, label')
    .in('id', [fromId, toId]) as { data: Pick<TradeTag, 'id' | 'category' | 'label'>[] | null }

  const from = rows?.find(r => r.id === fromId)
  const to = rows?.find(r => r.id === toId)
  if (!from || !to) {
    return NextResponse.json({ error: 'One or both tag ids not found' }, { status: 404 })
  }
  if (from.category !== to.category) {
    return NextResponse.json(
      { error: `Category mismatch: ${from.category} vs ${to.category}` },
      { status: 400 },
    )
  }

  let tradesUpdated = 0
  let historicalUpdated = 0
  try {
    tradesUpdated = await rewriteTagInTable(supabase, 'trades', from.category, from.label, to.label)
    historicalUpdated = await rewriteTagInTable(supabase, 'historical_trades', from.category, from.label, to.label)
  } catch (e) {
    return NextResponse.json(
      { error: clientError(e, 'Rewrite failed') },
      { status: 500 },
    )
  }

  // Only delete the from-tag once both tables have been rewritten. If a
  // rewrite throws halfway through, the from-tag survives — re-running the
  // merge resumes safely (no-op on already-rewritten rows).
  const { error: delErr } = await supabase
    .from('trade_tags')
    .delete()
    .eq('id', fromId)
  if (delErr) {
    return NextResponse.json(
      { error: clientError(`Tag rows rewritten but delete failed: ${delErr.message}`, 'Tag rows were rewritten but the old tag could not be deleted. Please retry.') },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    trades_updated: tradesUpdated,
    historical_updated: historicalUpdated,
    from_label: from.label,
    to_label: to.label,
    category: from.category,
  })
}
