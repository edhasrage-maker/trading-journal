/**
 * Batch-rescore EOD AI analyses that are stale under v1.4 (2026-06-08
 * amendment 3 — see docs/Ruleset_v1.3_Process_Execution_Spec.md).
 *
 * Stale = any of:
 *   - eod_ai_analysis_json is null/empty
 *   - eod_ai_analysis_json has only the legacy `score` field (pre-v1.3)
 *   - eod_ai_analysis_json.process.per_rule contains P6 or P7 (pre-amendment-3,
 *     7-rule structure)
 *   - eod_ai_analysis_json.execution.duration_to_thesis exists (pre-amendment-3,
 *     dropped sub-metric)
 *
 * For each stale day with trades, re-runs the same prompt the /api/analyze-eod
 * route uses (shared via src/lib/eod-prompt.ts) and writes the result back.
 *
 * Usage:
 *   node --experimental-strip-types scripts/rescore-eod-stale.ts --dry-run
 *   node --experimental-strip-types scripts/rescore-eod-stale.ts --limit 5
 *   node --experimental-strip-types scripts/rescore-eod-stale.ts --date 2026-06-08
 *   node --experimental-strip-types scripts/rescore-eod-stale.ts          # all stale, no cap
 *
 * Flags:
 *   --dry-run            : list which days WOULD be rescored, don't call AI or write
 *   --limit N            : process at most N days (useful for testing)
 *   --date YYYY-MM-DD    : rescore one specific day (overrides staleness check)
 *   --pause-ms N         : sleep N ms between Anthropic calls (default 1500)
 */

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
// Explicit .ts extensions — Node's --experimental-strip-types in ESM mode
// requires them; tsconfig path resolution doesn't apply here.
import { buildEodPrompt, parseEodResponse } from '../src/lib/eod-prompt.ts'
import type { Trade, PrepNotes, AiAnalysis, MarketContext, EodAiAnalysis, TradingDay } from '../src/lib/supabase/types.ts'

// ─── env + clients ───────────────────────────────────────────────────────────

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY not in env — did .env.local load?')
  process.exit(1)
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not in env — required for the AI re-analysis.')
  process.exit(1)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)
const anthropic = new Anthropic()

// ─── args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const limitArg = argv.find(a => a.startsWith('--limit='))
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity
const dateArg = argv.find(a => a.startsWith('--date='))
const targetDate = dateArg ? dateArg.split('=')[1] : null
const pauseArg = argv.find(a => a.startsWith('--pause-ms='))
const pauseMs = pauseArg ? parseInt(pauseArg.split('=')[1], 10) : 1500

// ─── staleness check ─────────────────────────────────────────────────────────

interface StaleDay {
  id: string
  date: string
  reason: string
}

function isStale(eod: EodAiAnalysis | null | undefined): { stale: boolean; reason: string } {
  if (!eod || Object.keys(eod).length === 0) {
    return { stale: true, reason: 'no analysis yet' }
  }
  // Pre-v1.3: only `score`, no process/execution structure
  if (eod.score != null && !eod.process && !eod.execution) {
    return { stale: true, reason: 'legacy v0 (score only)' }
  }
  // Pre-amendment-3: has P6 or P7 keys
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const perRule = eod.process?.per_rule as Record<string, any> | undefined
  if (perRule && (perRule.P6 != null || perRule.P7 != null)) {
    return { stale: true, reason: 'pre-amendment-3 (P6/P7 present)' }
  }
  // Pre-amendment-3: has duration_to_thesis sub-metric
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const execAny = eod.execution as Record<string, any> | undefined
  if (execAny && execAny.duration_to_thesis !== undefined) {
    return { stale: true, reason: 'pre-amendment-3 (duration_to_thesis present)' }
  }
  return { stale: false, reason: '' }
}

async function findStaleDays(): Promise<StaleDay[]> {
  // Pull every trading_day that has ≥1 trade. We don't filter on the AI
  // field here because Postgres JSONB shape checks would be brittle — just
  // pull the field and check in JS.
  const { data: daysRaw, error } = await sb
    .from('trading_days')
    .select('id, date, eod_ai_analysis_json')
    .order('date', { ascending: false })
  if (error) throw new Error(`trading_days fetch: ${error.message}`)

  const days = (daysRaw ?? []) as Pick<TradingDay, 'id' | 'date' | 'eod_ai_analysis_json'>[]
  if (days.length === 0) return []

  // Count trades per day. Two gotchas:
  //   1. .in() with hundreds of UUIDs blows past PostgREST's URL length cap
  //      and silently returns nothing. Chunk to 50.
  //   2. Supabase default page cap is 1000 rows; chunked paginated reads
  //      bypass that. Same pattern as src/app/(app)/dashboard/page.tsx.
  const countByDay = new Map<string, number>()
  const ID_CHUNK = 50
  const PAGE = 1000
  for (let i = 0; i < days.length; i += ID_CHUNK) {
    const slice = days.slice(i, i + ID_CHUNK).map(d => d.id)
    for (let p = 0; p < 50; p++) {
      const { data, error } = await sb
        .from('trades')
        .select('trading_day_id')
        .in('trading_day_id', slice)
        .range(p * PAGE, p * PAGE + PAGE - 1)
      if (error) throw new Error(`trades count: ${error.message}`)
      const rows = (data ?? []) as { trading_day_id: string }[]
      for (const t of rows) {
        countByDay.set(t.trading_day_id, (countByDay.get(t.trading_day_id) ?? 0) + 1)
      }
      if (rows.length < PAGE) break
    }
  }

  const stale: StaleDay[] = []
  for (const d of days) {
    if ((countByDay.get(d.id) ?? 0) === 0) continue
    if (targetDate && d.date !== targetDate) continue
    const check = isStale(d.eod_ai_analysis_json as EodAiAnalysis | null)
    if (!check.stale && !targetDate) continue   // --date forces rescore
    stale.push({ id: d.id, date: d.date, reason: targetDate && !check.stale ? 'forced by --date' : check.reason })
  }
  return stale
}

// ─── per-day rescore ─────────────────────────────────────────────────────────

async function loadDayPayload(dayId: string): Promise<{
  trades: Trade[]
  prepNotes?: PrepNotes
  prepAnalysis?: AiAnalysis
  marketContext?: Partial<MarketContext>
  eodNotes?: string
} | null> {
  const { data: day, error: dayErr } = await sb
    .from('trading_days')
    .select('prep_notes_json, ai_analysis_json, eod_notes')
    .eq('id', dayId)
    .single()
  if (dayErr || !day) {
    console.error(`  day fetch failed: ${dayErr?.message}`)
    return null
  }

  const { data: trades } = await sb
    .from('trades')
    .select('*')
    .eq('trading_day_id', dayId)
    .order('entry_time', { ascending: true })

  const { data: ctx } = await sb
    .from('market_context')
    .select('*')
    .eq('trading_day_id', dayId)
    .maybeSingle()

  return {
    trades: (trades ?? []) as Trade[],
    prepNotes: (day.prep_notes_json ?? undefined) as PrepNotes | undefined,
    prepAnalysis: (day.ai_analysis_json ?? undefined) as AiAnalysis | undefined,
    marketContext: (ctx ?? undefined) as Partial<MarketContext> | undefined,
    eodNotes: day.eod_notes ?? undefined,
  }
}

async function rescoreOne(d: StaleDay): Promise<{ ok: boolean; verdict?: string; compositeOf?: string }> {
  const payload = await loadDayPayload(d.id)
  if (!payload) return { ok: false }
  if (payload.trades.length === 0) {
    console.log(`  ${d.date}: no trades after load, skipping`)
    return { ok: false }
  }

  // Build the prompt exactly the way the route does. hasImage=false because
  // we don't have access to the saved screenshot here (the chart-image flow
  // expects a base64 blob at call time, not from DB).
  const prompt = buildEodPrompt({
    trades: payload.trades,
    eodNotes: payload.eodNotes,
    prepNotes: payload.prepNotes,
    prepAnalysis: payload.prepAnalysis,
    marketContext: payload.marketContext,
    hasImage: false,
  })

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 6000,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : ''
  const parsed = parseEodResponse(text)

  const { error: upErr } = await sb
    .from('trading_days')
    .update({ eod_ai_analysis_json: parsed })
    .eq('id', d.id)
  if (upErr) {
    console.error(`  write failed: ${upErr.message}`)
    return { ok: false }
  }

  const verdict = parsed.process?.verdict ?? '—'
  const composite = parsed.execution?.composite
  const compositeOf = composite == null ? '—' : `${Math.round(composite * 100)}%`
  return { ok: true, verdict, compositeOf }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Scanning trading_days for stale EOD analyses…')
  const stale = await findStaleDays()
  const planned = stale.slice(0, limit)
  console.log(`Found ${stale.length} stale day(s); will process ${planned.length}${limit < Infinity ? ` (limit=${limit})` : ''}${dryRun ? ' [dry-run]' : ''}.`)
  for (const d of planned) {
    console.log(`  • ${d.date}  (${d.reason})`)
  }

  if (dryRun) {
    console.log('\n[dry-run] no AI calls or DB writes performed.')
    return
  }

  console.log('')
  let ok = 0
  let failed = 0
  for (let i = 0; i < planned.length; i++) {
    const d = planned[i]
    process.stdout.write(`[${i + 1}/${planned.length}] rescoring ${d.date}… `)
    const start = Date.now()
    try {
      const r = await rescoreOne(d)
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      if (r.ok) {
        console.log(`✓ ${r.verdict} · exec ${r.compositeOf} · ${elapsed}s`)
        ok++
      } else {
        console.log(`✗ (see above) · ${elapsed}s`)
        failed++
      }
    } catch (e) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`✗ ${e instanceof Error ? e.message : String(e)} · ${elapsed}s`)
      failed++
    }
    // Rate-limit pause between calls. Anthropic's per-minute caps are usually
    // generous but we're not in a hurry — be polite.
    if (i < planned.length - 1) await new Promise(r => setTimeout(r, pauseMs))
  }
  console.log(`\nDone. ${ok} succeeded, ${failed} failed.`)
}

main().catch(e => { console.error(e); process.exit(1) })
