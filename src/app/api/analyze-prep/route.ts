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

The trader uses an MGI-based approach (Market Generated Information). Setups use structural levels (PDH, PDL, IBH, IBL, ONH, ONL, HTF supply/demand). Entry triggers are order-flow based in real time — do NOT penalize absent entry prices.
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

For plan_assessments: rate on structural clarity, invalidation precision, target reasonableness, risk awareness. Never penalize missing entry price.`

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
