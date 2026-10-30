import { evaluateRules, type EntryRuleConfig, type RuleResult } from '@/lib/entry-rules'
import type { TradeEntryCtx } from '@/lib/supabase/types'

/**
 * The prompt behind the coach's one-paragraph summary under each trade on the
 * Recap (POST /api/trades/summary). Pure, so a script can build the exact
 * prompt the route sends.
 *
 * Rule results go in as facts (founder, 2026-10-29): on Oct 29 the coach read
 * the auto mistake tag "Heiken Ashi already my colour" as Heiken Ashi being
 * AGAINST the trade, the opposite of what rule F6 measured. So each counted
 * entry rule's own result and reason — the same `evaluateRules` output the
 * Score panel shows — is in the block, and the tags the app added for failed
 * rules (review_json.auto_tags) are left out of the mistakes line so the coach
 * reads the rule, not a paraphrase of it.
 */

export interface SummaryTrade {
  id: string
  direction?: string | null
  entry_price?: number | null
  pnl?: number | null
  quantity?: number | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exits_json?: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tags_json?: any
  notes?: string | null
}

/** What the route reads from the trade's row to judge its rules. */
export interface SummaryRuleRow {
  direction: string | null
  symbol: string | null
  entry_time: string | null
  entry_ctx: TradeEntryCtx | null
  /** The mistake tags the app added because a rule failed. */
  auto_tags: string[]
}

/** The counted, known rule results for one trade (unknown and not-yet-counted rules are left out). */
export function summaryRuleResults(rules: readonly EntryRuleConfig[], row: SummaryRuleRow): RuleResult[] {
  if (!rules.length) return []
  return evaluateRules(rules, row.entry_ctx, { direction: row.direction, symbol: row.symbol, entry_time: row.entry_time })
    .filter(r => r.counted && r.status !== 'unknown')
}

export function buildSummaryPrompt(
  trades: readonly SummaryTrade[],
  rulesById: ReadonlyMap<string, { results: RuleResult[]; autoTags: string[] }> = new Map(),
): string {
  const list = (v: unknown) => Array.isArray(v) ? (v.join(', ') || '—') : (v || '—')
  let anyRules = false
  const block = trades.map(t => {
    const dir = t.direction?.toUpperCase() ?? '—'
    const pnl = t.pnl != null ? `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}` : '—'
    const tj = t.tags_json ?? {}
    const exits = Array.isArray(t.exits_json) && t.exits_json.length > 0
      ? t.exits_json.map((e: { qty?: number; price?: number }) => `${e.qty ?? '?'}@${e.price ?? '?'}`).join(', ')
      : '—'
    const r = rulesById.get(t.id)
    const auto = new Set(r?.autoTags ?? [])
    const mistakes = Array.isArray(tj.mistakes) ? tj.mistakes.filter((m: unknown) => !auto.has(m as string)) : tj.mistakes
    let rulesText = ''
    if (r?.results.length) {
      anyRules = true
      rulesText = '\n  entry rule checks:\n' + r.results.map(x =>
        `    - ${x.name} "${x.label}": ${x.status === 'pass' ? 'PASSED (kept the rule)' : 'FAILED (broke the rule)'}. ${x.reason}`,
      ).join('\n')
    }
    return `id: ${t.id}
  dir/size: ${dir} ${t.quantity ?? '?'} @ ${t.entry_price ?? '?'} | exits: ${exits} | PnL ${pnl}
  setups: ${list(tj.setups)} | order_flow: ${list(tj.order_flow)} | confluences: ${list(tj.confluences)}
  management: ${list(tj.trade_management)} | mistakes: ${list(mistakes)} | day_type: ${list(tj.day_type)}${rulesText}
  notes: ${t.notes?.trim() || '(none)'}`
  }).join('\n\n')

  const rulesGuide = anyRules ? `

Entry rule checks are facts the app measured on the 1-minute chart before the fill (the reasons are written to the trader as "you"). A FAILED rule is a mistake on that trade: mention it the way you would a tagged mistake, and leave PASSED rules out unless the notes talk about them. When you mention a rule, state its result exactly as given and never reverse it — keep the same candle colours, the same direction and the same times as its reason. Read the rule's name literally: "Heiken Ashi not already my colour" FAILS when Heiken Ashi had ALREADY turned the trade's own colour (green before a long, red before a short), i.e. a late entry after the move had already turned my way — it never means Heiken Ashi was against the trade. "Last candle my way" FAILS when the last closed candle closed against the trade.` : ''

  return `You are summarizing a futures trader's individual trades for their journal. The trader uses an MGI / order-flow approach with structural levels (PDH/PDL, IBH/IBL, ONH/ONL, VWAP) and order-flow triggers (absorption, exhaustion, delta, stacked imbalance).

For EACH trade below, write ONE punchy 1-2 line summary in the trader's own voice that weaves together the thesis: the setup + where it happened (confluence), the order-flow trigger, how it was managed/targeted, and the gist of any notes. Mention a mistake only if tagged or a rule failed. Keep it concrete and readable — like a human recap, not a list of tags.${rulesGuide}

Example style: "Dicey long but saw selling fail a 3rd time at IBL with absorption and a delta fade, so I entered above the cluster and targeted the stacked imbalance."

Trades:
${block}

Respond with ONLY valid JSON (no markdown, no code fences), mapping each trade id to its summary string:
{ "summaries": { "<id>": "<1-2 line summary>", ... } }`
}
