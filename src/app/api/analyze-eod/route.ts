import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { consumeAiUsage } from '@/lib/ai-usage'
import { createClient } from '@/lib/supabase/server'
import type { PrepNotes, AiAnalysis, Trade, MarketContext } from '@/lib/supabase/types'
import { normalizeAnthropicMediaType } from '@/lib/anthropic-image'
import { buildEodPrompt } from '@/lib/eod-prompt'
import { resolveRails, type ScoringProfile } from '@/lib/scoring-profile'
import { getTraderProfile } from '@/lib/trader-profile'
import { buildEodContext, finalizeEodAnalysis } from '@/lib/eod-context'
import { clientError } from '@/lib/api-error'

const client = new Anthropic()

interface AnalyzeEodBody {
  trades: Trade[]
  eodNotes?: string
  prepNotes?: PrepNotes
  prepAnalysis?: AiAnalysis
  marketContext?: Partial<MarketContext>
  imageBase64?: string | null
  imageMediaType?: string | null
  /** trading_days.session_ended_at — feeds the "re-opened after ending" flag
   *  (Pt 13 step 3). Null/absent when the session wasn't manually ended. */
  sessionEndedAt?: string | null
}

export async function POST(req: Request) {
  try {
    return await handle(req)
  } catch (e) {
    const err = e as { message?: string; status?: number; error?: { type?: string; message?: string } }
    const detail = err?.error?.message ?? err?.message ?? 'unknown server error'
    console.error('[analyze-eod] failed:', err)
    return NextResponse.json({ error: clientError(detail), type: err?.error?.type, status: err?.status }, { status: 500 })
  }
}

async function handle(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }, { status: 503 })
  }

  // Pt 2 — grade against the trader's OWN scoring_profile_json. On the LOCAL
  // (founder) build we skip the fetch entirely: an empty profile resolves to
  // the owner v1.3 rubric, so the founder's grading stays byte-identical AND we
  // don't query a column that doesn't exist on the personal DB.
  let scoringProfile: ScoringProfile = {}
  if (!LOCAL_FEATURES_ENABLED) {
    const supabase = await createClient()
    const gate = await consumeAiUsage(supabase, 'analyze_eod')
    if (!gate.allowed) return NextResponse.json({ error: gate.message, ...gate }, { status: 429 })
    // scoring_profile_json is a cloud-only column absent from the generated
    // types (and from the personal DB) — cast to reach it, mirroring
    // coach-score/route.ts. Missing column → error, data null → {} → owner path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: profRow } = await (supabase as any)
      .from('trader_profile').select('scoring_profile_json').eq('id', 'default').maybeSingle()
    if (profRow?.scoring_profile_json && typeof profRow.scoring_profile_json === 'object') {
      scoringProfile = profRow.scoring_profile_json as ScoringProfile
    }
  }
  // Empty-profile fallback is founder-vs-public aware: local build → owner v1.3
  // rails (byte-identical); public + empty → UNTRACKED_RAILS (nothing graded until
  // the tester onboards). Same flag drives buildEodPrompt's block selection below.
  const rc = resolveRails(scoringProfile, LOCAL_FEATURES_ENABLED)

  const body = (await req.json()) as AnalyzeEodBody
  const { trades, eodNotes, prepNotes, prepAnalysis, marketContext, imageBase64, imageMediaType, sessionEndedAt } = body
  const normalizedMediaType = imageBase64 ? normalizeAnthropicMediaType(imageMediaType) : null
  const hasImage = !!imageBase64 && normalizedMediaType != null
  if (imageBase64 && !hasImage) {
    console.warn('[analyze-eod] dropping image — unsupported media type:', imageMediaType)
  }

  // Context (trader profile, behavioural signals, journal language, coaching
  // thread, baselines) and the post-processing both live in
  // src/lib/eod-context.ts, shared with scripts/reanalyze-eod-days.ts so a batch
  // re-analysis builds the identical prompt this route does.
  const traderProfile = await getTraderProfile()
  const sb = await createClient()
  const { head, baselinesBlock } = await buildEodContext(sb, { trades, sessionEndedAt, traderProfile })
  const prompt = head
    + buildEodPrompt({ trades, eodNotes, prepNotes, prepAnalysis, marketContext, hasImage, scoringProfile, isLocalOwner: LOCAL_FEATURES_ENABLED, baselinesBlock })

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
  const parsed = finalizeEodAnalysis(text, trades, rc, msg => console.log(`[analyze-eod] ${msg}`))

  return NextResponse.json(parsed)
}
