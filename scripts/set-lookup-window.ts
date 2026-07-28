/**
 * Set (or clear) the Morning Conditions history window for one user, then
 * rebuild their condition lookup from it.
 *
 * `refreshConditionLookup` aggregates the trader's ENTIRE history by default.
 * `condition_lookup_meta.history_start_date` narrows it — both the trade
 * aggregation AND the threshold/tercile cuts, which have to move together or
 * the buckets get cut on one era and filled from another.
 *
 * Two reasons to use it:
 *   - dogfooding: the founder's account has 3+ years, so every bucket clears
 *     MIN_SAMPLE and the thin-sample suppression path never renders. Windowing
 *     to the current year shows what a newer trader actually sees.
 *   - relevance: exclude an era that no longer reflects how the trader trades.
 *
 * The setting is persistent and read by refreshConditionLookup, so the Settings
 * "Refresh now" button and the nightly cron both respect it — neither clobbers
 * the window. The prep panel shows "· from YYYY-MM-DD" whenever it is set, so a
 * smaller n reads as a deliberate choice rather than missing data.
 *
 * Usage:
 *   npx tsx scripts/set-lookup-window.ts --from=2026-01-01
 *   npx tsx scripts/set-lookup-window.ts --clear            # back to all history
 *   npx tsx scripts/set-lookup-window.ts --from=2026-01-01 --env=local
 *   npx tsx scripts/set-lookup-window.ts --from=2026-01-01 --user=<uuid>
 *
 * Requires migrations/20260728_condition_lookup_history_window.sql to have been
 * applied (SQL changes are run in the Supabase dashboard on this project).
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'
import { refreshConditionLookup } from '../src/lib/condition-lookup-refresh.ts'

const DEFAULT_USER = 'fa3fb352-9538-44cc-8ce1-1c76f307044c'

const args = process.argv.slice(2)
const CLEAR = args.includes('--clear')
const FROM = args.find(a => a.startsWith('--from='))?.slice(7) ?? null
const ENV_FILE = args.includes('--env=local') ? '.env.local' : '.env.public-feed'
const USER = args.find(a => a.startsWith('--user='))?.slice(7) || DEFAULT_USER

if (!CLEAR && !FROM) {
  console.error('usage: --from=YYYY-MM-DD | --clear')
  process.exit(1)
}
if (FROM && !/^\d{4}-\d{2}-\d{2}$/.test(FROM)) {
  console.error(`--from must be YYYY-MM-DD, got "${FROM}"`)
  process.exit(1)
}

for (const line of readFileSync(join(process.cwd(), ENV_FILE), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const URL = process.env.PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) throw new Error(`missing Supabase URL/service-role key in ${ENV_FILE}`)
const sb = createClient(URL, KEY)

/* eslint-disable @typescript-eslint/no-explicit-any */

async function main() {
  const target = CLEAR ? null : FROM
  console.log(`set-lookup-window — env ${ENV_FILE} · user ${USER} · window ${target ?? 'ALL HISTORY'}`)

  const probe = await sb
    .from('condition_lookup_meta').select('user_id, history_start_date')
    .eq('user_id', USER).maybeSingle() as any
  if (probe.error) {
    console.error(
      `\ncondition_lookup_meta.history_start_date is missing (${probe.error.message}).\n` +
      'Apply supabase/migrations/20260728_condition_lookup_history_window.sql in the Supabase dashboard first.',
    )
    process.exit(2)
  }
  console.log(`current: ${probe.data?.history_start_date ?? 'ALL HISTORY'}`)

  const { error } = await sb
    .from('condition_lookup_meta')
    .upsert({ user_id: USER, history_start_date: target }, { onConflict: 'user_id' })
  if (error) throw new Error(`could not set window: ${error.message}`)

  console.log('rebuilding lookup from the new window…')
  const res = await refreshConditionLookup(sb, USER)
  console.log(
    `  ${res.lookup_inserted} lookup rows · ${res.thresholds_inserted} thresholds · ` +
    `${res.trades_aggregated} trades aggregated · ${res.market_context_rows} context days`,
  )

  const { data: rows } = await sb
    .from('condition_lookup').select('n_trades, verdict').eq('user_id', USER) as any
  const sampled = (rows ?? []).filter((r: any) => (r.n_trades ?? 0) > 0)
  const insufficient = (rows ?? []).filter((r: any) => r.verdict === 'INSUFFICIENT_DATA')
  const ns = sampled.map((r: any) => Number(r.n_trades)).sort((a: number, b: number) => b - a)
  console.log(
    `  buckets with samples ${sampled.length}/${(rows ?? []).length} · ` +
    `INSUFFICIENT_DATA ${insufficient.length}` +
    (ns.length ? ` · n_trades max ${ns[0]} / median ${ns[Math.floor(ns.length / 2)]} / min ${ns[ns.length - 1]}` : ''),
  )
}

main().catch(e => { console.error(e.message ?? e); process.exit(1) })
