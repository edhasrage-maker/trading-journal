import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { consumeAiUsage } from '@/lib/ai-usage'
import { createClient } from '@/lib/supabase/server'
import type { PrepNotes, AiAnalysis, Trade, MarketContext } from '@/lib/supabase/types'
import { normalizeAnthropicMediaType } from '@/lib/anthropic-image'
import { buildEodPrompt, parseEodResponse, applyDeterministicOverrides } from '@/lib/eod-prompt'
import { getTraderProfile, profileContextBlock } from '@/lib/trader-profile'

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

  if (!LOCAL_FEATURES_ENABLED) {
    const supabase = await createClient()
    const gate = await consumeAiUsage(supabase, 'analyze_eod')
    if (!gate.allowed) return NextResponse.json({ error: gate.message, ...gate }, { status: 429 })
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
  // Coaching preferences (trader profile) are prepended so the AI respects
  // the trader's standing context — see /settings/coaching.
  const traderProfile = await getTraderProfile()
  const prompt = profileContextBlock(traderProfile)
    + buildEodPrompt({ trades, eodNotes, prepNotes, prepAnalysis, marketContext, hasImage })

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

  // Apply all deterministic overrides (P1-P5 rules, verdict re-derive, profit
  // factor, MFE capture, MAE heat, composite). Shared with the batch rescore
  // script via applyDeterministicOverrides so the two can't drift.
  applyDeterministicOverrides(parsed, trades, msg => console.log(`[analyze-eod] ${msg}`))

  return NextResponse.json(parsed)
}
