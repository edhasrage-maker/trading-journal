/**
 * One-time setup of the founder's entry rules on the PUBLIC project.
 * DRY RUN unless --apply is passed.
 *
 *   npx tsx scripts/entry-rules-founder-setup.ts                 # dry run: what would change
 *   npx tsx scripts/entry-rules-founder-setup.ts --apply         # do it
 *   npx tsx scripts/entry-rules-founder-setup.ts --apply --from 2026-09-25
 *
 * 1. RULES. Puts FOUNDER_ENTRY_RULES (L1–L4 from Oct 14, F3/F5/F6 from Sep 26 —
 *    src/lib/entry-rules.ts) into the founder's scoring_profile_json.entry_rules,
 *    merged into the profile (every other key kept). Skipped when the profile
 *    already has entry rules — Settings is then the place to change them.
 * 2. SNAPSHOTS. Reads the entry rules' snapshot (review_json.entry_ctx) for the
 *    founder's trades since --from (default 2026-09-25) that lack a current one,
 *    under the same write rules as the site (entry-context-run.ts: read-merge,
 *    only `entry_ctx` replaced, nothing written when the fill changed). The
 *    Recap does this by itself when a day is opened; this fills the days not
 *    opened yet, so the Settings tally and the Entry grade are complete.
 *
 * 3. RUNNER RULES (only with --runner-be <ticks>): puts the TP2 study's
 *    mechanics into scoring_profile_json.runner_rules — T1 scale out 60% at the
 *    logged TP1, T2 runner leaves only at breakeven (within <ticks>), 4×ATR ±0.25
 *    or 13:00 PT, T3 breakeven only after TP1 (unknown) — counting from
 *    --runner-from (default 2026-10-14). Skipped when the profile already has
 *    runner rules.
 *
 * The service key comes from .env.public-feed (local only, never committed).
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { FlowScoreLoader, tapeFlowSource } from '../src/lib/orderflow/server/flow-score-loader.ts'
import { supabaseTapeStore } from '../src/lib/orderflow/server/tape-store.ts'
import { readEntryContexts } from '../src/lib/orderflow/server/entry-context-run.ts'
import { FLOW_TRADE_COLUMNS, type FlowTradeRecord, type FlowTradeStore } from '../src/lib/orderflow/server/flow-score-run.ts'
import { entryCtxIsCurrent } from '../src/lib/orderflow/flow-score-meta.ts'
import { FOUNDER_ENTRY_RULES, readEntryRules } from '../src/lib/entry-rules.ts'
import { newRunnerRule, readRunnerRules } from '../src/lib/runner-rules.ts'

const APPLY = process.argv.includes('--apply')
const FROM = process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : '2026-09-25'
const FOUNDER = 'edhasrage@gmail.com'
const RUNNER_BE = process.argv.includes('--runner-be') ? Number(process.argv[process.argv.indexOf('--runner-be') + 1]) : null
const RUNNER_FROM = process.argv.includes('--runner-from') ? process.argv[process.argv.indexOf('--runner-from') + 1] : '2026-10-14'

async function main() {
  const env: Record<string, string> = {}
  for (const l of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '') }
  const sb = createClient(env.PUBLIC_SUPABASE_URL, env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY)
  const { data: u } = await sb.auth.admin.listUsers({ perPage: 200 })
  const uid = u.users.find(x => x.email === FOUNDER)?.id
  if (!uid) throw new Error('founder not found')
  console.log(APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)')

  // 1. rules
  const { data: prof, error: pe } = await sb.from('trader_profile').select('id, scoring_profile_json').eq('user_id', uid).maybeSingle()
  if (pe || !prof) throw new Error(`profile: ${pe?.message ?? 'none'}`)
  const sp = (prof.scoring_profile_json ?? {}) as Record<string, unknown>
  const existing = readEntryRules(sp.entry_rules)
  if (existing.length) {
    console.log(`1. rules: the profile already has ${existing.length} entry rules (${existing.map(r => r.name).join(', ')}) — left as they are`)
  } else {
    console.log(`1. rules: will add ${FOUNDER_ENTRY_RULES.map(r => `${r.name} (from ${r.from})`).join(', ')}`)
    if (APPLY) {
      const { error } = await sb.from('trader_profile').update({ scoring_profile_json: { ...sp, entry_rules: FOUNDER_ENTRY_RULES } }).eq('id', prof.id).eq('user_id', uid)
      if (error) throw new Error(`profile write: ${error.message}`)
      console.log('   saved')
    }
  }

  // 3. runner rules (opt-in)
  if (RUNNER_BE != null) {
    if (!Number.isFinite(RUNNER_BE) || RUNNER_BE < 0) throw new Error('--runner-be needs a number of ticks')
    const { data: prof2 } = await sb.from('trader_profile').select('id, scoring_profile_json').eq('user_id', uid).maybeSingle()
    const sp2 = (prof2?.scoring_profile_json ?? {}) as Record<string, unknown>
    const have = readRunnerRules(sp2.runner_rules)
    const runner = [
      newRunnerRule('scale_out', 'T1', RUNNER_FROM, 't1'),
      { ...newRunnerRule('runner_exit', 'T2', RUNNER_FROM, 't2'), be_ticks: RUNNER_BE },
      newRunnerRule('be_after_tp1', 'T3', RUNNER_FROM, 't3'),
    ]
    if (have.length) console.log(`3. runner rules: the profile already has ${have.length} (${have.map(r => r.name).join(', ')}) — left as they are`)
    else {
      console.log(`3. runner rules: will add T1 (60% at TP1), T2 (breakeven within ${RUNNER_BE} ticks, 4×ATR ±0.25, 13:00), T3 (unknown) from ${RUNNER_FROM}`)
      if (APPLY && prof2) {
        const { error } = await sb.from('trader_profile').update({ scoring_profile_json: { ...sp2, runner_rules: runner } }).eq('id', prof2.id).eq('user_id', uid)
        if (error) throw new Error(`profile write: ${error.message}`)
        console.log('   saved')
      }
    }
  }

  // 2. snapshots
  const { data: rows, error: te } = await sb.from('trades').select(FLOW_TRADE_COLUMNS).eq('user_id', uid).gte('entry_time', FROM).order('entry_time')
  if (te || !rows) throw new Error(`trades: ${te?.message}`)
  const todo = (rows as unknown as FlowTradeRecord[]).filter(r => !entryCtxIsCurrent(r.review_json?.entry_ctx, r))
  console.log(`2. snapshots: ${rows.length} trades since ${FROM}, ${todo.length} without a current one`)
  if (!APPLY || !todo.length) return
  // every read and write is pinned to the founder's own rows
  const store: FlowTradeStore = {
    async read(ids) {
      const { data, error } = await sb.from('trades').select(FLOW_TRADE_COLUMNS).eq('user_id', uid).in('id', ids)
      if (error) throw new Error(error.message)
      return (data ?? []) as unknown as FlowTradeRecord[]
    },
    async readOne(id) {
      const { data, error } = await sb.from('trades').select(FLOW_TRADE_COLUMNS).eq('user_id', uid).eq('id', id).maybeSingle()
      if (error) throw new Error(error.message)
      return (data ?? null) as unknown as FlowTradeRecord | null
    },
    async writeReview(id, review) {
      const { error } = await sb.from('trades').update({ review_json: review }).eq('user_id', uid).eq('id', id)
      if (error) throw new Error(error.message)
    },
  }
  const loader = new FlowScoreLoader(tapeFlowSource(supabaseTapeStore(sb), { cache: null }), { cacheWrite: false })
  const res = await readEntryContexts(store, todo.map(r => r.id), () => loader)
  const counts: Record<string, number> = {}
  for (const r of Object.values(res)) counts[r.status] = (counts[r.status] ?? 0) + 1
  console.log('   ', counts)
  for (const [id, r] of Object.entries(res)) if (r.status !== 'read' && r.status !== 'current') console.log(`    ${id}: ${r.status} — ${'reason' in r ? r.reason : ''}`)
}

main().catch(e => { console.error(e); process.exit(1) })
