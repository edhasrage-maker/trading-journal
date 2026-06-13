import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import type { PrepNotes, AiAnalysis, Trade, MarketContext } from '@/lib/supabase/types'
import { normalizeAnthropicMediaType } from '@/lib/anthropic-image'
import { buildEodPrompt, parseEodResponse, computeRrDeterministic, computeMfeCaptureDeterministic, computeMaeHeatDeterministic, computeDeterministicRules, recomputeExecutionComposite } from '@/lib/eod-prompt'

const client = new Anthropic()

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

  // Prompt + parser live in src/lib/eod-prompt.ts so the batch-rescore
  // script (scripts/rescore-eod-stale.ts) can use exactly the same logic
  // without HTTP-calling this route (which would require auth cookies).
  const prompt = buildEodPrompt({ trades, eodNotes, prepNotes, prepAnalysis, marketContext, hasImage })

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
    // v1.3 prompt asks for per-rule reasoning + execution metric notes + the
    // usual qualitative analysis — easily 1500+ tokens of structured content.
    // The old 2000 cap let well-reasoned responses get truncated mid-string,
    // breaking the JSON parser and dumping the raw text into `summary`.
    max_tokens: 6000,
    messages: [{ role: 'user', content: userContent }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : ''
  const parsed = parseEodResponse(text)

  // Deterministic overrides for the four mechanical P-rules (P1, P3, P4, P5).
  // P2 stays AI-driven because its size cap is setup-conditional (≤10 only on
  // Qualifying S&D — needs setup-tag judgment). The AI has been observed to
  // return internally inconsistent rule blocks — e.g. P4.status="pass" while
  // P4.reason narrates a breach AND breach_count_vector.P4=1. The verdict is
  // re-derived from the resulting pass_count so it stays in lockstep with
  // the per_rule statuses.
  if (parsed.process) {
    const det = computeDeterministicRules(trades)
    let touchedProcess = false
    const ruleKeys: Array<'P1' | 'P3' | 'P4' | 'P5'> = ['P1', 'P3', 'P4', 'P5']
    for (const k of ruleKeys) {
      const ai = parsed.process.per_rule[k]
      const calc = det[k]
      const aiBc = ai?.breach_count ?? 0
      if (!ai || ai.status !== calc.status || aiBc !== calc.breach_count) {
        console.log(`[analyze-eod] overriding ${k} ${ai?.status ?? 'undef'}/${aiBc} → ${calc.status}/${calc.breach_count}`)
        parsed.process.per_rule[k] = { status: calc.status, breach_count: calc.breach_count, reason: calc.reason }
        if (parsed.process.breach_count_vector) parsed.process.breach_count_vector[k] = calc.breach_count
        touchedProcess = true
      }
    }
    if (touchedProcess) {
      // Re-derive verdict from pass_count (v1.4 amendment 3: ≥4/5 = Compliant).
      const passCount = Object.values(parsed.process.per_rule).filter(r => r?.status === 'pass').length
      const newVerdict: 'Compliant' | 'Breach' = passCount >= 4 ? 'Compliant' : 'Breach'
      if (parsed.process.verdict !== newVerdict) {
        console.log(`[analyze-eod] verdict re-derived ${parsed.process.verdict} → ${newVerdict} (pass_count ${passCount}/5)`)
        parsed.process.verdict = newVerdict
      }
    }
  }

  // Deterministic overrides for the pure-arithmetic execution sub-metrics.
  // The model has been observed to misread its own per-trade block (claims
  // a trade has no TP1 when the value is literally in the prompt) and to
  // return numbers that don't match ANY formula over the actual data —
  // essentially hallucinating "reasonable-sounding" values. For metrics
  // that have a single canonical formula (RR, MFE Capture, MAE Heat), we
  // compute ourselves and override either a null AI value OR an AI value
  // that disagrees with ours by more than 0.05. Composite is recomputed
  // from the resulting sub-metrics. The qualitative metrics that DO need
  // model judgment (execution_parameters, prep_adherence, notes) are left
  // untouched.
  if (parsed.execution) {
    let touched = false
    const overrideIfDifferent = (
      label: string,
      aiVal: number | null,
      calcVal: number | null,
      apply: (v: number) => void,
      eligibleCount: number,
    ) => {
      if (calcVal == null) return
      if (aiVal != null && Math.abs(aiVal - calcVal) <= 0.05) return
      console.log(`[analyze-eod] overriding ${label} ${aiVal} → ${calcVal.toFixed(3)} (${eligibleCount} eligible)`)
      apply(calcVal)
      touched = true
    }

    const rr = computeRrDeterministic(trades)
    overrideIfDifferent('RR', parsed.execution.planned_vs_realized_rr, rr.value,
      v => { parsed.execution!.planned_vs_realized_rr = v }, rr.eligibleCount)

    const mfe = computeMfeCaptureDeterministic(trades)
    overrideIfDifferent('mfe_capture', parsed.execution.mfe_capture, mfe.value,
      v => { parsed.execution!.mfe_capture = v }, mfe.eligibleCount)

    const mae = computeMaeHeatDeterministic(trades)
    overrideIfDifferent('mae_heat', parsed.execution.mae_heat, mae.value,
      v => { parsed.execution!.mae_heat = v }, mae.eligibleCount)

    if (touched) {
      const recomputed = recomputeExecutionComposite(parsed.execution)
      if (recomputed != null) parsed.execution.composite = recomputed
    }
  }

  return NextResponse.json(parsed)
}
