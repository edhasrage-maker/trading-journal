/**
 * Re-run the end-of-day analysis for specific days, through exactly the path
 * the "Analyze Session" button uses.
 *
 * Built after the GBX fix (450122a): every day with a "GBX Reversal" trade had
 * those RTH trades labelled overnight, which exempted them from prep adherence
 * and the ATR stop-band check. Their stored analyses are wrong and need to be
 * regenerated — not patched.
 *
 * Why not scripts/rescore-eod-stale.ts: it calls buildEodPrompt alone, so it
 * drops the trader profile, behavioural signals, journal language, coaching
 * thread and baselines, grades against default rails rather than the trader's
 * own, and skips the trust-layer check. A day re-run through it comes back
 * worse than the one it replaces. This script uses src/lib/eod-context.ts,
 * the same module the route now calls, so the prompt is built identically.
 *
 * Prod only. DB from .env.public-feed; ONLY the Anthropic key is read from
 * .env.local, so its Supabase vars can never point the write at the wrong DB.
 *
 *   npx tsx scripts/reanalyze-eod-days.ts                          # dry run — GBX-Reversal days, excluding today
 *   npx tsx scripts/reanalyze-eod-days.ts --apply                  # regenerate + write
 *   npx tsx scripts/reanalyze-eod-days.ts --dates=2026-06-04,2026-06-10 [--apply]
 *   npx tsx scripts/reanalyze-eod-days.ts --include-today [--apply]
 *
 * Every analysis being replaced is written to scripts/.repair-backups/ BEFORE
 * any write, so a regeneration you dislike can be put back.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { buildEodPrompt } from '../src/lib/eod-prompt'
import { buildEodContext, finalizeEodAnalysis } from '../src/lib/eod-context'
import { resolveRails, type ScoringProfile } from '../src/lib/scoring-profile'
import type { TraderProfile } from '../src/lib/trader-profile'
import type { Trade, PrepNotes, AiAnalysis, MarketContext } from '../src/lib/supabase/types'
import { todayPT } from '../src/lib/pt-time'

const argv = process.argv.slice(2)
const argVal = (n: string): string | null => argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? null
const APPLY = argv.includes('--apply')
const INCLUDE_TODAY = argv.includes('--include-today')
const OWNER_USER_ID = 'fa3fb352-9538-44cc-8ce1-1c76f307044c'
const USER_ID = argVal('user') ?? OWNER_USER_ID
const PAUSE_MS = 1500

function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
  return out
}
const feed = loadEnv('.env.public-feed')
const anthropicKey = loadEnv('.env.local').ANTHROPIC_API_KEY
if (!feed.PUBLIC_SUPABASE_URL || !feed.PUBLIC_SUPABASE_SERVICE_ROLE_KEY) throw new Error('prod Supabase creds missing from .env.public-feed')
if (APPLY && !anthropicKey) throw new Error('ANTHROPIC_API_KEY missing from .env.local')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const base: any = createClient(feed.PUBLIC_SUPABASE_URL, feed.PUBLIC_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// The context readers assume RLS. Service role bypasses it, so every read is
// pinned to one user here — otherwise the prompt would pull in other accounts'
// journals, coaching threads and trades.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scoped: any = {
  from: (table: string) => {
    const q = base.from(table)
    const select = q.select.bind(q)
    q.select = (...args: unknown[]) => select(...args).eq('user_id', USER_ID)
    return q
  },
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Days carrying at least one trade tagged with a GBX-containing day type other
 *  than the bare overnight tag — the days the substring bug mis-scored. */
async function gbxReversalDates(): Promise<string[]> {
  const dayIds = new Set<string>()
  for (let p = 0; p < 20; p++) {
    const { data } = await scoped.from('trades').select('trading_day_id, tags_json').range(p * 1000, p * 1000 + 999)
    if (!data?.length) break
    for (const t of data as Array<{ trading_day_id: string; tags_json: { day_type?: unknown } | null }>) {
      const d = t.tags_json?.day_type
      const arr = Array.isArray(d) ? d : d ? [d] : []
      if (arr.some(x => typeof x === 'string' && x.toUpperCase().includes('GBX') && x.trim().toUpperCase() !== 'GBX')) dayIds.add(t.trading_day_id)
    }
    if (data.length < 1000) break
  }
  if (dayIds.size === 0) return []
  const { data: days } = await scoped.from('trading_days').select('date').in('id', [...dayIds]).order('date')
  return (days ?? []).map((d: { date: string }) => d.date)
}

async function main() {
  const today = todayPT()
  const explicit = argVal('dates')?.split(',').map(s => s.trim()).filter(Boolean)
  let dates = explicit ?? await gbxReversalDates()
  if (!explicit && !INCLUDE_TODAY) dates = dates.filter(d => d !== today)

  const { data: prof } = await scoped.from('trader_profile').select('preferences_md, focus_md, updated_at, scoring_profile_json').maybeSingle()
  const traderProfile: TraderProfile = {
    preferences_md: prof?.preferences_md ?? '', focus_md: prof?.focus_md ?? '', updated_at: prof?.updated_at ?? null,
  }
  const scoringProfile = (prof?.scoring_profile_json && typeof prof.scoring_profile_json === 'object' ? prof.scoring_profile_json : {}) as ScoringProfile
  // The hosted build runs with local features OFF, so grade the way prod does.
  const rc = resolveRails(scoringProfile, false)

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} · user ${USER_ID} · ${dates.length} day(s)${!explicit && !INCLUDE_TODAY ? ` (excluding today, ${today})` : ''}\n`)
  const anthropic = APPLY ? new Anthropic({ apiKey: anthropicKey }) : null
  let done = 0, failed = 0

  // Back up every analysis about to be replaced BEFORE the first write, so a
  // crash halfway through can never leave a day overwritten with no copy.
  if (APPLY && dates.length > 0) {
    const { data: prior } = await scoped.from('trading_days').select('id, date, eod_ai_analysis_json').in('date', dates)
    const dir = path.join('scripts', '.repair-backups')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `eod-reanalyze-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    writeFileSync(file, JSON.stringify(prior ?? [], null, 2))
    console.log(`Previous analyses backed up to ${file}\n`)
  }

  for (const date of dates) {
    const { data: day } = await scoped.from('trading_days')
      .select('id, date, eod_notes, prep_notes_json, ai_analysis_json, session_ended_at, eod_chart_screenshot_url, eod_ai_analysis_json')
      .eq('date', date).maybeSingle()
    if (!day) { console.log(`${date}  no trading day — skipped`); failed++; continue }
    // The button sends the saved chart as an image. Rather than silently build a
    // different prompt, refuse the day and say so.
    if (day.eod_chart_screenshot_url) { console.log(`${date}  has a chart screenshot — re-analyse from the app so the image is included`); failed++; continue }

    const { data: trades } = await scoped.from('trades').select('*').eq('trading_day_id', day.id).order('entry_time', { ascending: true })
    const { data: ctx } = await scoped.from('market_context').select('*').eq('trading_day_id', day.id).maybeSingle()
    const tr = (trades ?? []) as Trade[]
    if (tr.length === 0) { console.log(`${date}  no trades — skipped`); failed++; continue }

    const { head, baselinesBlock } = await buildEodContext(scoped, { trades: tr, sessionEndedAt: day.session_ended_at, traderProfile })
    const prompt = head + buildEodPrompt({
      trades: tr,
      eodNotes: day.eod_notes ?? '',
      prepNotes: (day.prep_notes_json ?? undefined) as PrepNotes | undefined,
      prepAnalysis: (day.ai_analysis_json ?? undefined) as AiAnalysis | undefined,
      marketContext: (ctx ?? undefined) as Partial<MarketContext> | undefined,
      hasImage: false,
      scoringProfile,
      isLocalOwner: false,
      baselinesBlock,
    })

    const sessions = [...prompt.matchAll(/session: (GBX\/overnight|RTH)/g)].map(m => (m[1] === 'RTH' ? 'RTH' : 'overnight'))
    const blocks = [
      /TRADER PROFILE/.test(prompt) && 'profile',
      baselinesBlock && 'baselines',
      /COACHING THREAD|coaching thread/i.test(head) && 'coaching',
      /TRADER LANGUAGE PATTERNS/.test(head) && 'journal',
    ].filter(Boolean).join(', ')
    console.log(`${date}  ${tr.length} trade(s) [${sessions.join(', ')}] · ~${Math.round(prompt.length / 4).toLocaleString()} tokens · ${blocks}`)

    if (!APPLY) continue
    try {
      const message = await anthropic!.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 6000,
        messages: [{ role: 'user', content: prompt }],
      })
      const text = message.content[0].type === 'text' ? message.content[0].text : ''
      const parsed = finalizeEodAnalysis(text, tr, rc, m => console.log(`    ${m}`))
      const { error } = await base.from('trading_days').update({ eod_ai_analysis_json: parsed }).eq('id', day.id).eq('user_id', USER_ID)
      if (error) throw new Error(error.message)
      console.log(`    written · ${parsed.process?.verdict ?? '—'} · exec ${parsed.execution?.composite != null ? Math.round(parsed.execution.composite * 100) + '%' : '—'}`)
      done++
    } catch (e) {
      console.log(`    FAILED: ${e instanceof Error ? e.message : String(e)}`)
      failed++
    }
    await sleep(PAUSE_MS)
  }

  console.log(APPLY ? `\n${done} re-analysed · ${failed} skipped or failed` : '\nDry run only. Re-run with --apply to regenerate and write.')
}

main().catch(e => { console.error(e); process.exit(1) })
