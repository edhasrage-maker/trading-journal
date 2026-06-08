import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import type { PrepNotes, AiAnalysis, Trade, MarketContext } from '@/lib/supabase/types'
import { normalizeAnthropicMediaType } from '@/lib/anthropic-image'
import { buildEodPrompt, parseEodResponse } from '@/lib/eod-prompt'

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
  return NextResponse.json(parsed)
}
