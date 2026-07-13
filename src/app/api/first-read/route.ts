/**
 * First-read retroactive recap (alpha-readiness item 22).
 *
 * GET  /api/first-read → { armed, dismissed, best, worst } — picks the signed-in
 *      user's best and worst *day* (by realized P&L) from their imported history
 *      and returns an EOD-style teaser for each (P&L, win rate, capture / heat,
 *      one behavioral flag). The full read lives at /eod/<date>; this only
 *      selects the days and summarizes them so a brand-new tester gets a payoff
 *      the moment their first import lands.
 * POST /api/first-read { action:'arm' }   → write-once flag on the account so the
 *      dashboard surfaces the card (set only when the first import populates a
 *      previously-empty journal; no-ops if already set).
 * POST /api/first-read { dismiss:true }    → hide the dashboard card for good.
 *
 * The math is centralized here so the dashboard card and the /import success
 * teaser render identical numbers — the same helpers the EOD recap uses.
 */

import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { avgCaptureRatio, avgMfeMaeRatio, type TradeWithExcursion } from '@/lib/analytics'
import { computeBehavioralProxies, type ProxyTrade } from '@/lib/behavioral-proxies'
import { userConflict } from '@/lib/tenant-conflict'

export const dynamic = 'force-dynamic'

const PAGE = 1000

interface TeaserTrade extends TradeWithExcursion, ProxyTrade {
  trading_day_id: string
  exit_time: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exits_json: any
  mfe_dollars_per_leg: number | null
}

export interface FirstReadTeaser {
  date: string
  pnl: number
  tradeCount: number
  winRate: number | null      // 0..100, null when no trades carry a pnl
  capturePct: number | null   // 0..100 (avg MFE captured), null when no excursion data
  mfeMaeRatio: number | null  // favorable $ / adverse $, null when no adverse data
  flag: string | null         // one plain-language read: behavioral signal, else a capture verdict
}

/** Page a Supabase select past the 1000-row cap, ordered by id for stable paging. */
async function fetchAll<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: () => any,
): Promise<T[]> {
  const out: T[] = []
  let from = 0
  for (let p = 0; p < 25; p++) {
    const { data, error } = await build().order('id', { ascending: true }).range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) break
    from += PAGE
  }
  return out
}

/** Top behavioral signal for a day → a short plain-language line, else a capture verdict. */
function readFlag(dayTrades: TeaserTrade[], capturePct: number | null): string | null {
  const { proxies } = computeBehavioralProxies(dayTrades)
  // Highest-severity signal first (flag > mild); label + detail already user-facing.
  const signal = proxies
    .filter(p => p.severity !== 'none')
    .sort((a, b) => (a.severity === 'flag' ? 0 : 1) - (b.severity === 'flag' ? 0 : 1))[0]
  if (signal) return signal.detail || signal.label
  // No behavioral drift — fall back to an exit-quality read from capture.
  if (capturePct == null) return null
  if (capturePct >= 70) return 'Sharp exits — you kept most of the move you were offered.'
  if (capturePct >= 40) return 'Middling capture — you left part of the move on the table.'
  return 'You gave back most of the favorable move before exiting.'
}

function teaserFor(date: string, dayTrades: TeaserTrade[], pnl: number): FirstReadTeaser {
  const withPnl = dayTrades.filter(t => t.pnl != null)
  const wins = withPnl.filter(t => (t.pnl ?? 0) > 0).length
  const winRate = withPnl.length > 0 ? (wins / withPnl.length) * 100 : null
  const cap = avgCaptureRatio(dayTrades)
  const capturePct = cap.avg == null ? null : Math.round(cap.avg * 100)
  const ratio = avgMfeMaeRatio(dayTrades).ratio
  return {
    date,
    pnl,
    tradeCount: dayTrades.length,
    winRate,
    capturePct,
    mfeMaeRatio: ratio == null ? null : Math.round(ratio * 10) / 10,
    flag: readFlag(dayTrades, capturePct),
  }
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any

  // Arm / dismiss state (write-once flag on the trader_profile default row).
  let armed = false
  let dismissed = false
  try {
    const { data } = await db.from('trader_profile').select('onboarding_json').eq('id', 'default').maybeSingle()
    const fr = data?.onboarding_json?.first_read
    armed = fr != null
    dismissed = fr?.dismissed === true
  } catch { /* columns not migrated → treat as unarmed */ }

  // Days + their P&L (eod_pnl override wins; else sum of the day's trade P&L).
  let days: { id: string; date: string; eod_pnl: number | null }[] = []
  let trades: TeaserTrade[] = []
  try {
    days = await fetchAll<{ id: string; date: string; eod_pnl: number | null }>(
      () => db.from('trading_days').select('id, date, eod_pnl'),
    )
    trades = await fetchAll<TeaserTrade>(
      () => db.from('trades').select(
        'id, trading_day_id, pnl, direction, entry_time, exit_time, quantity, entry_price, stop_price, symbol, high_during_position, low_during_position, exits_json, mfe_dollars_per_leg',
      ),
    )
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'query failed' }, { status: 500 })
  }

  const byDay = new Map<string, TeaserTrade[]>()
  for (const t of trades) {
    const arr = byDay.get(t.trading_day_id) ?? []
    arr.push(t)
    byDay.set(t.trading_day_id, arr)
  }

  // Candidate days: those with at least one trade. Displayed P&L = override else
  // summed trade P&L (only days with trades qualify, so the sum is meaningful).
  const scored = days
    .map(d => {
      const dt = byDay.get(d.id) ?? []
      if (dt.length === 0) return null
      const pnl = d.eod_pnl != null ? d.eod_pnl : dt.reduce((s, t) => s + (t.pnl ?? 0), 0)
      return { date: d.date, trades: dt, pnl }
    })
    .filter((x): x is { date: string; trades: TeaserTrade[]; pnl: number } => x != null)

  if (scored.length === 0) {
    return NextResponse.json({ armed, dismissed, best: null, worst: null })
  }

  let bestDay = scored[0]
  let worstDay = scored[0]
  for (const s of scored) {
    if (s.pnl > bestDay.pnl) bestDay = s
    if (s.pnl < worstDay.pnl) worstDay = s
  }

  const best = teaserFor(bestDay.date, bestDay.trades, bestDay.pnl)
  // Single day of history, or best === worst: collapse to one card client-side.
  const worst = worstDay.date === bestDay.date
    ? null
    : teaserFor(worstDay.date, worstDay.trades, worstDay.pnl)

  return NextResponse.json({ armed, dismissed, best, worst })
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any

  const body = await req.json().catch(() => ({}))
  const dismiss = body?.dismiss === true
  const arm = body?.action === 'arm'
  if (!dismiss && !arm) return NextResponse.json({ error: 'nothing to do' }, { status: 400 })

  let onboarding: Record<string, unknown> = {}
  try {
    const { data } = await db.from('trader_profile').select('onboarding_json').eq('id', 'default').maybeSingle()
    onboarding = (data?.onboarding_json as Record<string, unknown>) ?? {}
  } catch {
    // Columns not migrated — nothing to persist to. Report success so the client
    // flow (import teaser) still proceeds; the card just won't reappear later.
    return NextResponse.json({ ok: true, migration_pending: true })
  }

  const existing = (onboarding.first_read as Record<string, unknown> | undefined) ?? undefined
  let first_read: Record<string, unknown>
  if (dismiss) {
    first_read = { ...(existing ?? { created_at: new Date().toISOString() }), dismissed: true }
  } else {
    // Arm is write-once: never overwrite an existing (possibly dismissed) flag.
    if (existing) return NextResponse.json({ ok: true, armed: true })
    first_read = { created_at: new Date().toISOString() }
  }

  try {
    await db.from('trader_profile').upsert(
      { id: 'default', onboarding_json: { ...onboarding, first_read }, updated_at: new Date().toISOString() },
      { onConflict: userConflict('id') },
    )
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'save failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, armed: true, dismissed: dismiss })
}
