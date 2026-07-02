import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getTraderProfile, profileContextBlock } from '@/lib/trader-profile'
import { computeCoachScore, type GradableTrade } from '@/lib/coach-score'

const client = new Anthropic()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * POST /api/trades/coach-score  — the AI half of the Coach Score.
 * Body: { trade: GradableTrade & { notes?: string } }
 *
 * The deterministic pass (src/lib/coach-score.ts) leaves the judgment criteria
 * as `unknown`. This route resolves ONLY those from the trade's notes + tags,
 * so the user pays for AI only on the gaps their tags didn't cover. Returns
 * per-key { status, reason }; the client folds them in via applyAiResolutions().
 *
 * No usage cap here — this is the private tool. The public port applies the
 * ai_usage cap (see [[project_coach_score_transfer]]).
 */

// Rubric definitions for the criteria that come back `unknown` (mirrors
// eod-prompt.ts §Execution Parameters).
const CRITERION_DEF: Record<string, string> = {
  clear_aoi: 'clear_area_of_interest — PASS if the entry is anchored to a specific structural level (PDH/PDL, IBH/IBL, ONH/ONL, an HTF zone, an LVN, or a demand/supply cluster). A generic mid-range entry with no level FAILS. "na" only if there is genuinely no location context in the notes to judge.',
  break_of_cluster: 'break_of_cluster_or_bubble_entry — PASS if the trigger was a structural break (price breaking through a cluster of orders, or breaking above/below a delta bubble). A purely discretionary price entry with no such break FAILS.',
  chart_not_emotion: 'chart_not_emotion_management — PASS if exits were driven by clear technical/structural reads (e.g. "a big buyer stepped in above and did not get rewarded"). FAIL if exits were PnL-anchored emotional decisions (e.g. "scared to give back profits before target"). "na" if there is no exit reasoning to judge.',
  tp1_at_2r: 'tp1_at_2r_or_reasoned — this trade\'s planned TP1 was BELOW 2R. PASS only if the notes give an explicit structural reason for the sub-2R target (a one-off level / specific structural target). No reason = FAIL.',
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }, { status: 503 })
  }
  let body: { trade?: GradableTrade & { notes?: string } }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
  const trade = body.trade
  if (!trade) return NextResponse.json({ error: 'trade required' }, { status: 400 })

  const supabase: AnyClient = await createClient()
  const { data: tagRows } = await supabase.from('trade_tags').select('label').eq('category', 'setups')
  const setupLibrary = new Set<string>(((tagRows ?? []) as { label: string }[]).map(r => r.label.toLowerCase()))

  const cs = computeCoachScore(trade, { setupLibrary })
  const unknowns = cs.criteria.filter(c => c.status === 'unknown')
  if (unknowns.length === 0) return NextResponse.json({ resolutions: {}, resolved: 0 })

  const notes = (trade.notes ?? '').trim()
  const tj = trade.tags_json ?? {}
  const tagSummary = Object.entries(tj)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? (v.join(', ') || '—') : (v ?? '—')}`)
    .join('; ')
  const profile = await getTraderProfile()
  const criteriaList = unknowns.map((c, i) => `${i + 1}. key="${c.key}" — ${CRITERION_DEF[c.key] ?? c.label}`).join('\n')

  const prompt = `You are grading ONE trade against specific execution criteria. Resolve ONLY the criteria listed, using the trade's notes + tags. Be strict and honest — if the notes don't support a pass, don't invent one.

TRADE
- direction: ${trade.direction ?? '—'}, quantity: ${trade.quantity ?? '—'}
- entry: ${trade.entry_price ?? '—'}, stop: ${trade.stop_price ?? '—'}, TP1: ${trade.tp1_price ?? '—'}
- tags: ${tagSummary || '(none)'}
- notes: ${notes || '(none)'}
${profileContextBlock(profile)}

CRITERIA TO RESOLVE
${criteriaList}

For each key decide "pass", "fail", or "na" (na only when there is genuinely nothing to judge), each with a ONE-LINE reason (≤ 12 words). Return ONLY JSON:
{ "resolutions": { "<key>": { "status": "pass|fail|na", "reason": "<short>" } } }`

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  })
  const text = message.content[0].type === 'text' ? message.content[0].text : '{}'
  try {
    const m = text.match(/\{[\s\S]*\}/)
    const data = m ? JSON.parse(m[0]) : {}
    const validKeys = new Set(unknowns.map(u => u.key))
    const out: Record<string, { status: 'pass' | 'fail' | 'na'; reason?: string }> = {}
    for (const [k, v] of Object.entries((data.resolutions ?? {}) as Record<string, { status?: string; reason?: string }>)) {
      if (!validKeys.has(k)) continue
      if (v.status === 'pass' || v.status === 'fail' || v.status === 'na') {
        out[k] = { status: v.status, reason: typeof v.reason === 'string' ? v.reason.slice(0, 80) : undefined }
      }
    }
    return NextResponse.json({ resolutions: out, resolved: Object.keys(out).length })
  } catch {
    return NextResponse.json({ resolutions: {}, resolved: 0 })
  }
}
