import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { deepDiveAllowed } from '@/lib/deep-dive-access'
import { rMultiple, type TradeWithExcursion } from '@/lib/analytics'
import type { TradeVerdict } from '@/lib/supabase/types'

export const dynamic = 'force-dynamic'

export interface ReplayResult {
  pnl: number | null
  r: number | null
  /** Seconds from the fill to the last exit. */
  held_sec: number | null
  call: TradeVerdict['call'] | null
  note: string
}

const UUID = /^[0-9a-f-]{36}$/i

/**
 * GET /api/deep-dive/results?ids=<uuid>,<uuid>,…
 *   → { results: { [tradeId]: ReplayResult } }
 *
 * How each of the week's trades turned out, and the trader's own call on it,
 * for Replay Review's FULL review. The workspace asks for this only after the
 * trader leaves Blind, so a Blind session never has any of it in the browser.
 *
 * R is the same figure the week's Game film shows (rMultiple, off the planned
 * stop). Same private beta as the page; rows come through the caller's own
 * session, so RLS scopes them.
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 })
  if (!deepDiveAllowed(user.email)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const ids = (new URL(req.url).searchParams.get('ids') ?? '').split(',').filter(s => UUID.test(s)).slice(0, 300)
  if (ids.length === 0) return NextResponse.json({ results: {} })

  const BASE = 'id, entry_time, entry_price, exit_time, exit_price, stop_price, tp1_price, quantity, direction, pnl, symbol, entry_atr_1m, exits_json'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- columns newer than the generated types
  const db = supabase as any
  let res = await db.from('trades').select(`${BASE}, stops:review_json->stops, verdict:review_json->verdict`).in('id', ids)
  if (res.error) res = await db.from('trades').select(BASE).in('id', ids)   // review_json not migrated on this database
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 })

  const results: Record<string, ReplayResult> = {}
  for (const row of (res.data ?? []) as Array<Record<string, unknown>>) {
    const entry = typeof row.entry_time === 'string' ? Date.parse(row.entry_time) : NaN
    const legs = Array.isArray(row.exits_json) ? (row.exits_json as { time?: string }[]).map(e => Date.parse(e.time ?? '')) : []
    const exits = legs.length ? legs : typeof row.exit_time === 'string' ? [Date.parse(row.exit_time)] : []
    const last = exits.filter(Number.isFinite).reduce((a, b) => Math.max(a, b), -Infinity)
    const v = row.verdict as TradeVerdict | null | undefined
    results[row.id as string] = {
      pnl: typeof row.pnl === 'number' ? row.pnl : row.pnl != null ? Number(row.pnl) : null,
      r: rMultiple(row as unknown as TradeWithExcursion),
      held_sec: Number.isFinite(entry) && Number.isFinite(last) ? Math.max(0, Math.round((last - entry) / 1000)) : null,
      call: v?.call ?? null,
      note: v?.note ?? '',
    }
  }
  return NextResponse.json({ results }, { headers: { 'Cache-Control': 'no-store' } })
}
