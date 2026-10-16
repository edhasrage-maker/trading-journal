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
import { type TradeWithExcursion } from '@/lib/analytics'
import { mgmtTotals, mgmtView } from '@/lib/trade-management'
import { computeBehavioralProxies, type ProxyTrade } from '@/lib/behavioral-proxies'
import { computeInsights, type InsightTrade, type RankedInsight } from '@/lib/data-insights'
import { mergeDiveInsights, runDives, toDiveRows, type DiveRow } from '@/lib/deep-dive/registry'
import { userConflict } from '@/lib/tenant-conflict'

export const dynamic = 'force-dynamic'

const PAGE = 1000

interface TeaserTrade extends TradeWithExcursion, ProxyTrade {
  trading_day_id: string
  exit_time: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exits_json: any
  mfe_dollars_per_leg: number | null
  entry_atr_1m: number | null
}

export interface FirstReadTeaser {
  date: string
  pnl: number
  tradeCount: number
  winRate: number | null      // 0..100, null when no trades carry a pnl
  /** Trades that went your way (up at least 1×ATR at some point) and how many
   *  could be sorted at all. Zero/zero when the day has no price data. */
  went: number
  classified: number
  keptPct: number | null      // 0..100 on the trades that went your way; null when none did
  flag: string | null         // one plain-language read from a behavioral signal, else null
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

/** Top behavioral signal for a day → a short plain-language line, else nothing.
 *  (This used to fall back to a capture verdict — "you gave back most of the
 *  move". A low kept figure is not a mistake on its own, so it no longer gets a
 *  sentence that says it is.) */
function readFlag(dayTrades: TeaserTrade[]): string | null {
  const { proxies } = computeBehavioralProxies(dayTrades)
  // Highest-severity signal first (flag > mild); label + detail already user-facing.
  const signal = proxies
    .filter(p => p.severity !== 'none')
    .sort((a, b) => (a.severity === 'flag' ? 0 : 1) - (b.severity === 'flag' ? 0 : 1))[0]
  return signal ? (signal.detail || signal.label) : null
}

function teaserFor(date: string, dayTrades: TeaserTrade[], pnl: number): FirstReadTeaser {
  const withPnl = dayTrades.filter(t => t.pnl != null)
  const wins = withPnl.filter(t => (t.pnl ?? 0) > 0).length
  const winRate = withPnl.length > 0 ? (wins / withPnl.length) * 100 : null
  // One definition with the rest of the app (src/lib/trade-management.ts). ×ATR
  // is the app's default unit; a day with no ATR behind it reads in points.
  const totals = mgmtTotals(dayTrades)
  const atrView = mgmtView(totals, 'atr')
  const view = atrView.went.keptPct != null || atrView.went.count === 0 ? atrView : mgmtView(totals, 'pts')
  return {
    date,
    pnl,
    tradeCount: dayTrades.length,
    winRate,
    went: view.went.count,
    classified: view.classified,
    keptPct: view.went.keptPct != null ? Math.round(view.went.keptPct * 100) : null,
    flag: readFlag(dayTrades),
  }
}

export async function GET(req: Request) {
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

  // The dashboard card ONLY renders when armed && !dismissed. On every other
  // dashboard load (returning users — the overwhelming majority) the expensive
  // whole-history days+trades scan below is pure waste. Short-circuit on the
  // cheap flag read so those loads cost one small query, not ~1s. The /import
  // success block always needs the teaser regardless of the flag, so it asks
  // with ?force=1.
  const force = new URL(req.url).searchParams.get('force') === '1'
  if (!force && (!armed || dismissed)) {
    return NextResponse.json({ armed, dismissed, best: null, worst: null, insights: [] })
  }

  // Days + their P&L (eod_pnl override wins; else sum of the day's trade P&L).
  let days: { id: string; date: string; eod_pnl: number | null }[] = []
  let trades: TeaserTrade[] = []
  try {
    days = await fetchAll<{ id: string; date: string; eod_pnl: number | null }>(
      () => db.from('trading_days').select('id, date, eod_pnl'),
    )
    trades = await fetchAll<TeaserTrade>(
      () => db.from('trades').select(
        'id, trading_day_id, pnl, direction, entry_time, exit_time, quantity, entry_price, exit_price, stop_price, symbol, high_during_position, low_during_position, exits_json, mfe_dollars_per_leg, entry_atr_1m, stops:review_json->stops',
      ),
    )
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'query failed' }, { status: 500 })
  }

  // Tag-free insights (Pt 15) over the whole imported history — the same
  // gated/ranked "what your data already says" read the Patterns page shows,
  // teased on the first-read card so a brand-new tagless account gets a payoff
  // beyond just best/worst day. Empty on a thin sample (the engine suppresses).
  // Deep dives run over the SAME rows and merge into the same ranked list: they
  // answer what the contrast engine can't ("scaling out costs you $X over 205
  // scale-outs"), and each supersedes any shallower read of its own subject.
  // Compute a few extra contrasts so the merge has real candidates to rank.
  const insights: RankedInsight[] = mergeDiveInsights(
    computeInsights(trades as unknown as InsightTrade[], { limit: 5 }),
    runDives(toDiveRows(trades as unknown as (Partial<DiveRow> & { id: string })[])),
    3,
  )

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
    return NextResponse.json({ armed, dismissed, best: null, worst: null, insights })
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

  return NextResponse.json({ armed, dismissed, best, worst, insights })
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
