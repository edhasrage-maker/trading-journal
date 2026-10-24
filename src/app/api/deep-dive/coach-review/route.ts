import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient, isServiceConfigured } from '@/lib/supabase/service'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { deepDiveAllowed } from '@/lib/deep-dive-access'
import { resolveRubric, type ScoringProfile } from '@/lib/scoring-profile'
import { consumeAiUsage, peekAiUsage, type UsageResult } from '@/lib/ai-usage'
import { resolveAiModel } from '@/lib/ai-model'
import { getTraderProfile, profileContextBlock } from '@/lib/trader-profile'
import { evaluateRules, readEntryRules } from '@/lib/entry-rules'
import { entryCtxIsCurrent, flowScoreIsCurrent } from '@/lib/orderflow/flow-score-meta'
import { chartSeriesRoot } from '@/lib/futures-symbols'
import { TAPE_KEEP_DAYS } from '@/lib/orderflow/tape'
import {
  COACH_REVIEW_EXTRA, COACH_REVIEW_SCHEMA, COACH_REVIEW_SYSTEM, CoachReviewInputError,
  buildCoachReviewInput, coachReviewKey, finishCoachReview, parseCoachReview, staleReason, timeLabelsIn, traderBlock,
} from '@/lib/coach-review'
import type { DeepDiveTradeRow } from '@/lib/orderflow/server/deep-dive-payload'
import type { TradeCoachReview, TradeEntryCtx, TradeFlowScore, TradeReview, TradeVerdict } from '@/lib/supabase/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const client = new Anthropic()
const ACTION = 'coach_review'
const UUID = /^[0-9a-f-]{36}$/i
const COULDNT = 'Couldn\'t get one just now.'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/** Today's count, as the panel shows it ("9 of 10 left today"). */
export interface CoachReviewUsage { used: number; limit: number; remaining: number }

/** GET ?open=1 and POST answer. */
export interface CoachReviewResponse {
  usage: CoachReviewUsage
  review?: TradeCoachReview | null
  /** Why the saved review is out of date ("Ask again" shows); null when it stands. */
  stale?: string | null
  /** The site keeps 90 days of tick data and this trade is older. */
  tooOld?: boolean
  error?: string
  /** No call saved on the trade yet. */
  locked?: boolean
}

type Row = DeepDiveTradeRow & {
  verdict: TradeVerdict | null
  coach: TradeCoachReview | null
  entry_ctx: TradeEntryCtx | null
  score: TradeFlowScore | null
}

const usageOf = (u: UsageResult): CoachReviewUsage => ({ used: u.used, limit: u.limit, remaining: u.remaining })
const reply = (body: CoachReviewResponse, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const tooOld = (row: Row) => !LOCAL_FEATURES_ENABLED && Date.now() - Date.parse(row.entry_time ?? '') > TAPE_KEEP_DAYS * 86_400_000

/**
 * The trade's entry-time columns, its call (the gate only), its saved review
 * and its two entry-time reads; the trader's settings and profile; and the
 * version key of all that. Nothing after the fill is selected.
 */
async function load(supabase: AnyClient, id: string) {
  const { BLIND_TRADE_COLUMNS } = await import('@/lib/orderflow/server/deep-dive-payload')
  const { data, error } = await supabase.from('trades').select(`${BLIND_TRADE_COLUMNS}, ${COACH_REVIEW_EXTRA}`).eq('id', id).maybeSingle()
  if (error) return { error: error.code === '42703' ? 'This database has no trade reviews yet.' : error.message, status: error.code === '42703' ? 503 : 500 }
  if (!data) return { error: 'trade not found', status: 404 }
  const row = data as Row
  const { data: prof } = await supabase.from('trader_profile').select('scoring_profile_json').eq('id', 'default').maybeSingle()
  const sp = (prof?.scoring_profile_json && typeof prof.scoring_profile_json === 'object' ? prof.scoring_profile_json : null) as ScoringProfile | null
  const rubric = resolveRubric(sp)
  const rules = readEntryRules(sp?.entry_rules)
  const profile = await getTraderProfile()
  const of = rubric.usesOrderFlow
  const entryCtx = entryCtxIsCurrent(row.entry_ctx, row) ? row.entry_ctx : null
  const flow = of && flowScoreIsCurrent(row.score, row) ? row.score : null
  const key = coachReviewKey({ row, entryCtx, flow, rules, sp, profileText: profile.preferences_md, usesOrderFlow: of })
  const saved = row.coach && Array.isArray(row.coach.items) && row.coach.items.length ? row.coach : null
  return { row, sp, rubric, rules, profile, of, entryCtx, flow, key, saved }
}

async function caller() {
  const supabase: AnyClient = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return { supabase, user }
}

/**
 * GET /api/deep-dive/coach-review?id=<trade uuid>            → { usage }
 * GET /api/deep-dive/coach-review?id=<trade uuid>&open=1     → { usage, review, stale, tooOld }
 *
 * Replay Review's Coach Review panel. Without open=1 it only says how many
 * are left today (the locked panel shows it). With open=1 it hands back the
 * saved review — and only once the trader's call is saved on the trade; the
 * panel asks for it only after the trader has made their call (in Blind, a
 * call made on this visit), so a saved review can't anchor a fresh read.
 */
export async function GET(req: Request) {
  const { supabase, user } = await caller()
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 })
  if (!deepDiveAllowed(user.email)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id') ?? ''
  if (!UUID.test(id)) return NextResponse.json({ error: 'id=<trade uuid> required' }, { status: 400 })

  const usage = usageOf(await peekAiUsage(supabase, ACTION))
  if (searchParams.get('open') !== '1') return reply({ usage })
  const L = await load(supabase, id)
  if ('error' in L) return reply({ usage, error: L.error }, L.status)
  if (!L.row.verdict?.call) return reply({ usage, error: 'Make your call first.', locked: true }, 403)
  return reply({ usage, review: L.saved, stale: L.saved ? staleReason(L.saved, L.key) : null, tooOld: tooOld(L.row) })
}

/**
 * POST /api/deep-dive/coach-review  { id }  → { usage, review }
 *
 * Asks for the trade's Coach Review. Refused until the trader's call is saved.
 * A saved review made from the same inputs comes straight back (nothing is
 * used); otherwise the Blind payload is built — cut at the fill on the server,
 * the same cut as Blind — and turned into the model's input, one unit of the
 * day's limit is used, and the answer is checked line by line and saved on
 * the trade (review_json.coach_review, read-merge).
 */
export async function POST(req: Request) {
  const { supabase, user } = await caller()
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 })
  if (!deepDiveAllowed(user.email)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  let id = ''
  try { id = String((await req.json())?.id ?? '') } catch { /* below */ }
  if (!UUID.test(id)) return NextResponse.json({ error: 'id (trade uuid) required' }, { status: 400 })

  const L = await load(supabase, id)
  const peek = async () => usageOf(await peekAiUsage(supabase, ACTION))
  if ('error' in L) return reply({ usage: await peek(), error: L.error }, L.status)
  const { row } = L
  if (!row.verdict?.call) return reply({ usage: await peek(), error: 'Make your call first.', locked: true }, 403)
  if (L.saved && !staleReason(L.saved, L.key)) return reply({ usage: await peek(), review: L.saved, stale: null })
  if (tooOld(row)) return reply({ usage: await peek(), error: 'The site keeps 90 days of tick data and this trade is older.', tooOld: true }, 404)
  const root = row.symbol ? chartSeriesRoot(row.symbol) : ''
  if (root !== 'NQ' && root !== 'ES') return reply({ usage: await peek(), error: `Coach Review reads NQ / MNQ and ES / MES; this trade is ${row.symbol ?? 'unknown'}.` }, 422)

  // the Blind payload: cut at the fill second on the server, the only market data it reads
  const { buildDeepDivePayload, buildDeepDivePayloadFromTape, DeepDiveError } = await import('@/lib/orderflow/server/deep-dive-payload')
  const opts = { blind: true, atrStopTarget: L.rubric.atrStopTarget, tp1RMultiple: L.rubric.tp1RMultiple }
  let input
  try {
    let payload
    if (LOCAL_FEATURES_ENABLED) payload = buildDeepDivePayload(row, opts)
    else {
      if (!isServiceConfigured()) return reply({ usage: await peek(), error: 'Replay Review is not set up on this deployment yet.' }, 503)
      const { supabaseTapeStore } = await import('@/lib/orderflow/server/tape-store')
      payload = await buildDeepDivePayloadFromTape(row, opts, supabaseTapeStore(createServiceClient()))
    }
    const rules = L.rules.length
      ? evaluateRules(L.rules, L.entryCtx, { direction: row.direction, symbol: row.symbol, entry_time: row.entry_time }).filter(r => r.counted)
      : null
    input = buildCoachReviewInput({ payload, usesOrderFlow: L.of, rules, entryCtx: L.entryCtx, flow: L.flow })
  } catch (e) {
    if (e instanceof DeepDiveError) return reply({ usage: await peek(), error: e.status === 404 ? 'The tick data at your fill isn\'t on the site.' : e.message, tooOld: e.status === 404 }, e.status)
    if (e instanceof CoachReviewInputError) return reply({ usage: await peek(), error: `Couldn't read the chart at your fill: ${e.message}.` }, 422)
    throw e
  }
  const trader = traderBlock({ profileBlock: profileContextBlock(L.profile), sp: L.sp, usesOrderFlow: L.of, atrStopTarget: L.rubric.atrStopTarget, tp1RMultiple: L.rubric.tp1RMultiple })
  input.labels.push(...timeLabelsIn(trader))

  // one ask = one unit of the day's limit, spent before the model call
  const gate = await consumeAiUsage(supabase, ACTION)
  if (!gate.allowed) return reply({ usage: usageOf(gate), error: gate.message }, 429)
  const usage = usageOf(gate)
  const model = await resolveAiModel(supabase, user)

  let text = ''
  try {
    const msg = await client.messages.create({
      model,
      max_tokens: 4000,
      system: [{ type: 'text', text: COACH_REVIEW_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: trader, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: input.text },
        ],
      }],
      output_config: { format: { type: 'json_schema', schema: COACH_REVIEW_SCHEMA } },
    })
    if (msg.stop_reason === 'refusal') return reply({ usage, error: COULDNT }, 502)
    text = msg.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? ''
  } catch (e) {
    console.error('[coach-review] model call failed:', e instanceof Error ? e.message : e)
    return reply({ usage, error: COULDNT }, 502)
  }
  const parsed = parseCoachReview(text)
  const review = parsed && finishCoachReview(parsed, input, { model, at: new Date().toISOString(), key: L.key })
  if (!review) {
    console.error('[coach-review] no usable lines:', text.slice(0, 400))
    return reply({ usage, error: COULDNT }, 502)
  }

  // saved read-merge, like the call (/api/trades/[id]/review): the other parts of review_json stay as they are
  const { data: cur } = await supabase.from('trades').select('review_json').eq('id', id).maybeSingle()
  const next: TradeReview = { ...((cur?.review_json as TradeReview | null) ?? {}), coach_review: review }
  const { error: wErr } = await supabase.from('trades').update({ review_json: next }).eq('id', id)
  if (wErr) console.warn('[coach-review] could not save:', wErr.message)
  return reply({ usage, review, stale: null })
}
