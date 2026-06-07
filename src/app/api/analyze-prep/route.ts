import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import type { PrepNotes } from '@/lib/supabase/types'
import { normalizeAnthropicMediaType } from '@/lib/anthropic-image'

const client = new Anthropic()

export async function POST(req: Request) {
  try {
    return await handle(req)
  } catch (e) {
    const err = e as { message?: string; status?: number; error?: { type?: string; message?: string } }
    const detail =
      err?.error?.message ??
      err?.message ??
      'unknown server error'
    console.error('[analyze-prep] failed:', err)
    return NextResponse.json(
      { error: detail, type: err?.error?.type, status: err?.status },
      { status: 500 },
    )
  }
}

async function handle(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY is not configured on the server. Add it to .env.local and restart the dev server.' },
      { status: 503 },
    )
  }

  const { prepNotes, marketContext, imageBase64, imageMediaType } = await req.json() as {
    prepNotes: PrepNotes
    marketContext: Record<string, number | null>
    imageBase64?: string | null
    imageMediaType?: string | null
  }

  // Normalise the image media type. If it's missing/unsupported, fall back to
  // text-only analysis rather than 400ing — better UX than a hard fail.
  const normalizedMediaType = imageBase64 ? normalizeAnthropicMediaType(imageMediaType) : null
  const hasImage = !!imageBase64 && normalizedMediaType != null
  if (imageBase64 && !hasImage) {
    console.warn('[analyze-prep] dropping image — unsupported media type:', imageMediaType)
  }

  const plans = prepNotes.trade_plans ?? []
  const plansBlock = plans.length > 0
    ? plans.map((p, i) => `
  Plan ${i + 1}: ${p.direction.toUpperCase()} — ${p.setup_name || 'Unnamed'}
    Trader Quality Rating: ${p.quality}/5
    Reasons: ${p.quality_reasons.filter(Boolean).join('; ') || 'None provided'}
    Invalidation: ${p.invalidation || 'Not provided'}
    Targets: ${p.targets || 'Not provided'}
    Scary Factors: ${p.scary_factors || 'Not provided'}`).join('\n')
    : '  None provided'

  const planIdsBlock = plans.length > 0
    ? `Plan IDs for plan_assessments: ${plans.map((p, i) => `Plan ${i + 1} id="${p.id}"`).join(', ')}`
    : ''

  const chartInstructions = hasImage ? `
═══════════════════════════════════════════════
STEP 1 — INDEPENDENT CHART READ (image only)
═══════════════════════════════════════════════
Look ONLY at the chart image. Do NOT reference the trader's notes below when completing this step.
Identify independently:
- Overall structure: is price trending (HH/HL or LH/LL), rotating, or choppy?
- Volume profile shape and where the bulk of volume is built
- Key visible levels price is reacting to (label them by price if readable)
- VWAP and EMA positions and slopes relative to price
- Any visible order flow signals: absorption, rejection, imbalance, failed auction
- What the market appears to be doing and where it likely wants to go next

Write your findings in "chart_thesis" (2-3 sentences, your independent read) and "chart_structure_notes" (up to 4 specific bullet observations — e.g. "Price broke above IBH at 28134 and immediately reversed, forming a failed auction" or "Volume profile is P-shaped with POC in upper quarter and no development below ONL").

IMPORTANT: chart_thesis and chart_structure_notes must reflect ONLY what you see in the image — not what the trader wrote. A reader should be able to tell these came from the chart, not from the form.

═══════════════════════════════════════════════
STEP 2 — PREP NOTES EVALUATION (text + chart)
═══════════════════════════════════════════════
Now read the trader's notes below and evaluate their prep quality. Cross-reference your Step 1 chart read against what the trader wrote. Note any alignment or conflict in "summary".` : ''

  const prompt = `You are an objective trading coach reviewing a trader's daily prep${hasImage ? ' and chart screenshot' : ''}.

══ TRADER'S FRAMEWORK (read this before judging anything) ══

The trader uses an MGI-based approach (Market Generated Information). Setups use structural levels (PDH, PDL, IBH, IBL, ONH, ONL, HTF supply/demand). Entry triggers are order-flow based in real time — do NOT penalize absent entry prices.

CRITICAL framing rules — get these wrong and your analysis will be unhelpful:

1. **IBH/IBL are levels, not directions.** When the trader plans LONG from demand at the lows (e.g. ONL bounce, 5m demand zone), IBH is the upside TARGET, not a "lid" or "resistance preventing the trade from working." A clean R/R to IBH is the WHOLE POINT of the setup. Only call IBH a problem when the trader plans to go LONG from JUST BELOW IBH on a continuation — that's the scenario where IBH overhead is structurally meaningful resistance. Do not flag "IBH overhead" when longs are from a level well below it.

2. **Chop is an environment, not a verdict.** "L3 CHOP" or a low-clarity read does NOT contradict laying out trade plans. Plans are CONDITIONAL — they trigger when the level reacts. In chop the trader knows to size down, wait for confluence, scratch faster. Plans laid out + chop environment = mature prep, not contradiction. Only flag chop when the plans show NO awareness of it (e.g. full size, no scaling, no invalidation).

3. **"Scary factors" field on a plan is a STRENGTH.** It's the trader proactively naming the failure scenario before they take the trade — exactly the discipline you should reward. Don't list "scary factor X is a real risk" as a flag — the trader already flagged it themselves.

4. **Emotional self-reporting + reduced-size commitment = strength, not flag.** When the trader writes "feeling tilted from yesterday, will trade smaller," that's the self-awareness most traders lack. Don't flag it as "easy to break the rule under pressure" — that's a truism that applies to every trader. Only flag if the mood note describes an emotion AND the plans show no behavioural adjustment.

5. **Day-type context shapes everything.** If GBX is ≥ 80% of ADR with reversal structure, IBH-as-resistance is the WRONG frame — the day's character is rotation/reversal, not trend continuation. Match your analysis to what's actually unfolding.

6. **Dynamic levels (EMA, VWAP) and ratio targets (R-multiples) are PROPERTIES OF THE TRIGGER MOMENT, not prep-time prices.** The trader uses order-flow entries: the entry price is whatever the tape gives them when the level reacts, not a number they can write down at 6 AM.
   - **EMA / VWAP invalidations are correct AS-IS.** "5m close above the 20 EMA" is structurally complete — the EMA's job is to be dynamic. Asking "what price is the EMA at?" defeats the purpose. Do NOT flag this. The same applies to VWAP, prior-day VWAP, anchored VWAPs, any moving session-level line.
   - **"2R" or "1R to X" is fully specified.** R is defined by the entry-to-stop distance, which is set at the trigger moment. Asking for "the 2R price level" during prep is a category error — it cannot exist before entry. Do NOT flag this.
   - Static price targets (IBH at 30134, PWL at 29769) are fine to praise for precision, but their absence is NOT a flag when a ratio or dynamic level was given instead.
   - The ONLY time to flag a target/invalidation is when it is genuinely vague — e.g. "exit on weakness", "stop if it goes wrong", "target the highs" without specifying which highs. Those are real omissions. Ratios and dynamic levels are not.

${chartInstructions}

Market Context:
- Rvol: ${marketContext.rvol ?? 'N/A'}
- IB Size: ${marketContext.ib_size ?? 'N/A'} (vs 10d avg ratio: ${marketContext.ib_vs_10d_avg ?? 'N/A'})
- ADR: ${marketContext.adr ?? 'N/A'} | ATR (1m): ${marketContext.atr_1m ?? 'N/A'}
- PDH/PDL: ${marketContext.pdh ?? 'N/A'} / ${marketContext.pdl ?? 'N/A'}
- IBH/IBL: ${marketContext.ibh ?? 'N/A'} / ${marketContext.ibl ?? 'N/A'}
- ONH/ONL: ${marketContext.onh ?? 'N/A'} / ${marketContext.onl ?? 'N/A'}

Trader's Prep Notes:
- IB Break Timing: ${prepNotes.ib_behaviour ?? 'Not provided'}
- Volume Profile: ${prepNotes.volume_profile_shape ?? 'Not provided'} — ${prepNotes.volume_profile_notes ?? ''}
- Bias: ${prepNotes.bias ?? 'Not provided'} — ${prepNotes.bias_notes ?? ''}
- HTF MGI: ${prepNotes.htf_mgi ? Object.entries(prepNotes.htf_mgi).map(([k, v]) => `${k} ${v}`).join(', ') : 'None tagged'}
- VWAP: ${prepNotes.htf_mgi?.['VWAP'] ? `price ${prepNotes.htf_mgi['VWAP']} VWAP` : 'not tagged'}${prepNotes.vwap_slope ? `, ${prepNotes.vwap_slope}` : ''}
- EMA: ${prepNotes.htf_mgi?.['EMA'] ? `price ${prepNotes.htf_mgi['EMA']} EMA` : 'not tagged'}${prepNotes.ema_slope ? `, ${prepNotes.ema_slope}` : ''}
- Mood: ${prepNotes.mood ?? 'Not provided'}
- Market Clarity: ${prepNotes.market_clarity ?? 'Not provided'}

Trade Plans:
${plansBlock}

${planIdsBlock}

Respond with ONLY valid JSON in this exact structure (no markdown, no code fences):
{${hasImage ? `
  "chart_thesis": "<REQUIRED — your own 2-3 sentence read of market structure and direction from the chart image alone, written as if you had not seen the trader's notes>",
  "chart_structure_notes": ["<specific visual observation from the chart — cite prices or patterns you actually see>", "<observation 2>", "<up to 4 total>"],` : ''}
  "summary": "<2-3 sentences on overall prep quality${hasImage ? '; state whether your chart read aligns or conflicts with the trader bias' : ''}>",
  "flags": ["<specific concern 1>", "<up to 5 total>"],
  "strengths": ["<what was done well>", "<up to 3 total>"],
  "score": <integer 1-10>,
  "plan_assessments": [{"plan_id": "<exact id>", "ai_quality": <1-5>, "note": "<1-2 sentences, be direct if you disagree with trader rating>"}]
}

For plan_assessments: rate on structural clarity, invalidation precision, target reasonableness, risk awareness. Never penalize missing entry price.

══ SCORING RUBRIC FOR "score" ══

This is the overall PREP QUALITY score, not a market-conditions score. Don't penalize the trader for unclear market structure — that's the market's job, not the prep's. Use these anchors:

- **9-10**: All plans have specific invalidation + targets + named scary factors. Bias is justified by structural context (not gut). Mood + clarity addressed honestly. Multiple plans covering both directions when warranted. HTF MGI tagged. Volume profile shape called out.
- **7-8**: Plans have invalidation + targets. Scary factors named on at least one plan. Bias reasoning present. Mood mentioned. Some structural depth but maybe one plan thinner than another.
- **5-6**: Plans exist but some lack invalidation OR targets OR scary factors. Bias stated without much reasoning. Or thorough plans but no mood/clarity self-check.
- **3-4**: Plans are vague — "watch IBH" without specifics. No invalidation. Bias asserted with no structural anchor.
- **1-2**: Effectively no prep — directional bias with no plan, no levels, no risk awareness.

DO NOT downgrade for:
- Market being choppy / uncertain (that's environment)
- The trader being long below IBH (that's a normal R/R to a level)
- Self-reported tilt + reduced-size commitment (that's self-awareness)
- Named scary factors (those are the trader catching their own risk)
- Plans being "lower probability" — probability is a market call, not a prep grade
- Dynamic-level invalidations like "5m close above the 20 EMA" or "VWAP reclaim" (the level moving is the feature, not a bug)
- Ratio targets like "2R" or "1R to IBL" (R is defined by the trigger-moment entry-to-stop, not by prep)
- Missing entry prices (entries are order-flow-triggered, not predetermined)

DO downgrade for:
- Missing invalidation (no exit condition at all)
- Missing targets (no exit plan at all)
- Genuinely vague invalidation/targets ("exit on weakness", "target the highs" with no anchor)
- No mood/clarity self-check
- Bias asserted without structural reasoning
- Plans that contradict each other without acknowledgment

Cite the rubric tier in "summary" so the trader can sanity-check the score.`

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
    max_tokens: 2000,
    messages: [{ role: 'user', content: userContent }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : ''

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    const analysis = jsonMatch
      ? JSON.parse(jsonMatch[0])
      : { summary: text, flags: [], strengths: [], score: 0, plan_assessments: [] }
    return NextResponse.json({ ...analysis, analyzed_at: new Date().toISOString() })
  } catch {
    return NextResponse.json({ summary: text, flags: [], strengths: [], score: 0, plan_assessments: [], analyzed_at: new Date().toISOString() })
  }
}
