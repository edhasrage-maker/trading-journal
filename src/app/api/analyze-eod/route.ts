import Anthropic from '@anthropic-ai/sdk'
import { readFileSync } from 'fs'
import path from 'path'
import { NextResponse } from 'next/server'
import type { PrepNotes, AiAnalysis, Trade, MarketContext, EodAiAnalysis } from '@/lib/supabase/types'
import { normalizeAnthropicMediaType } from '@/lib/anthropic-image'

const client = new Anthropic()

/**
 * Load the v1.3 process+execution ruleset at module scope. The markdown file is
 * the canonical source — embed it verbatim into the EOD prompt so Claude grades
 * against the same spec the trader signed off on. If the file is missing (e.g.
 * a build that didn't include /docs), we fall back to a short notice rather
 * than crashing the route — the AI will still produce qualitative analysis.
 */
let RULESET_V13_MARKDOWN: string
try {
  RULESET_V13_MARKDOWN = readFileSync(
    path.join(process.cwd(), 'docs', 'Ruleset_v1.3_Process_Execution_Spec.md'),
    'utf8',
  )
} catch (e) {
  console.warn('[analyze-eod] could not load v1.3 ruleset, falling back to legacy scoring:', e)
  RULESET_V13_MARKDOWN = ''
}

interface AnalyzeEodBody {
  trades: Trade[]
  eodNotes?: string
  prepNotes?: PrepNotes
  prepAnalysis?: AiAnalysis
  marketContext?: Partial<MarketContext>
  imageBase64?: string | null
  imageMediaType?: string | null
}

export async function POST(req: Request) {
  try {
    return await handle(req)
  } catch (e) {
    const err = e as { message?: string; status?: number; error?: { type?: string; message?: string } }
    const detail = err?.error?.message ?? err?.message ?? 'unknown server error'
    console.error('[analyze-eod] failed:', err)
    return NextResponse.json({ error: detail, type: err?.error?.type, status: err?.status }, { status: 500 })
  }
}

async function handle(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }, { status: 503 })
  }

  const body = (await req.json()) as AnalyzeEodBody
  const { trades, eodNotes, prepNotes, prepAnalysis, marketContext, imageBase64, imageMediaType } = body
  const normalizedMediaType = imageBase64 ? normalizeAnthropicMediaType(imageMediaType) : null
  const hasImage = !!imageBase64 && normalizedMediaType != null
  if (imageBase64 && !hasImage) {
    console.warn('[analyze-eod] dropping image — unsupported media type:', imageMediaType)
  }

  // Format trade times in America/Los_Angeles to match the UI display — the AI
  // was quoting UTC times in its analysis (e.g. "15:48" for an 08:48 PT entry),
  // which confused the user reviewing the output. PT is the user's wall-clock.
  const PT_TIME_FMT = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const fmtTimePT = (iso: string | null | undefined): string => {
    if (!iso) return '--:--'
    const ms = Date.parse(iso)
    if (!Number.isFinite(ms)) return '--:--'
    const parts = PT_TIME_FMT.formatToParts(new Date(ms))
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
    return `${get('hour')}:${get('minute')}:${get('second')}`
  }

  const tradesBlock = trades.length === 0
    ? '  No trades taken today.'
    : trades.map((t, i) => {
        const time = fmtTimePT(t.entry_time)
        const dir = t.direction?.toUpperCase() ?? '--'
        const pnl = t.pnl != null ? `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}` : '--'
        const setups = t.tags_json?.setups?.join(', ') || '—'
        const confluences = t.tags_json?.confluences?.join(', ') || '—'
        const mistakes = t.tags_json?.mistakes?.join(', ') || '—'
        const emotions = t.tags_json?.emotions?.join(', ') || '—'
        const mgmt = t.tags_json?.trade_management?.join(', ') || '—'
        // Per-trade notes (trader's own typed reflection on this fill) and
        // recording_commentary (AI frame-grounded read of the same trade) are
        // BOTH richer than the structured tags. Including them lets the EOD
        // coach reason about patterns from real per-trade context instead of
        // just labels. recording_commentary may be the legacy raw-string shape
        // on a handful of pre-normalization rows — handle both.
        const notes = t.notes?.trim()
        const rc = t.recording_commentary
        const commentaryText = typeof rc === 'string'
          ? rc.trim()
          : (rc && typeof rc === 'object' && rc.text) ? rc.text.trim() : ''
        const notesLine = notes ? `\n       notes: ${notes}` : ''
        const commentaryLine = commentaryText ? `\n       AI frame commentary: ${commentaryText}` : ''
        // tp1_price + exit_price are needed for the AI to compute
        // planned_vs_realized_rr (Execution sub-metric). Without them the
        // model has nothing to anchor planned R against and returns null.
        const tp1 = t.tp1_price != null ? t.tp1_price : '?'
        const exit = t.exit_price != null ? t.exit_price : '?'
        return `  ${i + 1}. ${time} ${dir} @ ${t.entry_price ?? '?'} stop ${t.stop_price ?? '?'} TP1 ${tp1} exit ${exit} qty ${t.quantity ?? '?'} | PnL ${pnl}
       setups: ${setups} | confluences: ${confluences}
       management: ${mgmt} | mistakes: ${mistakes} | emotions: ${emotions}${notesLine}${commentaryLine}`
      }).join('\n')

  const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const wins = trades.filter(t => (t.pnl ?? 0) > 0).length
  const losses = trades.filter(t => (t.pnl ?? 0) < 0).length

  const chartInstructions = hasImage ? `
═══════════════════════════════════════════════
STEP 1 — INDEPENDENT CHART READ (image only)
═══════════════════════════════════════════════
Look ONLY at the EOD chart image. Do NOT reference the trade list yet.
Identify:
- Did price trend, rotate, or chop overall?
- Where were the key turning points / failed auctions / breakouts?
- Volume profile shape and acceptance / rejection zones

Briefly note this read in "summary" before evaluating the executions.

═══════════════════════════════════════════════
STEP 2 — EXECUTION REVIEW (text + chart)
═══════════════════════════════════════════════
Now read the trade list and trader's notes. Compare:
- Did entries align with structural levels visible on the chart?
- Did the chosen setups fit the day type that actually played out?
- Were there obvious missed trades or chased entries?` : ''

  const useV13 = RULESET_V13_MARKDOWN.length > 0

  const v13Block = useV13 ? `
══ TRADER'S RULESET v1.3 (verbatim — this is authoritative; do not soften) ══

${RULESET_V13_MARKDOWN}

══ HOW TO APPLY THE RULESET ══

You are scoring against the v1.3 spec above. Two orthogonal layers — never combined:

**Process layer (per-rule binary, session verdict by threshold):**
- For each of P1..P7, mark status as "pass", "fail", or "incomplete".
- Per v1.3 §Unscorable: P1-P6 incomplete counts as a FAIL (these are safety
  rails — required data missing means the session can't be verified clean).
  P7 incomplete is tolerated — it counts as a pass for the verdict math.
- For per-trade rules (P2/P3/P4/P5/P7), breach_count = number of trades that
  breached. For session-level rules (P1/P6), breach_count = 1 if breached else 0.
- pass_count = count of rules with status="pass" + P7 if its status="incomplete".
- Verdict = "Compliant" if pass_count >= 5; otherwise "Breach". This is the
  2026-06-08 amendment to v1.3 — a single isolated rule lapse no longer drops
  an otherwise disciplined session to Breach, but two simultaneous breaches
  do. The per-rule breakdown still surfaces every individual failure in the
  dashboard regardless of the session verdict — relaxing the threshold doesn't
  hide which rule failed. P&L does not override.

**Execution layer (continuous, diagnostic, compliant trades only):**
- Score each sub-metric on 0..1 (higher = better):
    - duration_to_thesis (weight 25%): did the trade reach its thesis in
      reasonable time? Drawn-out chop = lower. Quick clean resolution = higher.
    - mfe_capture (weight 25%): realized PnL ÷ peak favorable move. Use
      high_during_position / low_during_position if provided per trade.
    - mae_heat (weight 20%): 1 - (peak adverse / planned risk). Lower heat
      taken = higher score.
    - prep_adherence (weight 20%): did the trades taken match what was
      planned? Compare prep.bias to trade direction; prep.trade_plans[] to
      actual entries (was each entry a documented plan, or improvised?);
      prep.ib_behaviour / volume_profile_shape predictions to what played
      out; prep.day_types to realized day character. 1.0 = bias-aligned and
      every entry mapped to a documented plan on a correctly-read day. 0.0
      = trades off-bias, no plan match, day character misread. Null only
      when prep notes are entirely blank — nothing to compare against.
    - planned_vs_realized_rr (weight 10%): realized_rr ÷ reward_ratio
      (when both available). Compute from per-trade TP1/exit/stop now
      included in the trade block above.
- Composite = 0.25*duration + 0.25*mfe + 0.20*mae + 0.20*prep + 0.10*rr.
  Null any sub-metric you can't compute; if all are null, composite is null.
- compliant_trade_count = number of trades you included in the calc.
- If there are zero compliant trades, all execution sub-metrics are null.

**Be honest about what you can and can't see:** if orderflow context is missing
for a trade (P7 data-completeness), say so — don't infer it. If you can't tell
whether an entry was Qualifying S&D from the tags, mark P2 "incomplete" for
that trade.` : ''

  const legacyFrameworkBlock = useV13 ? '' : `
══ TRADER'S FRAMEWORK (read this before judging anything) ══

The trader uses an MGI-based approach (Market Generated Information). Setups use structural levels (PDH, PDL, IBH, IBL, ONH, ONL, HTF supply/demand). Entry triggers are order-flow based.

CRITICAL weighting rules:
1. Realized behavior outweighs opportunity cost. A missed setup is a maybe; a taken FOMO trade is a definite loss.
2. Patience ≠ paralysis.
3. Journal compliance is a major strength — call it out.
4. Near-TP exits aren't meaningful leaks.
5. FOMO entries are real mistakes — name them clearly.`

  const prompt = `You are an objective trading coach reviewing a trader's completed session${hasImage ? ' and the day\'s chart' : ''}.
${v13Block}${legacyFrameworkBlock}
${chartInstructions}

Day Prep Summary:
- Bias: ${prepNotes?.bias ?? 'Not set'} ${prepNotes?.bias_notes ?? ''}
- IB Behaviour expected: ${prepNotes?.ib_behaviour ?? 'Not set'}
- Volume Profile expected: ${prepNotes?.volume_profile_shape ?? 'Not set'}
- Mood / Clarity: ${prepNotes?.mood ?? 'Not set'} / ${prepNotes?.market_clarity ?? 'Not set'}
- AI Prep Quality Score (if any): ${prepAnalysis?.score ?? 'N/A'}/10
- Plans planned: ${prepNotes?.trade_plans?.length ?? 0}

Market Context:
- Rvol: ${marketContext?.rvol ?? 'N/A'}
- IB Size: ${marketContext?.ib_size ?? 'N/A'} (vs 10d avg ratio: ${marketContext?.ib_vs_10d_avg ?? 'N/A'})
- ADR: ${marketContext?.adr ?? 'N/A'} | ATR (1m): ${marketContext?.atr_1m ?? 'N/A'}
- PDH/PDL: ${marketContext?.pdh ?? 'N/A'} / ${marketContext?.pdl ?? 'N/A'}
- IBH/IBL: ${marketContext?.ibh ?? 'N/A'} / ${marketContext?.ibl ?? 'N/A'}

Session Summary (all timestamps America/Los_Angeles; cite them in PT in your reasoning):
- Trades: ${trades.length} (W ${wins} / L ${losses})
- Total PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}

Trades Taken (each may include the trader's own notes and a frame-grounded AI commentary written earlier from the OBS recording — treat the commentary as a separate independent observation from the structured tags):
${tradesBlock}

Trader's EOD Reflection:
${eodNotes?.trim() || '(none provided)'}

${useV13 ? `Respond with ONLY valid JSON in this exact structure (no markdown, no code fences):
{
  "summary": "<2-3 sentences on the session — call out the process verdict AND a one-line execution read>",
  "what_worked": ["<concrete behavior/decision that was a win>", "<up to 4 total>"],
  "mistakes": ["<recurring or specific bad decision — cite trades by number/time>", "<up to 5 total>"],
  "patterns": ["<setup/timing/management pattern across trades>", "<up to 4 total>"],
  "next_session_focus": ["<actionable focus item for tomorrow>", "<up to 3 total>"],
  "process": {
    "verdict": "Compliant" | "Breach",
    "per_rule": {
      "P1": { "status": "pass" | "fail" | "incomplete", "breach_count": <number>, "reason": "<brief if not pass>" },
      "P2": { "status": "...", "breach_count": <number>, "reason": "..." },
      "P3": { "status": "...", "breach_count": <number>, "reason": "..." },
      "P4": { "status": "...", "breach_count": <number>, "reason": "..." },
      "P5": { "status": "...", "breach_count": <number>, "reason": "..." },
      "P6": { "status": "...", "breach_count": <number>, "reason": "..." },
      "P7": { "status": "...", "breach_count": <number>, "reason": "..." }
    },
    "breach_count_vector": { "P1": <number>, "P2": <number>, "P3": <number>, "P4": <number>, "P5": <number>, "P6": <number>, "P7": <number> },
    "notes": "<1-2 sentences on the verdict reasoning>"
  },
  "execution": {
    "duration_to_thesis": <0..1 or null>,
    "mfe_capture": <0..1 or null>,
    "mae_heat": <0..1 or null>,
    "prep_adherence": <0..1 or null>,
    "planned_vs_realized_rr": <0..1 or null>,
    "composite": <0..1 or null>,
    "compliant_trade_count": <number>,
    "notes": "<1-2 sentences diagnostic; never blends with process verdict>"
  }
}

Be direct. If the day was a Breach, say so plainly — don't soften it with "but the PnL was good." If the day was Compliant with poor execution, name that too — process compliance doesn't excuse sloppy execution. Magnitude doesn't matter for process; even a +$50 breach is still a breach.

LENGTH DISCIPLINE — the response must be valid JSON, so keep prose tight:
  • Per-rule reasons: 1 short sentence max (under 25 words). Cite specifics, don't argue.
  • process.notes + execution.notes: 1-2 sentences each.
  • what_worked / mistakes / patterns / next_session_focus bullets: 1 sentence each.
  • Do NOT wrap the JSON in markdown fences (no \`\`\`json). The whole response should start with { and end with }.` : `Respond with ONLY valid JSON in this exact structure (no markdown, no code fences):
{
  "summary": "<2-3 sentences on overall session quality>",
  "what_worked": ["<specific behaviour/decision that was a win>", "<up to 4 total>"],
  "mistakes": ["<recurring mistake or specific bad decision>", "<up to 5 total>"],
  "patterns": ["<setup/timing/management pattern across trades>", "<up to 4 total>"],
  "next_session_focus": ["<actionable focus item for tomorrow>", "<up to 3 total>"],
  "score": <integer 1-10>
}

Be direct. If the day was poor, say so.`}`

  const userContent: Anthropic.MessageParam['content'] = hasImage
    ? [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: normalizedMediaType!,
            data: imageBase64!,
          },
        },
        { type: 'text', text: prompt },
      ]
    : prompt

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    // v1.3 prompt asks for per-rule reasoning (P1..P7) + execution metric notes
    // + the usual qualitative analysis — easily 1500+ tokens of structured
    // content. The old 2000 cap let well-reasoned responses get truncated mid-
    // string, breaking the JSON parser and dumping the raw text into `summary`.
    // 6000 gives headroom for a chatty rule justification on a complex session
    // while still being far below Sonnet's context budget.
    max_tokens: 6000,
    messages: [{ role: 'user', content: userContent }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : ''
  const fallback: EodAiAnalysis = {
    summary: text,
    what_worked: [],
    mistakes: [],
    patterns: [],
    next_session_focus: [],
    score: 0,
    analyzed_at: new Date().toISOString(),
  }

  try {
    // Strip a leading ```json fence if the model wrapped its response despite
    // the "no code fences" instruction — saves a needless fallback path.
    const stripped = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
    const jsonMatch = stripped.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.warn('[analyze-eod] no JSON braces found in model response (likely truncated). length=', text.length)
      return NextResponse.json(fallback)
    }
    const parsed = JSON.parse(jsonMatch[0]) as EodAiAnalysis
    return NextResponse.json({ ...parsed, analyzed_at: new Date().toISOString() })
  } catch (e) {
    console.warn('[analyze-eod] JSON parse failed (likely mid-string truncation). length=', text.length, 'err=', e instanceof Error ? e.message : e)
    return NextResponse.json(fallback)
  }
}
