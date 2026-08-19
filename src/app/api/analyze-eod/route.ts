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
import { computeSessionFacts } from '@/lib/session-facts'
import { computeTraderBaselines, baselinesPromptBlock, type DayConditions } from '@/lib/trader-baselines'
import { checkFactClaims, checkPraiseContradictions } from '@/lib/ai-constraints'
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

  // The trader's own historical baselines — how each tag / heat band has actually
  // performed across their book. Without these the analysis could only describe the
  // tags it was handed, which is exactly why it read as a recap of its own input.
  // Best-effort: no baselines simply means no baseline citations.
  let baselinesBlock = ''
  try {
    const sb = await createClient()
    const { data: book } = await sb
      .from('trades')
      .select('id, trading_day_id, pnl, entry_price, stop_price, tp1_price, exit_price, quantity, direction, symbol, tags_json, high_during_position, low_during_position')
      .not('stop_price', 'is', null)
      .order('entry_time', { ascending: false })
      .limit(400) as { data: Parameters<typeof computeTraderBaselines>[0] | null }
    if (book && book.length > 0) {
      // Day-level conditions for the same window, so the baselines can answer
      // "was today a market I do well in" — not just "how was the excursion".
      const dayIds = Array.from(new Set(book.map(t => t.trading_day_id).filter((v): v is string => !!v)))
      const conditions = new Map<string, DayConditions>()
      if (dayIds.length > 0) {
        const [dayRes, ctxRes] = await Promise.all([
          sb.from('trading_days').select('id, day_types').in('id', dayIds),
          sb.from('market_context').select('trading_day_id, rvol, adr, day_range, ib_regime').in('trading_day_id', dayIds),
        ])
        const ctxByDay = new Map(
          ((ctxRes.data ?? []) as Array<{ trading_day_id: string; rvol: number | null; adr: number | null; day_range: number | null; ib_regime: string | null }>)
            .map(c => [c.trading_day_id, c]),
        )
        for (const d of (dayRes.data ?? []) as Array<{ id: string; day_types: string[] | null }>) {
          const c = ctxByDay.get(d.id)
          conditions.set(d.id, {
            dayTypes: Array.isArray(d.day_types) ? d.day_types : [],
            rvol: c?.rvol ?? null,
            rangeUsedPct: c?.adr && c.day_range != null && c.adr > 0 ? (c.day_range / c.adr) * 100 : null,
            ibRegime: c?.ib_regime ?? null,
          })
        }
      }
      baselinesBlock = baselinesPromptBlock(computeTraderBaselines(book, conditions))
    }
  } catch (e) {
    console.warn('[analyze-eod] baselines skipped:', e instanceof Error ? e.message : 'unknown')
  }

  const prompt = profileContextBlock(traderProfile)
    + behavioralProxiesPromptBlock(trades, sessionEndedAt)
    + journalBlock
    + coachingBlock
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
  const parsed = parseEodResponse(text)

  // Apply all deterministic overrides (P1-P5 rules, verdict re-derive, profit
  // factor, MFE capture, MAE heat, composite). Shared with the batch rescore
  // script via applyDeterministicOverrides so the two can't drift.
  applyDeterministicOverrides(parsed, trades, msg => console.log(`[analyze-eod] ${msg}`), rc)

  // Trust-layer annotation (A9 + A10) — grade the model's NUMERIC claims
  // against the deterministic session facts, and its praise against the
  // trader's own mistake tags. Annotate-and-log only, NEVER block: a false
  // positive must not cost a session, so violations ride on the saved
  // analysis (fact_check) for the UI/audit and go to the server log.
  // The audit that motivated this found ~half the specific numbers in one
  // live analysis wrong — every field READ was right, every number
  // CALCULATED in prose was suspect. checkFactClaims is that comparison,
  // run on the raw model text so evidence quotes match what was written.
  try {
    const facts = computeSessionFacts(trades)
    const mistakesByTrade = trades.map(t => {
      const arr = (t.tags_json as { mistakes?: unknown } | null)?.mistakes
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
    })
    const violations = [
      ...checkFactClaims(text, facts),
      ...checkPraiseContradictions(parsed.what_worked, mistakesByTrade),
    ]
    if (violations.length > 0) {
      parsed.fact_check = { checked_at: new Date().toISOString(), violations }
      console.warn(
        `[analyze-eod] trust-layer: ${violations.length} violation(s) — ` +
        violations.map(v => `${v.id}: ${v.message}`).join(' | '),
      )
    }
  } catch (e) {
    console.warn('[analyze-eod] trust-layer check skipped:', e instanceof Error ? e.message : e)
  }

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
