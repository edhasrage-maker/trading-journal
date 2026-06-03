import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  buildThemesPrompt,
  PROMPT_VERSION,
  type ThemesResponse,
  type EnrichedTheme,
  type NoteEntry,
  type ThemeRaw,
} from '@/lib/themes-prompt'

const client = new Anthropic()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const PAGE = 1000

interface ExtractBody {
  from: string         // YYYY-MM-DD inclusive
  to: string           // YYYY-MM-DD inclusive
  forceRefresh?: boolean
}

// What we read from trading_days for the corpus + correlation lookup.
interface DayForThemes {
  date: string
  eod_notes: string | null
  eod_pnl: number | null
  overall_grade: number | null
  process_score: number | null
}

/**
 * POST /api/extract-themes
 *   body: { from, to, forceRefresh? }
 *
 * Behavior:
 *   1. Cache check on (from_date, to_date, prompt_version). If a row exists
 *      and forceRefresh isn't set, return the cached themes immediately.
 *   2. Otherwise, fetch every trading_day in range with eod_notes populated,
 *      build the prompt corpus, call Claude.
 *   3. Enrich each returned theme with avg_grade / avg_pnl / avg_process_score
 *      computed from the dates of its excerpts.
 *   4. Cache the enriched result and return it.
 */
export async function POST(req: Request) {
  try {
    return await handle(req)
  } catch (e) {
    const err = e as { message?: string; status?: number; error?: { type?: string; message?: string } }
    const detail = err?.error?.message ?? err?.message ?? 'unknown server error'
    console.error('[extract-themes] failed:', err)
    return NextResponse.json(
      { error: detail, type: err?.error?.type, status: err?.status },
      { status: 500 },
    )
  }
}

async function handle(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY is not configured on the server.' },
      { status: 503 },
    )
  }

  const body = (await req.json()) as ExtractBody
  const { from, to, forceRefresh } = body
  if (!isValidDate(from) || !isValidDate(to)) {
    return NextResponse.json({ error: 'from and to must be YYYY-MM-DD strings' }, { status: 400 })
  }
  if (from > to) {
    return NextResponse.json({ error: 'from must be <= to' }, { status: 400 })
  }

  const supabase: AnyClient = await createClient()

  // ── 1. Cache check ────────────────────────────────────────────────────────
  if (!forceRefresh) {
    const { data: cached } = await supabase
      .from('eod_themes_analysis')
      .select('themes_json, notes_count, generated_at, model')
      .eq('from_date', from)
      .eq('to_date', to)
      .eq('prompt_version', PROMPT_VERSION)
      .maybeSingle() as { data: { themes_json: { themes: EnrichedTheme[] }; notes_count: number | null; generated_at: string; model: string } | null }
    if (cached) {
      return NextResponse.json({
        themes: cached.themes_json.themes,
        notes_count: cached.notes_count,
        generated_at: cached.generated_at,
        model: cached.model,
        cached: true,
      })
    }
  }

  // ── 2. Fetch trading days in range (paginated past Supabase's 1000-row cap) ──
  const days: DayForThemes[] = []
  for (let p = 0; p < 50; p++) {
    const { data, error } = await supabase
      .from('trading_days')
      .select('date, eod_notes, eod_pnl, overall_grade, process_score, id')
      .gte('date', from)
      .lte('date', to)
      .order('date', { ascending: true })
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1) as { data: (DayForThemes & { id: string })[] | null; error: { message: string } | null }
    if (error) {
      // If overall_grade or process_score columns don't exist, retry without them.
      // (The user may not have run all the recent migrations.)
      if (/column .* does not exist|could not find the .* column/i.test(error.message)) {
        return NextResponse.json(
          {
            error:
              'trading_days is missing overall_grade or process_score columns. ' +
              'Run the schema migration in Supabase, then retry.',
            detail: error.message,
          },
          { status: 503 },
        )
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    const batch = (data ?? []) as DayForThemes[]
    days.push(...batch)
    if (batch.length < PAGE) break
  }

  // Build the notes corpus: only days with non-trivial eod_notes contribute.
  const notes: NoteEntry[] = days
    .filter(d => d.eod_notes != null && d.eod_notes.trim().length >= 20)
    .map(d => ({ date: d.date, notes: d.eod_notes!.trim() }))

  if (notes.length === 0) {
    return NextResponse.json(
      {
        error: `No EOD notes with ≥20 characters in the range ${from} → ${to}.`,
        notes_count: 0,
      },
      { status: 400 },
    )
  }

  // ── 3. Call Claude ────────────────────────────────────────────────────────
  const prompt = buildThemesPrompt(notes)
  const totalChars = prompt.length
  const model = 'claude-sonnet-4-6'

  const message = await client.messages.create({
    model,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  })
  const text = message.content[0]?.type === 'text' ? message.content[0].text : ''

  let parsed: ThemesResponse
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON object found in Claude response')
    parsed = JSON.parse(jsonMatch[0]) as ThemesResponse
    if (!Array.isArray(parsed.themes)) throw new Error('themes is not an array')
  } catch (e) {
    console.error('[extract-themes] parse failed:', e, '\nraw text:', text.slice(0, 500))
    return NextResponse.json(
      {
        error: `Claude returned malformed output: ${e instanceof Error ? e.message : 'unknown'}`,
        rawSnippet: text.slice(0, 500),
      },
      { status: 500 },
    )
  }

  // ── 4. Enrich each theme with grade / PnL correlations ────────────────────
  // Pre-index the day rows by date for O(1) lookup.
  const dayByDate = new Map<string, DayForThemes>(days.map(d => [d.date, d]))

  const enriched: EnrichedTheme[] = parsed.themes.map((t: ThemeRaw) => {
    const dates = Array.from(new Set((t.excerpts ?? []).map(e => e.date).filter(Boolean)))
    let gradeSum = 0, gradeN = 0
    let pnlSum = 0, pnlN = 0
    let processSum = 0, processN = 0
    for (const d of dates) {
      const row = dayByDate.get(d)
      if (!row) continue
      if (row.overall_grade != null) { gradeSum += row.overall_grade; gradeN++ }
      if (row.eod_pnl != null) { pnlSum += row.eod_pnl; pnlN++ }
      if (row.process_score != null) { processSum += row.process_score; processN++ }
    }
    return {
      ...t,
      evidence_dates: dates,
      avg_grade: gradeN > 0 ? gradeSum / gradeN : null,
      avg_pnl: pnlN > 0 ? pnlSum / pnlN : null,
      avg_process_score: processN > 0 ? processSum / processN : null,
    }
  })

  // ── 5. Cache the result ────────────────────────────────────────────────────
  const themesJson = { themes: enriched }
  await supabase
    .from('eod_themes_analysis')
    .upsert(
      {
        from_date: from,
        to_date: to,
        prompt_version: PROMPT_VERSION,
        themes_json: themesJson,
        notes_count: notes.length,
        total_chars: totalChars,
        model,
        generated_at: new Date().toISOString(),
      },
      { onConflict: 'from_date,to_date,prompt_version' },
    )

  return NextResponse.json({
    themes: enriched,
    notes_count: notes.length,
    generated_at: new Date().toISOString(),
    model,
    cached: false,
  })
}

function isValidDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
}
