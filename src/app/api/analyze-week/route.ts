/**
 * POST /api/analyze-week
 * Body: { weekStart: 'YYYY-MM-DD' }
 *
 * Generates a structured weekly recap using the SAME buildCoachContext
 * helper the chatbox uses (guaranteeing consistency between the two
 * surfaces). The synthesis is cached in weekly_recap.ai_synthesis_json
 * so re-loading the recap page doesn't re-spend tokens.
 *
 * Response shape (matches weekly_recap.ai_synthesis_json):
 *   {
 *     prior_week_overview: string       // 2-3 sentence recap of last week + the shift in
 *     week_comparison: string[]         // dimension-by-dimension vs prior week (setups/capture/exec/compliance/recurring)
 *     headline: string                  // 1 sentence, ≤15 words
 *     themes: string[]                  // 3-5 cross-day patterns
 *     what_worked: string[]
 *     what_didnt: string[]
 *     focus_next_week: string[]         // 2-3 actionable items
 *     weekly_grade: 'A' | 'B' | 'C' | 'D' | 'F'   // execution quality, not PnL
 *     grade_reasoning: string
 *     generated_at: string              // ISO timestamp
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
import { weekEnd, weekLabel, previousWeekStart } from '@/lib/week-dates'

const client = new Anthropic()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * Execution composite + compliance for a date range. These come from the EOD
 * analysis (trading_days.eod_ai_analysis_json) and are NOT in buildCoachContext,
 * so the synthesis can't compare them without this. Mirrors how the weekly page
 * reads them: execution.composite (0-1) and process.verdict ('Compliant'|'Breach').
 */
async function weekExecCompliance(supabase: AnyClient, start: string, end: string): Promise<{ execAvg: number | null; compliant: number; verdictDays: number }> {
  const { data } = await supabase
    .from('trading_days')
    .select('eod_ai_analysis_json')
    .gte('date', start)
    .lte('date', end)
  let execSum = 0, execN = 0, compliant = 0, verdictDays = 0
  for (const d of (data ?? []) as Array<{ eod_ai_analysis_json?: { execution?: { composite?: number }; process?: { verdict?: string } } }>) {
    const comp = d.eod_ai_analysis_json?.execution?.composite
    if (typeof comp === 'number') { execSum += comp; execN++ }
    const v = d.eod_ai_analysis_json?.process?.verdict
    if (v === 'Compliant' || v === 'Breach') { verdictDays++; if (v === 'Compliant') compliant++ }
  }
  return { execAvg: execN > 0 ? execSum / execN : null, compliant, verdictDays }
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 503 })
  }

  if (!LOCAL_FEATURES_ENABLED) {
    const supabase = await createClient()
    const gate = await consumeAiUsage(supabase, 'analyze_week')
    if (!gate.allowed) return NextResponse.json({ error: gate.message, ...gate }, { status: 429 })
  }

  let body: { weekStart?: string }
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }

  const weekStart = body.weekStart
  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return NextResponse.json({ error: 'weekStart YYYY-MM-DD required' }, { status: 400 })
  }

  const supabase: AnyClient = await createClient()
  const endDate = weekEnd(weekStart)
  const traderProfile = await getTraderProfile()

  // Build this week's context block.
  const thisWeekContext = await buildCoachContext(supabase, {
    startDate: weekStart,
    endDate,
    windowLabel: `this week (${weekLabel(weekStart)})`,
    includeWeekOverWeek: false,
    recentTradesLimit: 50,
  })

  // Also pull the prior week's context for comparison — Claude can spot
  // trend changes (mistakes repeating, setup performance shifts).
  const prevStart = previousWeekStart(weekStart)
  const prevEnd = weekEnd(prevStart)
  const priorWeekContext = await buildCoachContext(supabase, {
    startDate: prevStart,
    endDate: prevEnd,
    windowLabel: `PRIOR week (${weekLabel(prevStart)})`,
    includeWeekOverWeek: false,
    recentTradesLimit: 0,
  })

  // Execution + compliance for both weeks — NOT in the context blocks above
  // (they come from the EOD analysis), so the comparison needs them injected.
  const [twEC, pwEC] = await Promise.all([
    weekExecCompliance(supabase, weekStart, endDate),
    weekExecCompliance(supabase, prevStart, prevEnd),
  ])
  const ecPct = (v: number | null) => (v != null ? `${Math.round(v * 100)}%` : 'n/a')
  const ecDays = (c: number, n: number) => (n > 0 ? `${c}/${n} days` : 'n/a')
  const execComplianceBlock = `EXECUTION & COMPLIANCE — week over week (from the EOD analysis; not in the data blocks above):
  This week (${weekLabel(weekStart)}):  avg execution ${ecPct(twEC.execAvg)} · compliance ${ecDays(twEC.compliant, twEC.verdictDays)}
  PRIOR week (${weekLabel(prevStart)}): avg execution ${ecPct(pwEC.execAvg)} · compliance ${ecDays(pwEC.compliant, pwEC.verdictDays)}`

  const systemPrompt = `${profileContextBlock(traderProfile)}You are the trader's personal coach producing a structured weekly recap. You have TWO data blocks below: this week, and the prior week (for trend comparison). Synthesize across the week — patterns, themes, what worked, what didn't, where to focus next week.

Be specific. Cite trade dates, setup names, PnL figures, day types from the actual data. Don't give generic advice. When the data doesn't support a confident call, say so explicitly. Defer to the trader's coaching preferences (above) over any generic best practice.

${ANALYSIS_APPROACH}

${thisWeekContext}

${priorWeekContext}

${execComplianceBlock}

Respond with ONLY valid JSON in this exact structure (no markdown fences):
{
  "prior_week_overview": "<2-3 sentences recapping the PRIOR week's performance — PnL, win rate, execution quality, what defined it — and the single biggest shift INTO this week (improved/worsened, with the number). Use the PRIOR week data block. If there was no prior-week trading data, return an empty string.>",
  "week_comparison": ["<Dimension-by-dimension comparison of THIS week vs the PRIOR week, citing BOTH weeks' numbers. One bullet for EACH of: (1) setup performance shifts — which setups improved/degraded WR & PnL; (2) MFE capture change — winners' capture % this vs prior; (3) execution change — avg execution this vs prior; (4) compliance change — compliant days this vs prior; (5) any THEME or mistake that recurred in BOTH weeks (the behavioral pattern that didn't resolve). Skip a bullet only if that dimension has no prior-week data. 4-6 bullets.>"],
  "headline": "<1 sentence, ≤15 words — the WHY of the week in one line>",
  "themes": ["<cross-day pattern 1 with specifics>", "<pattern 2>", "<3-5 total>"],
  "what_worked": ["<specific decision/setup/behavior that paid off>", "<up to 4 total>"],
  "what_didnt": ["<specific decision/setup/behavior that cost you>", "<up to 4 total>"],
  "focus_next_week": ["<actionable item with specifics>", "<2-3 total>"],
  "weekly_grade": "<A | B | C | D | F — grade EXECUTION quality, NOT PnL. Was the WAY you traded sound regardless of result?>",
  "grade_reasoning": "<1-2 sentences explaining the grade>"
}

LENGTH DISCIPLINE:
  - headline: ≤15 words
  - prior_week_overview: 2-3 sentences, under 60 words
  - week_comparison bullets: 1 sentence each, under 30 words, each leading with the dimension (e.g. "Setups:", "Capture:", "Execution:", "Compliance:", "Recurring:")
  - themes / what_worked / what_didnt / focus_next_week bullets: 1 sentence each, under 25 words
  - grade_reasoning: 1-2 sentences

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
    console.error('[analyze-week] JSON parse failed:', e instanceof Error ? e.message : 'unknown')
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

  // Persist into weekly_recap (upsert on week_start_date) so future loads
  // skip the API call.
  try {
    await supabase
      .from('weekly_recap')
      .upsert(
        {
          week_start_date: weekStart,
          ai_synthesis_json: synthesis,
          generated_at: generatedAt,
          updated_at: generatedAt,
        },
        { onConflict: userConflict('week_start_date') },
      )
  } catch (e) {
    // Table missing — soft-fail; the synthesis still returns to the client.
    console.warn('[analyze-week] persistence skipped:', e instanceof Error ? e.message : 'unknown')
  }

  return NextResponse.json(synthesis)
}
