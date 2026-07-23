import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { consumeAiUsage } from '@/lib/ai-usage'
import { createClient } from '@/lib/supabase/server'
import type { PrepNotes, AiAnalysis, Trade, MarketContext } from '@/lib/supabase/types'
import { normalizeAnthropicMediaType } from '@/lib/anthropic-image'
import { buildEodPrompt, parseEodResponse, applyDeterministicOverrides } from '@/lib/eod-prompt'
import { resolveRails, type ScoringProfile } from '@/lib/scoring-profile'
import { getTraderProfile, profileContextBlock } from '@/lib/trader-profile'
import { behavioralProxiesPromptBlock } from '@/lib/behavioral-proxies'
import { fetchJournalEntries, journalLanguageHeatmapPromptBlock } from '@/lib/journal-language-heatmap'
import { fetchOpenThread, coachingThreadPromptBlock } from '@/lib/coaching-thread'
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

  // Prompt + parser live in src/lib/eod-prompt.ts so the batch-rescore
  // script (scripts/rescore-eod-stale.ts) can use exactly the same logic
  // without HTTP-calling this route (which would require auth cookies).
  // Coaching preferences (trader profile) are prepended so the AI respects
  // the trader's standing context — see /settings/coaching.
  const traderProfile = await getTraderProfile()

  // Journal language heatmap (Pt 3) — recurring words/phrases + emotional
  // language mined from the trader's OWN free text. A heatmap is about
  // RECURRENCE, so mine a trailing ~90-day window (not just today) and let the
  // EOD read react to language patterns (uplift on self-criticism landing on
  // good days; flag hedged reads that lose). Best-effort: any failure — or no
  // date anchor (no trades) — yields an empty block that adds no prompt weight.
  let journalBlock = ''
  try {
    const anchor = latestTradeDate(trades)
    if (anchor) {
      const sb = await createClient()
      const entries = await fetchJournalEntries(sb, { startDate: minusDays(anchor, 90), endDate: anchor })
      journalBlock = journalLanguageHeatmapPromptBlock(entries)
    }
  } catch (e) {
    console.warn('[analyze-eod] journal heatmap skipped:', e)
  }

  // Coaching thread (Pt 4) — the coach's prior directives + the trader's
  // commitments. EOD READS them as context so the day's analysis is aware of
  // what the trader is working on (it does NOT update thread status — that's
  // owned by the distiller). Best-effort: empty/no-op until the table exists.
  let coachingBlock = ''
  try {
    const sb = await createClient()
    coachingBlock = coachingThreadPromptBlock(await fetchOpenThread(sb))
    if (coachingBlock) coachingBlock = '\n\n' + coachingBlock + '\n'
  } catch (e) {
    console.warn('[analyze-eod] coaching thread skipped:', e)
  }

  const prompt = profileContextBlock(traderProfile)
    + behavioralProxiesPromptBlock(trades, sessionEndedAt)
    + journalBlock
    + coachingBlock
    + buildEodPrompt({ trades, eodNotes, prepNotes, prepAnalysis, marketContext, hasImage, scoringProfile, isLocalOwner: LOCAL_FEATURES_ENABLED })

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
  applyDeterministicOverrides(parsed, trades, msg => console.log(`[analyze-eod] ${msg}`), rc)

  return NextResponse.json(parsed)
}

/** PT (America/Los_Angeles) YYYY-MM-DD of the most recent fill — the window
 *  anchor for the trailing journal heatmap. null when no trade has an entry_time. */
function latestTradeDate(trades: Trade[]): string | null {
  let max: number | null = null
  for (const t of trades) {
    const et = t.entry_time ? Date.parse(t.entry_time) : NaN
    if (Number.isFinite(et)) max = max == null ? et : Math.max(max, et)
  }
  if (max == null) return null
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(max))
}

/** Subtract n days from a YYYY-MM-DD string (UTC-noon anchored to dodge DST). */
function minusDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}
