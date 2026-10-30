import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { consumeAiUsage } from '@/lib/ai-usage'
import { createClient } from '@/lib/supabase/server'
import { loadTapeScoreSettings } from '@/lib/day-stats-server'
import { buildSummaryPrompt, summaryRuleResults, type SummaryTrade } from '@/lib/trade-summary-prompt'
import type { RuleResult } from '@/lib/entry-rules'
import type { TradeEntryCtx } from '@/lib/supabase/types'

const client = new Anthropic()

/**
 * POST /api/trades/summary
 * Body: { trades: SummaryTrade[] }
 *
 * Returns a 1-2 line plain-language narrative per trade, woven from its tags
 * (setups / order flow / confluences / management / mistakes) plus the trader's
 * own notes — e.g. "Dicey long but saw 3 failures at IBL with absorption and a
 * delta fade, so I entered above the cluster and targeted the imbalance."
 *
 * Each counted entry rule's result and reason goes in as a fact, read here from
 * the trade's own row under the trader's rules (src/lib/trade-summary-prompt.ts).
 *
 * The whole day's trades are summarized in ONE call; the client caches results
 * by content hash so this only runs when a trade's tags/notes actually change.
 */
export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }, { status: 503 })
  }

  const supabase = await createClient()
  if (!LOCAL_FEATURES_ENABLED) {
    const gate = await consumeAiUsage(supabase, 'trades_summary')
    if (!gate.allowed) return NextResponse.json({ error: gate.message, ...gate }, { status: 429 })
  }

  let trades: SummaryTrade[] = []
  try {
    const body = (await req.json()) as { trades?: SummaryTrade[] }
    trades = Array.isArray(body.trades) ? body.trades : []
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }
  if (trades.length === 0) return NextResponse.json({ summaries: {} })

  // The rule facts. Read under RLS, so only the trader's own trades come back;
  // any failure just leaves them out (the summary still writes from the tags).
  const rulesById = new Map<string, { results: RuleResult[]; autoTags: string[] }>()
  try {
    const { entryRules } = await loadTapeScoreSettings(supabase)
    if (entryRules.some(r => r.on)) {
      const { data } = await supabase
        .from('trades')
        .select('id, direction, symbol, entry_time, entry_ctx:review_json->entry_ctx, auto_tags:review_json->auto_tags')
        .in('id', trades.map(t => t.id))
      for (const row of (data ?? []) as { id: string; direction: string | null; symbol: string | null; entry_time: string | null; entry_ctx: TradeEntryCtx | null; auto_tags: unknown }[]) {
        const autoTags = Array.isArray(row.auto_tags) ? row.auto_tags.filter((x): x is string => typeof x === 'string') : []
        rulesById.set(row.id, { results: summaryRuleResults(entryRules, { ...row, auto_tags: autoTags }), autoTags })
      }
    }
  } catch { /* summaries without rule facts */ }

  const prompt = buildSummaryPrompt(trades, rulesById)

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return NextResponse.json({ summaries: {} })
    const parsed = JSON.parse(jsonMatch[0]) as { summaries?: Record<string, string> }
    return NextResponse.json({ summaries: parsed.summaries ?? {} })
  } catch (e) {
    const err = e as { message?: string; error?: { message?: string } }
    console.error('[trades/summary] failed:', err)
    return NextResponse.json({ error: err?.error?.message ?? err?.message ?? 'summary failed' }, { status: 500 })
  }
}
