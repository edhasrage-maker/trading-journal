import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { resilientUpsert } from '@/lib/resilient-upsert'
import { userConflict } from '@/lib/tenant-conflict'
import { clientError } from '@/lib/api-error'
import type { TradingDay } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * Manually end the trading session — "I'm done" (Session-merge Pt 13 step 3).
 * Stamps trading_days.session_ended_at = now() for the date and returns it. The
 * value is never cleared afterward — re-opening is derived from trades entered
 * after it — so the EOD recap can show "ended by choice at HH:MM" and the
 * re-open tilt flag at the same time.
 *
 * resilientUpsert degrades gracefully if the session_ended_at column doesn't
 * exist yet (migration not run on this DB): the write succeeds with the column
 * dropped and `droppedColumns` reports it, rather than 500ing.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ date: string }> }) {
  const { date } = await params
  const supabase: AnyClient = await createClient()
  const endedAt = new Date().toISOString()

  const { data: day, error, droppedColumns } = await resilientUpsert<TradingDay>(
    supabase,
    'trading_days',
    { date, session_ended_at: endedAt, updated_at: endedAt },
    { onConflict: userConflict('date') },
  )

  if (error) {
    return NextResponse.json({ error: clientError(error.message, 'Could not end the session.') }, { status: 500 })
  }
  return NextResponse.json({
    day: day ?? null,
    endedAt,
    droppedColumns: droppedColumns.length > 0 ? droppedColumns : undefined,
  })
}
