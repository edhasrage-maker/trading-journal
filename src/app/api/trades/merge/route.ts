import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { Trade } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * Merge two trade rows into one. Use case: a "manual" trade entered via the
 * intraday tagging flow (with screenshot, setup tags, mistakes) and an
 * "imported" trade from a Sierra Chart log overlap in time and represent the
 * same physical trade. The journal naturally produces these pairs — manual
 * tagging captures qualitative context at the moment of entry; SC import
 * provides authoritative fill data afterward.
 *
 * Merge semantics:
 *   - The SC-imported trade (one with sierra_trade_id) survives, preserving
 *     the de-dup key against future re-imports.
 *   - The manual trade contributes qualitative fields (tags, notes, screenshot,
 *     pin positions, stop/TP plan levels) onto the SC trade.
 *   - The manual trade row is deleted.
 *
 * If neither trade has sierra_trade_id (two manual trades), the first ID in
 * the request is treated as the keeper. If both have sierra_trade_id, the
 * request is rejected — merging two authoritative SC trades would lose data.
 */
export async function POST(req: Request) {
  const supabase: AnyClient = await createClient()
  const body = await req.json() as { tradeIds?: string[] }
  const tradeIds = body.tradeIds

  if (!Array.isArray(tradeIds) || tradeIds.length !== 2 || tradeIds[0] === tradeIds[1]) {
    return NextResponse.json({ error: 'Must provide exactly 2 distinct trade IDs' }, { status: 400 })
  }

  const { data: trades, error: fetchError } = await supabase
    .from('trades')
    .select('*')
    .in('id', tradeIds) as { data: Trade[] | null; error: { message: string } | null }

  if (fetchError) {
    console.error('[trades/merge] fetch failed:', fetchError)
    return NextResponse.json({ error: `Fetch failed: ${fetchError.message}` }, { status: 500 })
  }
  if (!trades || trades.length !== 2) {
    return NextResponse.json({ error: 'One or both trades not found' }, { status: 404 })
  }

  const [a, b] = trades

  if (a.sierra_trade_id && b.sierra_trade_id) {
    return NextResponse.json(
      { error: 'Cannot merge two SC-imported trades; both have authoritative fill data.' },
      { status: 400 },
    )
  }

  // Determine keeper (survives) vs loser (deleted). SC-imported wins ties.
  const keeper = a.sierra_trade_id ? a : b.sierra_trade_id ? b : a
  const loser = keeper.id === a.id ? b : a

  // Qualitative fields: prefer loser's non-null values (loser is the manual
  // trade with the tagging context). Quantitative fields stay on the keeper.
  const tagsHasContent = (t: Trade['tags_json']) =>
    !!t && typeof t === 'object' && Object.keys(t).length > 0

  const merged = {
    stop_price: loser.stop_price ?? keeper.stop_price,
    tp1_price: loser.tp1_price ?? keeper.tp1_price,
    notes: loser.notes ?? keeper.notes,
    screenshot_url: loser.screenshot_url ?? keeper.screenshot_url,
    entry_pin_x: loser.entry_pin_x ?? keeper.entry_pin_x,
    entry_pin_y: loser.entry_pin_y ?? keeper.entry_pin_y,
    stop_pin_x: loser.stop_pin_x ?? keeper.stop_pin_x,
    stop_pin_y: loser.stop_pin_y ?? keeper.stop_pin_y,
    tp1_pin_x: loser.tp1_pin_x ?? keeper.tp1_pin_x,
    tp1_pin_y: loser.tp1_pin_y ?? keeper.tp1_pin_y,
    tags_json: tagsHasContent(loser.tags_json) ? loser.tags_json : keeper.tags_json,
    updated_at: new Date().toISOString(),
  }

  const { error: updateError } = await supabase
    .from('trades')
    .update(merged)
    .eq('id', keeper.id)

  if (updateError) {
    console.error('[trades/merge] update failed:', updateError)
    return NextResponse.json({ error: `Update failed: ${updateError.message}` }, { status: 500 })
  }

  const { error: deleteError } = await supabase
    .from('trades')
    .delete()
    .eq('id', loser.id)

  if (deleteError) {
    console.error('[trades/merge] delete failed:', deleteError)
    return NextResponse.json({ error: `Delete failed: ${deleteError.message}` }, { status: 500 })
  }

  return NextResponse.json({ keeperId: keeper.id, deletedId: loser.id })
}
