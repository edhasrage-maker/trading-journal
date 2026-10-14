import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient, isServiceConfigured } from '@/lib/supabase/service'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { deepDiveAllowed } from '@/lib/deep-dive-access'
import { FLOW_VERSION, FLOW_SCORE_MAX_IDS } from '@/lib/orderflow/flow-score-meta'
import type { FlowHourSource } from '@/lib/orderflow/server/flow-score-loader'
import type { FlowTradeRecord, FlowTradeStore } from '@/lib/orderflow/server/flow-score-run'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Stop starting new trades after this long and hand the rest back as "pending" (the client asks again). */
const BUDGET_MS = 40_000

/**
 * POST /api/trades/score   body: { ids: string[] }   (at most 25 trade ids)
 *   → { v, results: { [tradeId]: FlowScoreResult }, entry: { [tradeId]: EntryCtxResult } }   (flow-score-meta.ts)
 *
 * `entry` is the entry rules' snapshot of each fill (trades.review_json.entry_ctx,
 * src/lib/orderflow/entry-context.ts), read from the same ticks under the same
 * write rules (entry-context-run.ts) — in any session, not just 06:30–13:00.
 *
 * The trade Score (five order-flow facts at the fill, version flow-4) computed
 * on the site from the tick tape — the same read the local Python scorer makes
 * from Sierra files (src/lib/orderflow/flow-score.ts is its port).
 *
 * For each of the caller's own trades (read and written through their session,
 * so RLS scopes them):
 *   - already carries this version's score for this exact fill → returned as is
 *     ("current"), nothing computed
 *   - otherwise scored and written into trades.review_json.score, READ-MERGE:
 *     the row is re-read just before the write and only `score` is replaced, so
 *     the trader's verdict and any other key survive
 *   - cannot be scored (older than the tape, another instrument, outside the
 *     day session) → "not_scorable" with the reason; nothing is written
 *   - the feed has not published the fill's minutes yet → "pending"; nothing is
 *     written, ask again in a minute
 * An id that is not one of the caller's trades is simply absent from `results`.
 *
 * ACCESS. Same private beta as Deep Dive (deep-dive-access.ts): everyone else
 * gets a 404, as for a route that does not exist. The local build is always
 * allowed and reads Sierra .scid files instead of the tape.
 *
 * DATA. Market data only is read with the server key (the private tick-tape
 * bucket), never another user's rows. Per-session numbers are cached as small
 * JSON objects under `score-ctx/` in that bucket (flow-score-loader.ts).
 */

// One source per server instance: its decoded-hour cache is what makes the next request warm.
let source: Promise<FlowHourSource> | null = null
function flowSource(): Promise<FlowHourSource> {
  if (!source) {
    const p = (async () => {
      const L = await import('@/lib/orderflow/server/flow-score-loader')
      if (LOCAL_FEATURES_ENABLED) return L.scidFlowSource()
      const { supabaseTapeStore } = await import('@/lib/orderflow/server/tape-store')
      return L.tapeFlowSource(supabaseTapeStore(createServiceClient()))
    })()
    source = p
    p.catch(() => { if (source === p) source = null })
  }
  return source
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 })
  if (!deepDiveAllowed(user.email)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  let body: { ids?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
  const ids = [...new Set((Array.isArray(body?.ids) ? body.ids : []).filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)))]
  if (!ids.length) return NextResponse.json({ error: 'ids: string[] (trade uuids) required' }, { status: 400 })
  if (ids.length > FLOW_SCORE_MAX_IDS) return NextResponse.json({ error: `at most ${FLOW_SCORE_MAX_IDS} trades per request` }, { status: 400 })
  if (!LOCAL_FEATURES_ENABLED && !isServiceConfigured()) return NextResponse.json({ error: 'Scores are not set up on this deployment yet.' }, { status: 503 })

  const { scoreTrades, FLOW_TRADE_COLUMNS } = await import('@/lib/orderflow/server/flow-score-run')
  const { FlowScoreLoader } = await import('@/lib/orderflow/server/flow-score-loader')
  const { readEntryContexts } = await import('@/lib/orderflow/server/entry-context-run')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- review_json is newer than the generated types
  const db = supabase as any
  const store: FlowTradeStore = {
    async read(want) {
      const { data, error } = await db.from('trades').select(FLOW_TRADE_COLUMNS).in('id', want)
      if (error) throw new Error(error.message)
      return (data ?? []) as FlowTradeRecord[]
    },
    async readOne(id) {
      const { data, error } = await db.from('trades').select(FLOW_TRADE_COLUMNS).eq('id', id).maybeSingle()
      if (error) throw new Error(error.message)
      return (data ?? null) as FlowTradeRecord | null
    },
    async writeReview(id, review) {
      const { error } = await db.from('trades').update({ review_json: review }).eq('id', id)
      if (error) throw new Error(error.message)
    },
  }
  try {
    // One loader for both reads, so a fill's session ticks are fetched once. The entry rules'
    // snapshot goes first: it needs only the day's ticks, which the Score then reuses.
    let shared: Promise<InstanceType<typeof FlowScoreLoader>> | null = null
    const loader = () => (shared ??= (async () => new FlowScoreLoader(await flowSource()))())
    const started = Date.now()
    const entry = await readEntryContexts(store, ids, loader, { deadline: started + BUDGET_MS })
    const results = await scoreTrades(store, ids, loader, { budgetMs: Math.max(0, BUDGET_MS - (Date.now() - started)) })
    return NextResponse.json({ v: FLOW_VERSION, results, entry }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[trades/score]', e)
    return NextResponse.json({ error: 'could not score those trades' }, { status: 500 })
  }
}
