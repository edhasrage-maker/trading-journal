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

interface DayTypeDef {
  label: string
  description: string | null
}

interface PredictResponse {
  prediction: string
  reasoning: string
  confidence: 'high' | 'medium' | 'low'
}

const CONFIDENCE_VALUES = ['high', 'medium', 'low'] as const

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

  // Pull the active day_type library + descriptions. This replaces the old
  // hardcoded 7-label list which kept leaking stale labels (Trend Day, Range
  // Day) into the user's pruned library every time the user accepted a
  // prediction. Now there's exactly one source of truth.
  //
  // Graceful fallback: if the `description` column hasn't been added yet
  // (migration 2026-06-03-tag-descriptions.sql not run), select without it.
  let dayTypeDefs: DayTypeDef[] = []
  const withDesc = await supabase
    .from('trade_tags')
    .select('label, description')
    .eq('category', 'day_type')
    .order('sort_order') as { data: DayTypeDef[] | null; error: { message: string; code?: string } | null }
  if (withDesc.error) {
    // Likely "column does not exist" — retry without description.
    const labelsOnly = await supabase
      .from('trade_tags')
      .select('label')
      .eq('category', 'day_type')
      .order('sort_order') as { data: { label: string }[] | null }
    dayTypeDefs = (labelsOnly.data ?? []).map(r => ({ label: r.label, description: null }))
  } else {
    dayTypeDefs = withDesc.data ?? []
  }
  if (dayTypeDefs.length === 0) {
    return NextResponse.json(
      { error: 'No day types in the trade_tags library. Add some via /settings/tags or the prep page.' },
      { status: 400 },
    )
  }

  const notes = day.prep_notes_json ?? {}
  const hasAnyContext = ctx != null && (ctx.rvol != null || ctx.adr != null || ctx.ib_size != null || ctx.atr_1m != null)
  const hasAnyNotes = Object.values(notes).some(v => v != null && (typeof v === 'string' ? v.trim().length > 0 : true))
  if (!hasAnyContext && !hasAnyNotes) {
    return NextResponse.json(
      { error: 'Not enough data: fill out market context or prep notes first.' },
      { status: 400 },
    )
  }

  const prompt = buildPrompt(date, ctx, notes, dayTypeDefs)

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
    const allowed = new Set(dayTypeDefs.map(d => d.label))
    if (!allowed.has(parsed.prediction)) {
      throw new Error(`Prediction "${parsed.prediction}" is not in the day_type library (${[...allowed].join(', ')})`)
    }
    // Confidence is required but tolerate a missing/weird value — default to
    // medium so the UI can still render rather than 500'ing.
    if (!CONFIDENCE_VALUES.includes(parsed.confidence as typeof CONFIDENCE_VALUES[number])) {
      parsed.confidence = 'medium'
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
    confidence: parsed.confidence,
    model: 'claude-sonnet-4-6',
    generated_at: new Date().toISOString(),
  })
}

function buildPrompt(date: string, ctx: MarketContext | null, notes: PrepNotes, dayTypeDefs: DayTypeDef[]): string {
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

  // Render the dynamic day-type list with descriptions where available, label
  // alone otherwise. Definitions live in trade_tags.description — editable via
  // /settings/tags so the trader can refine without touching code.
  const dayTypeListBlock = dayTypeDefs.map(d => {
    const desc = d.description?.trim()
    return desc
      ? `- "${d.label}": ${desc}`
      : `- "${d.label}": (no description yet — infer from the label name)`
  }).join('\n')

  return `You are a futures trading coach predicting the SESSION CHARACTER (day type) for ${date} based on the trader's pre-market data. The trader trades NQ futures using an MGI-based framework.

Pick EXACTLY ONE of these ${dayTypeDefs.length} day type${dayTypeDefs.length === 1 ? '' : 's'} (use the label EXACTLY as written, including capitalization, spaces, parentheses, and special characters):
${dayTypeListBlock}

══ INPUTS ══

Market context for ${date}:
${ctxBlock}

Pre-market notes from the trader:
${notesBlock}

══ HEURISTICS TO APPLY ══

These are well-established structural rules. Treat them as priors that should weight your call — not absolutes, but the trader's own bias notes and structural context must JUSTIFY overriding them, not just compete with them.

1. **GBX % of ADR ≥ 80 BEFORE RTH opens**: the expected daily range is mostly spent overnight. The statistical base rate strongly favors mean reversion — Range Day, Neutral Day, or Double Distribution. Trend Day requires a fresh expansion narrative (scheduled news, decisive IB break, regime shift) that has NOT already been played out overnight. Sustained continuation from an already-extended overnight is the LESS common outcome.

2. **Failure to take out PDH (for longs) or PDL (for shorts) despite a strong overnight extension**: rotation / distribution risk. Don't predict Trend Day in the direction of the prior overnight move without a CONFIRMED level break. "If price breaks the IB high" is conditional — the breakout has not happened yet.

3. **Inside prior day's value with no level break**: leans Neutral Day or Range Day. Inside-day rotation is the default; Trend Days usually require leaving the prior session's value area early and not coming back.

4. **IB size ≥ 100% of 10-day avg with location inside prior day's value**: Double Distribution risk — the IB expansion may be one distribution that pulls back to value before a second one forms. Not auto-Trend.

5. **P-shape profile at session highs**: ambiguous on its own. Confirms continuation ONLY when paired with a long-tail at the lows AND the IBL holding firm on retest. P-shape with stalling at the highs and NO confirming long-tail can equally mean distribution / topping action.

6. **Weight current state over conditional state**: phrases like "if it breaks IB highs" or "once it clears PDH" describe a future event that has not happened. The most likely outcome must reflect what the inputs say RIGHT NOW, not what they say AFTER a hypothetical breakout.

7. **The trader's bias notes are inputs, not conclusions**: a "bullish bias" from the trader does not by itself elevate Trend Day. If structural data (heuristics 1-6) conflict with the bias, the structural data wins and the reasoning should flag the conflict.

══ HOW TO ANSWER ══

Apply the heuristics above to today's specific inputs. Cite the actual metric values that drive your call — don't speak generically. When heuristics conflict (e.g., a high IB with a fresh news driver), call out the conflict explicitly in the reasoning.

Set "confidence" honestly:
- **high**: heuristics align, structural inputs are unambiguous, and the trader's bias matches.
- **medium**: most signals align but at least one conflict needs resolving (e.g., structure says Range, bias says Trend; or a key input is missing).
- **low**: conflicting heuristics, sparse data, or the call genuinely could go more than one way. When in doubt between two day types, pick the more conservative ("Neutral Day" beats "Trend Day" under low confidence) and set confidence low.

══ RESPONSE FORMAT ══

Respond with ONLY a valid JSON object (no markdown, no code fences, no preamble):
{
  "prediction": "<one of the day type labels above EXACTLY as written>",
  "reasoning": "<2-3 sentences. Cite specific numbers or notes from the inputs. If you're overriding any heuristic above, explain why explicitly.>",
  "confidence": "high" | "medium" | "low"
}`
}
