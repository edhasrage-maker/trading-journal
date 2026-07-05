import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { consumeAiUsage } from '@/lib/ai-usage'
import { getTraderProfile, profileContextBlock } from '@/lib/trader-profile'
import { computeCoachScore, type GradableTrade } from '@/lib/coach-score'
import { resolveRubric, scoringProfileSummary, type ScoringProfile } from '@/lib/scoring-profile'

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
 * Capped per user/day (`coach_score`, generous — see AI_LIMITS) but ONLY when a
 * model call actually happens: if tags already resolve every criterion we return
 * early below WITHOUT consuming a unit. Fail-open on the personal DB (no ai_usage
 * RPC) so local mode is unaffected.
 */

// Rubric definitions for the criteria that come back `unknown` (mirrors
// eod-prompt.ts §Execution Parameters). Methodology-neutral: location,
// structure, and risk are judged for EVERY trader; the order-flow lens is
// profile-gated below (feedback_no_forced_orderflow). `tp1_at_2r` is built
// per-user in the handler (the R-multiple + TP target come from the profile).
const CRITERION_DEF: Record<string, string> = {
  clear_aoi: 'clear_area_of_interest — PASS if the entry is anchored to a specific level or structure the trader trades from (session levels, prior-day levels, an HTF zone, S/R, a demand/supply area, an LVN, etc.). A generic mid-range entry with no level FAILS. "na" only if there is genuinely no location context in the notes to judge.',
  valid_entry_trigger: 'valid_entry_trigger — PASS if the entry used a DEFINED trigger/model from the TRADER\'S OWN playbook (whatever that is for them — a break/retest, a candle trigger, a level reclaim, an indicator flip, a price-based trigger, etc.). A purely discretionary poke with no method described FAILS. Do not require any ONE specific model, and do not impose a methodology they don\'t use.',
  rule_based_exit: 'rule_based_exit — this exit was NOT a clean TP-hit or stop-out (those already auto-pass). Judge the discretionary exit: PASS if driven by a technical/structural read; FAIL if PnL-anchored emotion (e.g. "scared to give back profits before target"). "na" if there is no exit reasoning to judge.',
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

  // Per-user rules: grade against the trader's own scoring profile (onboarding),
  // not the owner's Ruleset v1.3. Empty/missing → default rubric (owner-parity).
  const { data: profRow } = await supabase
    .from('trader_profile').select('scoring_profile_json').eq('id', 'default').maybeSingle()
  const scoringProfile: ScoringProfile =
    profRow?.scoring_profile_json && typeof profRow.scoring_profile_json === 'object'
      ? (profRow.scoring_profile_json as ScoringProfile) : {}
  const rubric = resolveRubric(scoringProfile)

  const cs = computeCoachScore(trade, { setupLibrary, scoringProfile })
  const unknowns = cs.criteria.filter(c => c.status === 'unknown')
  if (unknowns.length === 0) return NextResponse.json({ resolutions: {}, resolved: 0 })

  // A model call is now unavoidable — consume one unit of the daily budget.
  const gate = await consumeAiUsage(supabase, 'coach_score')
  if (!gate.allowed) return NextResponse.json({ error: gate.message, ...gate }, { status: 429 })

  const notes = (trade.notes ?? '').trim()
  const tj = trade.tags_json ?? {}
  const tagSummary = Object.entries(tj)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? (v.join(', ') || '—') : (v ?? '—')}`)
    .join('; ')
  const profile = await getTraderProfile()

  // Per-user TP criterion — the threshold + the trader's stated TP approach.
  const tp1Def = `tp1_at_2r_or_reasoned — this trade's planned TP1 was BELOW the trader's ${rubric.tp1RMultiple}R target${scoringProfile.tp ? ` (their stated TP approach: "${scoringProfile.tp}")` : ''}. PASS only if the notes give an explicit reason for the lower target (a one-off level / specific structural target that fits their approach). No reason = FAIL.`
  const defFor = (key: string) => (key === 'tp1_at_2r' ? tp1Def : (CRITERION_DEF[key] ?? key))
  const criteriaList = unknowns.map((c, i) => `${i + 1}. key="${c.key}" — ${defFor(c.key)}`).join('\n')

  const rulesLine = scoringProfileSummary(scoringProfile)
  const lensNote = rubric.usesOrderFlow
    ? ''
    : `\nIMPORTANT: this trader does NOT trade order flow. Judge entirely within their price-action / structure / location / risk framework. NEVER fail or penalize a criterion for a missing order-flow / footprint / delta / absorption read — that lens does not apply to them.`

  const prompt = `You are grading ONE trade against specific execution criteria. Resolve ONLY the criteria listed, using the trade's notes + tags. Be strict and honest — if the notes don't support a pass, don't invent one.

TRADE
- direction: ${trade.direction ?? '—'}, quantity: ${trade.quantity ?? '—'}
- entry: ${trade.entry_price ?? '—'}, stop: ${trade.stop_price ?? '—'}, TP1: ${trade.tp1_price ?? '—'}
- tags: ${tagSummary || '(none)'}
- notes: ${notes || '(none)'}
${rulesLine ? `\nTHE TRADER'S OWN RULES (grade against THESE, not generic best practice): ${rulesLine}` : ''}${lensNote}
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
