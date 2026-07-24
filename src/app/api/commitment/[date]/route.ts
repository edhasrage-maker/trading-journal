import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { clientError } from '@/lib/api-error'
import type { PrepNotes } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * Resolve the day's Prep commitment — the closing half of the Review → Prep
 * loop.
 *
 * The commitment is written at Prep ("Track this today") and lives inside
 * prep_notes_json. This route only ever touches `commitment.resolved` /
 * `resolved_at`: it re-reads the row and merges, rather than accepting a whole
 * prepNotes payload from the client. That matters because Prep may be open in
 * another tab with unsaved edits — a blind overwrite from Review would silently
 * discard them.
 */
export async function POST(req: Request, { params }: { params: Promise<{ date: string }> }) {
  const { date } = await params
  const supabase: AnyClient = await createClient()

  const body = await req.json().catch(() => null) as { resolved?: unknown } | null
  const resolved = body?.resolved
  if (resolved !== 'followed' && resolved !== 'not_followed' && resolved !== null) {
    return NextResponse.json(
      { error: 'resolved must be "followed", "not_followed", or null' },
      { status: 400 },
    )
  }

  const { data: day, error: readErr } = await supabase
    .from('trading_days')
    .select('id, prep_notes_json')
    .eq('date', date)
    .maybeSingle() as { data: { id: string; prep_notes_json: PrepNotes | null } | null; error: unknown }

  if (readErr) {
    return NextResponse.json(
      { error: clientError(readErr, 'Could not read that session.') },
      { status: 500 },
    )
  }
  if (!day) return NextResponse.json({ error: 'No session for that date' }, { status: 404 })

  const prepNotes: PrepNotes = day.prep_notes_json ?? {}
  if (!prepNotes.commitment) {
    return NextResponse.json({ error: 'No commitment was tracked for that date' }, { status: 409 })
  }

  const next: PrepNotes = {
    ...prepNotes,
    commitment: {
      ...prepNotes.commitment,
      // null clears a resolution — the trader can change their mind before the
      // day is closed out.
      ...(resolved === null
        ? { resolved: undefined, resolved_at: undefined }
        : { resolved, resolved_at: new Date().toISOString() }),
    },
  }

  const { error: writeErr } = await supabase
    .from('trading_days')
    .update({ prep_notes_json: next })
    .eq('id', day.id)

  if (writeErr) {
    return NextResponse.json(
      { error: clientError(writeErr, 'Could not save that. Please try again.') },
      { status: 500 },
    )
  }

  return NextResponse.json({ commitment: next.commitment })
}
