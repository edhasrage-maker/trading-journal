import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { TradeTag } from '@/lib/supabase/types'
import { clientError } from '@/lib/api-error'
import { rewriteTagInTable } from '@/lib/tag-rewrite'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * Delete a tag from the library and STRIP it from every trade + historical_trade
 * that uses it (so no orphaned labels linger in tags_json). Destructive and
 * non-reversible — re-create + re-tag manually to undo.
 *
 * POST (not DELETE) so the request body survives the auth proxy uniformly, same
 * shape as /api/trade-tags/merge and /recategorize. RLS scopes every read/write
 * to the caller's own tags + trades.
 *
 * Returns `{ ok, trades_updated, historical_updated, label, category }`.
 */
export async function POST(req: Request) {
  const supabase: AnyClient = await createClient()
  const body = await req.json().catch(() => ({})) as { id?: string }
  const id = (body.id ?? '').trim()
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const { data: tag } = await supabase
    .from('trade_tags')
    .select('id, category, label')
    .eq('id', id)
    .maybeSingle() as { data: Pick<TradeTag, 'id' | 'category' | 'label'> | null }
  if (!tag) return NextResponse.json({ error: 'Tag not found' }, { status: 404 })

  let tradesUpdated = 0
  let historicalUpdated = 0
  try {
    tradesUpdated = await rewriteTagInTable(supabase, 'trades', tag.category, tag.label, null)
    historicalUpdated = await rewriteTagInTable(supabase, 'historical_trades', tag.category, tag.label, null)
  } catch (e) {
    return NextResponse.json({ error: clientError(e, 'Failed to strip the tag from trades') }, { status: 500 })
  }

  // Delete the library row only after the strip succeeds. If the strip throws
  // partway, the tag survives and a retry safely resumes (already-stripped rows
  // are no-ops).
  const { error: delErr } = await supabase.from('trade_tags').delete().eq('id', id)
  if (delErr) {
    return NextResponse.json(
      { error: clientError(`Trades stripped but tag delete failed: ${delErr.message}`, 'Trades were updated but the tag could not be deleted. Please retry.') },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    trades_updated: tradesUpdated,
    historical_updated: historicalUpdated,
    label: tag.label,
    category: tag.category,
  })
}
