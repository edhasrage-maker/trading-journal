import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { consumeAiUsage } from '@/lib/ai-usage'
import { resolveAiModel } from '@/lib/ai-model'
import { createClient } from '@/lib/supabase/server'
import { resilientUpsert } from '@/lib/resilient-upsert'
import { userConflict } from '@/lib/tenant-conflict'
import { getTraderProfile, profileContextBlock } from '@/lib/trader-profile'
import { clientError } from '@/lib/api-error'
import type { AiAnalysis, TradingDay } from '@/lib/supabase/types'

/**
 * POST /api/prep/watch — Highlights' one-line Watch for the morning.
 *
 * The full morning read (/api/analyze-prep) grades a written prep plan with two
 * Opus calls and a chart image, ~$0.10 a run. Highlights only ever shows one
 * line of it, so this is the small version: today's news, the market read the
 * Prep hero already shows, and the trader's bias / mood / note, text only, one
 * sentence back (~2K tokens in, ~150 out).
 *
 * Once a day: the line is stored on the day (ai_analysis_json.watch), and a
 * request without `force` returns the stored one without calling the model, so
 * Prep can ask for it every time it opens. `force` is the "Run again" button.
 * Hosted build: counted against the `prep_watch` daily cap; the demo account
 * never reaches here (src/proxy.ts rejects its non-GET requests).
 */

const client = new Anthropic()

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

interface WatchBody {
  date: string
  force?: boolean
  symbol?: string | null
  /** The Prep hero's read, as the trader sees it. Null before any bars print. */
  read?: { headline?: string | null; sentence?: string | null; conditions?: { label: string; verdict: string }[] } | null
  news?: { timePt: string | null; title: string; country?: string }[]
  bias?: string | null
  mood?: string | null
  note?: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export async function POST(req: Request) {
  try {
    return await handle(req)
  } catch (e) {
    const err = e as { message?: string; status?: number; error?: { message?: string } }
    console.error('[prep/watch] failed:', err)
    return NextResponse.json({ error: clientError(err?.error?.message ?? err?.message ?? 'unknown server error') }, { status: 500 })
  }
}

async function handle(req: Request) {
  const body = await req.json() as WatchBody
  if (!body?.date || !DATE_RE.test(body.date)) {
    return NextResponse.json({ error: 'date=YYYY-MM-DD required' }, { status: 400 })
  }

  const supabase: AnyClient = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user && !LOCAL_FEATURES_ENABLED) return NextResponse.json({ error: 'not signed in' }, { status: 401 })

  const { data: day } = await supabase
    .from('trading_days')
    .select('ai_analysis_json')
    .eq('date', body.date)
    .maybeSingle() as { data: Pick<TradingDay, 'ai_analysis_json'> | null }
  const stored = (day?.ai_analysis_json ?? null) as AiAnalysis | null

  // Already have today's line → hand it back, no model call, nothing counted.
  if (!body.force && stored?.watch) {
    return NextResponse.json({ watch: stored.watch, watch_at: stored.watch_at ?? null, stored: true })
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }, { status: 503 })
  }
  if (!LOCAL_FEATURES_ENABLED) {
    const gate = await consumeAiUsage(supabase, 'prep_watch')
    if (!gate.allowed) return NextResponse.json({ error: gate.message, ...gate }, { status: 429 })
  }

  const ptNow = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit',
  }).format(new Date())

  const read = body.read
  const readBlock = read?.headline
    ? [
        `Headline: ${read.headline}`,
        read.sentence ? `Detail: ${read.sentence}` : null,
        ...(read.conditions ?? []).map(c => `- ${c.label}: ${c.verdict}`),
      ].filter(Boolean).join('\n')
    : 'No market read yet — the session has not printed.'
  const news = (body.news ?? []).filter(n => n?.title)
  const newsBlock = news.length
    ? news.map(n => `- ${n.timePt ?? 'All day'} PT: ${n.title}${n.country ? ` (${n.country})` : ''}`).join('\n')
    : 'No high-impact news today.'

  const traderProfile = await getTraderProfile()
  const prompt = profileContextBlock(traderProfile) + `You write the one "Watch" line on a futures day trader's morning prep page. It is ${ptNow} PT on ${body.date}${body.symbol ? `, trading ${body.symbol}` : ''}.

High-impact news today:
${newsBlock}

Market read (computed from the 1-minute bars):
${readBlock}

The trader's own read:
- Bias: ${body.bias || 'not set'}
- Mood: ${body.mood || 'not set'}
- Note: ${body.note?.trim() || 'none'}

Write the single most useful thing for this trader to watch today, as one plain-English sentence of at most 25 words. Lead with the news if there is any still ahead of ${ptNow} PT, and give its time. Otherwise use the market read. No jargon or abbreviations (no RVOL, ATR, ADR, IB, VWAP), no price levels, and no prediction of direction.

Respond with ONLY valid JSON: {"watch": "<the sentence>"}`

  const model = await resolveAiModel(supabase, user)
  const message = await client.messages.create({
    model,
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  })
  const text = message.content.find(b => b.type === 'text')?.text ?? ''
  let watch: string | null = null
  try {
    const m = text.match(/\{[\s\S]*\}/)
    const parsed = m ? JSON.parse(m[0]) as { watch?: unknown } : null
    if (typeof parsed?.watch === 'string' && parsed.watch.trim()) watch = parsed.watch.trim()
  } catch { /* fall through to the plain-text fallback */ }
  if (!watch && text.trim() && !text.includes('{')) watch = text.trim()
  if (!watch) return NextResponse.json({ error: 'The Watch line came back empty. Try again.' }, { status: 502 })

  const watch_at = new Date().toISOString()
  // Merge onto whatever the day already holds (a full read, plan assessments)
  // so writing the Watch never drops them.
  const { error } = await resilientUpsert(
    supabase,
    'trading_days',
    { date: body.date, ai_analysis_json: { ...(stored ?? {}), watch, watch_at }, updated_at: watch_at },
    { onConflict: userConflict('date') },
  )
  if (error) console.warn('[prep/watch] could not store the Watch line:', error)

  return NextResponse.json({ watch, watch_at, stored: false })
}
