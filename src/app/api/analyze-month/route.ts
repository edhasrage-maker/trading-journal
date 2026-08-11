/**
 * POST /api/analyze-month
 * Body: { month: 'YYYY-MM' }
 *
 * The monthly sibling of /api/analyze-week: a structured recap over one
 * calendar month, built from the SAME buildCoachContext helper as the chatbox
 * and the weekly recap, cached in monthly_recap.ai_synthesis_json.
 *
 * Deliberately NO letter grade (the weekly one predates the recap redesign;
 * the TapeScore is the grade — a second A–F vocabulary re-graded the same
 * decisions in different words).
 *
 * Response shape (matches monthly_recap.ai_synthesis_json):
 *   {
 *     prior_week_overview: string   // prior MONTH overview (field name shared
 *     week_comparison: string[]     // with the weekly UI so one renderer serves both)
 *     headline: string
 *     themes: string[]
 *     what_worked: string[]
 *     what_didnt: string[]
 *     focus_next_week: string[]     // focus for next MONTH
 *     generated_at: string
 *     model: string
 *   }
 */

import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { userConflict } from '@/lib/tenant-conflict'
import { consumeAiUsage } from '@/lib/ai-usage'
import { createClient } from '@/lib/supabase/server'
import { getTraderProfile, profileContextBlock } from '@/lib/trader-profile'
import { buildCoachContext } from '@/lib/coach-context'
import { ANALYSIS_APPROACH } from '@/lib/coach-methodology'
import { monthRange, previousMonth, monthLabel } from '@/lib/period-recap'

const client = new Anthropic()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 503 })
  }

  if (!LOCAL_FEATURES_ENABLED) {
    const supabase = await createClient()
    const gate = await consumeAiUsage(supabase, 'analyze_week')
    if (!gate.allowed) return NextResponse.json({ error: gate.message, ...gate }, { status: 429 })
  }

  let body: { month?: string }
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }

  const month = body.month
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: 'month YYYY-MM required' }, { status: 400 })
  }

  const supabase: AnyClient = await createClient()
  const { start, end } = monthRange(month)
  const label = monthLabel(month)
  const prevM = previousMonth(month)
  const prevRange = monthRange(prevM)
  const prevLabel = monthLabel(prevM)
  const traderProfile = await getTraderProfile()

  const thisMonthContext = await buildCoachContext(supabase, {
    startDate: start,
    endDate: end,
    windowLabel: `this month (${label})`,
    includeWeekOverWeek: false,
    recentTradesLimit: 50,
  })
  const priorMonthContext = await buildCoachContext(supabase, {
    startDate: prevRange.start,
    endDate: prevRange.end,
    windowLabel: `PRIOR month (${prevLabel})`,
    includeWeekOverWeek: false,
    recentTradesLimit: 0,
  })

  const systemPrompt = `${profileContextBlock(traderProfile)}You are the trader's personal coach producing a structured monthly recap. You have TWO data blocks below: this month, and the prior month (for trend comparison). Synthesize across the month — patterns, themes, what worked, what didn't, where to focus next month. A month is a real sample: favour findings that held across multiple weeks over one loud day.

Be specific. Cite dates, setup names, PnL figures, day types from the actual data. Don't give generic advice. When the data doesn't support a confident call, say so explicitly — an honest "nothing separated itself this month" beats a manufactured lesson. Defer to the trader's coaching preferences (above) over any generic best practice.

${ANALYSIS_APPROACH}

${thisMonthContext}

${priorMonthContext}

Respond with ONLY valid JSON in this exact structure (no markdown fences):
{
  "prior_week_overview": "<2-3 sentences recapping the PRIOR month — PnL, win rate, what defined it — and the single biggest shift INTO this month, with the number. Empty string if the prior month had no trading data.>",
  "week_comparison": ["<Dimension-by-dimension comparison of THIS month vs the PRIOR month, citing BOTH months' numbers. One bullet each for: (1) setup performance shifts; (2) MFE capture change; (3) execution change; (4) compliance change; (5) any THEME or mistake that recurred in BOTH months. Skip a bullet only if that dimension has no prior-month data. 4-6 bullets.>"],
  "headline": "<1 sentence, ≤15 words — the WHY of the month in one line>",
  "themes": ["<cross-week pattern 1 with specifics>", "<pattern 2>", "<3-5 total>"],
  "what_worked": ["<specific decision/setup/behavior that paid off>", "<up to 4 total>"],
  "what_didnt": ["<specific decision/setup/behavior that cost you>", "<up to 4 total>"],
  "focus_next_week": ["<actionable item for NEXT MONTH with specifics>", "<2-3 total>"]
}

LENGTH DISCIPLINE:
  - headline: ≤15 words
  - prior_week_overview: 2-3 sentences, under 60 words
  - week_comparison bullets: 1 sentence each, under 30 words, each leading with the dimension (e.g. "Setups:", "Capture:", "Execution:", "Compliance:", "Recurring:")
  - themes / what_worked / what_didnt / focus bullets: 1 sentence each, under 25 words

Respond starting with { and ending with }.`

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    messages: [{ role: 'user', content: systemPrompt }],
  })

  const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
  let parsed: Record<string, unknown> = {}
  try {
    const stripped = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
    const match = stripped.match(/\{[\s\S]*\}/)
    if (match) parsed = JSON.parse(match[0])
  } catch (e) {
    console.error('[analyze-month] JSON parse failed:', e instanceof Error ? e.message : 'unknown')
    return NextResponse.json({
      error: 'AI response could not be parsed as JSON',
      raw: text.slice(0, 1000),
    }, { status: 500 })
  }

  const generatedAt = new Date().toISOString()
  const synthesis = {
    ...parsed,
    generated_at: generatedAt,
    model: 'claude-sonnet-4-6',
  }

  try {
    await supabase
      .from('monthly_recap')
      .upsert(
        {
          month_start_date: start,
          ai_synthesis_json: synthesis,
          generated_at: generatedAt,
          updated_at: generatedAt,
        },
        { onConflict: userConflict('month_start_date') },
      )
  } catch (e) {
    // Table missing — soft-fail; the synthesis still returns to the client.
    console.warn('[analyze-month] persistence skipped:', e instanceof Error ? e.message : 'unknown')
  }

  return NextResponse.json(synthesis)
}
