import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { PrepNotes, MarketContext } from '@/lib/supabase/types'

const client = new Anthropic()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

interface ReqBody {
  date: string  // YYYY-MM-DD
}

const DAY_TYPES = [
  'Trend Day',
  'Range Day',
  'Neutral Day',
  'Gap and Go',
  'Gap Reversal',
  'Double Distribution',
  'Volatile/News Day',
] as const

interface PredictResponse {
  prediction: string
  reasoning: string
}

/**
 * POST /api/predict-day-type
 *   body: { date }
 *
 * Asks Claude to pick the most likely day-type for the given date, given the
 * pre-market data already saved on trading_days + market_context. No
 * server-side cache — every call spends tokens, which is fine because this
 * is button-triggered. The user accepts the prediction by setting
 * trading_days.day_type via the regular prep save; this route does NOT write
 * back to the database.
 */
export async function POST(req: Request) {
  try {
    return await handle(req)
  } catch (e) {
    const err = e as { message?: string; status?: number; error?: { type?: string; message?: string } }
    const detail = err?.error?.message ?? err?.message ?? 'unknown server error'
    console.error('[predict-day-type] failed:', err)
    return NextResponse.json({ error: detail, type: err?.error?.type, status: err?.status }, { status: 500 })
  }
}

async function handle(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }, { status: 503 })
  }

  const body = (await req.json()) as ReqBody
  const { date } = body
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 })
  }

  const supabase: AnyClient = await createClient()

  // Fetch trading_days row (for prep_notes_json) and market_context (metrics).
  const { data: day } = await supabase
    .from('trading_days')
    .select('id, prep_notes_json')
    .eq('date', date)
    .single() as { data: { id: string; prep_notes_json: PrepNotes | null } | null }

  if (!day) {
    return NextResponse.json(
      { error: `No trading_day row for ${date}. Fill out the prep first.` },
      { status: 400 },
    )
  }

  const { data: ctx } = await supabase
    .from('market_context')
    .select('*')
    .eq('trading_day_id', day.id)
    .single() as { data: MarketContext | null }

  const notes = day.prep_notes_json ?? {}
  const hasAnyContext = ctx != null && (ctx.rvol != null || ctx.adr != null || ctx.ib_size != null || ctx.atr_1m != null)
  const hasAnyNotes = Object.values(notes).some(v => v != null && (typeof v === 'string' ? v.trim().length > 0 : true))
  if (!hasAnyContext && !hasAnyNotes) {
    return NextResponse.json(
      { error: 'Not enough data: fill out market context or prep notes first.' },
      { status: 400 },
    )
  }

  const prompt = buildPrompt(date, ctx, notes)

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  })
  const text = message.content[0]?.type === 'text' ? message.content[0].text : ''

  let parsed: PredictResponse
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON object found in Claude response')
    parsed = JSON.parse(jsonMatch[0]) as PredictResponse
    if (typeof parsed.prediction !== 'string' || typeof parsed.reasoning !== 'string') {
      throw new Error('Response missing prediction or reasoning')
    }
    if (!DAY_TYPES.includes(parsed.prediction as typeof DAY_TYPES[number])) {
      throw new Error(`Prediction "${parsed.prediction}" is not one of the allowed day types`)
    }
  } catch (e) {
    console.error('[predict-day-type] parse failed:', e, '\nraw text:', text.slice(0, 500))
    return NextResponse.json(
      {
        error: `Claude returned malformed output: ${e instanceof Error ? e.message : 'unknown'}`,
        rawSnippet: text.slice(0, 500),
      },
      { status: 500 },
    )
  }

  return NextResponse.json({
    prediction: parsed.prediction,
    reasoning: parsed.reasoning,
    model: 'claude-sonnet-4-6',
    generated_at: new Date().toISOString(),
  })
}

function buildPrompt(date: string, ctx: MarketContext | null, notes: PrepNotes): string {
  const ctxLines: string[] = []
  if (ctx) {
    if (ctx.symbol) ctxLines.push(`- Symbol: ${ctx.symbol}`)
    if (ctx.rvol != null) ctxLines.push(`- RVOL: ${ctx.rvol}${ctx.rvol_flag ? ` (${ctx.rvol_flag})` : ''}`)
    if (ctx.adr != null) ctxLines.push(`- ADR: ${ctx.adr}${ctx.adr_flag ? ` (${ctx.adr_flag})` : ''}`)
    if (ctx.gbx_pct_adr != null) ctxLines.push(`- Globex move as % of ADR: ${ctx.gbx_pct_adr}`)
    if (ctx.ib_size != null) {
      const vs = ctx.ib_vs_10d_avg != null ? ` (${(ctx.ib_vs_10d_avg * 100).toFixed(0)}% of 10-day avg ${ctx.ib_10d_avg ?? '?'})` : ''
      ctxLines.push(`- IB size: ${ctx.ib_size}${vs}`)
    }
    if (ctx.atr_1m != null) ctxLines.push(`- ATR (1m): ${ctx.atr_1m}${ctx.atr_flag ? ` (${ctx.atr_flag})` : ''}`)
    if (ctx.pdh != null && ctx.pdl != null) ctxLines.push(`- Prior day range: ${ctx.pdl} – ${ctx.pdh}`)
    if (ctx.ibh != null && ctx.ibl != null) ctxLines.push(`- Initial Balance: ${ctx.ibl} – ${ctx.ibh}`)
    if (ctx.onh != null && ctx.onl != null) ctxLines.push(`- Overnight range: ${ctx.onl} – ${ctx.onh}`)
    if (ctx.price_in_pd_range) ctxLines.push(`- Price location vs prior day range: ${ctx.price_in_pd_range}`)
    if (ctx.price_in_gbx_range) ctxLines.push(`- Price location vs Globex range: ${ctx.price_in_gbx_range}`)
  }
  const ctxBlock = ctxLines.length > 0 ? ctxLines.join('\n') : '  (no market context filled in yet)'

  const noteLines: string[] = []
  if (notes.bias) noteLines.push(`- Bias: ${notes.bias}${notes.bias_notes ? ` — ${notes.bias_notes}` : ''}`)
  if (notes.ib_behaviour) noteLines.push(`- IB behaviour: ${notes.ib_behaviour}`)
  if (notes.ib_extensions_reached?.length) noteLines.push(`- IB extensions reached: ${notes.ib_extensions_reached.join(', ')}`)
  if (notes.volume_profile_shape) noteLines.push(`- Volume profile shape: ${notes.volume_profile_shape}`)
  if (notes.volume_profile_notes) noteLines.push(`- Volume profile notes: ${notes.volume_profile_notes}`)
  if (notes.vwap_slope) noteLines.push(`- VWAP slope: ${notes.vwap_slope}`)
  if (notes.ema_slope) noteLines.push(`- EMA slope: ${notes.ema_slope}`)
  if (notes.setups_areas) noteLines.push(`- Setups / areas of interest: ${notes.setups_areas}`)
  if (notes.market_clarity) noteLines.push(`- Market clarity read: ${notes.market_clarity}`)
  if (notes.mood) noteLines.push(`- Trader mood: ${notes.mood}`)
  if (notes.trade_plans?.length) {
    noteLines.push(`- ${notes.trade_plans.length} trade plan${notes.trade_plans.length === 1 ? '' : 's'} prepared.`)
  }
  const notesBlock = noteLines.length > 0 ? noteLines.join('\n') : '  (no pre-market notes filled in yet)'

  return `You are a futures trading coach predicting the SESSION CHARACTER (day type) for ${date} based on the trader's pre-market data. The trader trades NQ futures.

Pick EXACTLY ONE of these 7 day types:
- "Trend Day": persistent directional move; sustained imbalance; little mean reversion within the session.
- "Range Day": defined high and low established early; price rotates between them; mean reversion dominates.
- "Neutral Day": chop with mixed signals; no decisive directional commitment; balanced or rotational profile.
- "Gap and Go": price gapped open and holds; session extends in the gap direction.
- "Gap Reversal": price gapped open but the gap fades; session prints the opposite direction.
- "Double Distribution": two distinct value areas form during the session with a transition between them.
- "Volatile/News Day": elevated realized volatility driven by a scheduled event or shock.

══ INPUTS ══

Market context for ${date}:
${ctxBlock}

Pre-market notes from the trader:
${notesBlock}

══ HOW TO ANSWER ══

Reason through what these inputs suggest about session character. Cite the specific metric values that drive your call — don't speak generically. Be honest if the signal is weak: if the data is sparse or conflicted, lean toward "Neutral Day" and say so in the reasoning.

══ RESPONSE FORMAT ══

Respond with ONLY a valid JSON object (no markdown, no code fences, no preamble):
{
  "prediction": "<one of the 7 day types EXACTLY as written above, including spaces and capitalization>",
  "reasoning": "<2-3 sentences. Cite specific numbers or notes from the inputs.>"
}`
}
