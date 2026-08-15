/**
 * POST /api/trades/[id]/review
 * Body: { verdict: { call: 'good' | 'mistake' | 'unsure', note?: string } | null }
 *
 * Writes the trader's own verdict on a trade into `trades.review_json.verdict`
 * (weekly Game film catalog). READ-MERGE, never a whole-object write: the
 * column will also carry the coach's `tape_read`, and the two must not clobber
 * each other. `verdict: null` clears the trader's call.
 */

import { createClient } from '@/lib/supabase/server'
import { clientError } from '@/lib/api-error'
import { NextResponse } from 'next/server'
import type { TradeReview, TradeVerdict } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const CALLS = new Set<TradeVerdict['call']>(['good', 'mistake', 'unsure'])

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let body: { verdict?: { call?: unknown; note?: unknown } | null }
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }

  const v = body?.verdict
  if (v !== null && v !== undefined) {
    if (!CALLS.has(v.call as TradeVerdict['call'])) {
      return NextResponse.json({ error: 'verdict.call must be good, mistake or unsure' }, { status: 400 })
    }
    if (v.note != null && typeof v.note !== 'string') {
      return NextResponse.json({ error: 'verdict.note must be a string' }, { status: 400 })
    }
  }

  const supabase: AnyClient = await createClient()
  const { data: trade, error: readErr } = await supabase
    .from('trades')
    .select('id, review_json')
    .eq('id', id)
    .maybeSingle() as { data: { id: string; review_json: TradeReview | null } | null; error: { code?: string; message?: string } | null }

  if (readErr) {
    if (readErr.code === '42703') {
      return NextResponse.json({ error: 'review_json column missing — apply migration 20260814_trade_review.sql', migration_pending: true }, { status: 503 })
    }
    return NextResponse.json({ error: clientError(readErr, 'Could not read that trade.') }, { status: 500 })
  }
  if (!trade) return NextResponse.json({ error: 'No such trade' }, { status: 404 })

  const current: TradeReview = trade.review_json ?? {}
  const next: TradeReview = { ...current }
  if (v == null) {
    delete next.verdict
  } else {
    next.verdict = {
      call: v.call as TradeVerdict['call'],
      note: typeof v.note === 'string' ? v.note.trim().slice(0, 500) : '',
      at: new Date().toISOString(),
    }
  }

  const { error: writeErr } = await supabase
    .from('trades')
    .update({ review_json: next })
    .eq('id', id)
  if (writeErr) {
    return NextResponse.json({ error: clientError(writeErr, 'Could not save that. Please try again.') }, { status: 500 })
  }
  return NextResponse.json({ review: next })
}
