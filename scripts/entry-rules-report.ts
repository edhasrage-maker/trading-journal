/**
 * What the founder's entry rules do to their real days — READ ONLY.
 *
 *   npx tsx scripts/entry-rules-report.ts [--from 2026-09-25]
 *
 * Reads the founder's days and trades from the PUBLIC project (service key from
 * .env.public-feed), reads each trade's entry-rules snapshot from the hosted
 * tick tape in memory (the same loader the site uses; nothing is written, the
 * bucket cache is off), and prints:
 *   - every trade since --from: each rule's pass / fail / unknown (* = counts
 *     toward Entry on that trade) and the trade's Entry-rules score
 *   - each day: Entry and TapeScore without the rules → with them
 *   - the period, pooled, the same way
 * The rules are FOUNDER_ENTRY_RULES (src/lib/entry-rules.ts) — what the seed
 * script puts in their profile.
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { FlowScoreLoader, tapeFlowSource } from '../src/lib/orderflow/server/flow-score-loader.ts'
import { supabaseTapeStore } from '../src/lib/orderflow/server/tape-store.ts'
import { computeDayStats, scoreDayRollups, ROLLUP_TRADE_COLS, type DayForStats, type TradeForStats } from '../src/lib/day-stats.ts'
import { aggregateTapeScore } from '../src/lib/tapescore.ts'
import { evaluateRules, tradeRulesScore, FOUNDER_ENTRY_RULES, ptDateOfIso } from '../src/lib/entry-rules.ts'
import { resolveRubric, includeFlowScoreInEntry, type ScoringProfile } from '../src/lib/scoring-profile.ts'
import { normalizeAtrStopTarget } from '../src/lib/exit-rollup.ts'
import { pickMarketContext } from '../src/lib/market-context-select.ts'
import { ENTRY_CTX_VERSION, flowFingerprint } from '../src/lib/orderflow/flow-score-meta.ts'
import type { TradeEntryCtx } from '../src/lib/supabase/types.ts'

const FROM = process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : '2026-09-25'
const HISTORY_FROM = '2026-07-01'   // earlier days only feed the risk yardstick

async function main() {
  const env: Record<string, string> = {}
  for (const l of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '') }
  const sb = createClient(env.PUBLIC_SUPABASE_URL, env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY)
  const { data: u } = await sb.auth.admin.listUsers({ perPage: 200 })
  const uid = u.users.find(x => x.email === 'edhasrage@gmail.com')?.id
  if (!uid) throw new Error('founder not found')

  const { data: prof } = await sb.from('trader_profile').select('scoring_profile_json').eq('user_id', uid).maybeSingle()
  const sp = (prof?.scoring_profile_json ?? null) as ScoringProfile | null
  const atrStopTarget = normalizeAtrStopTarget(resolveRubric(sp).atrStopTarget)
  const includeFlow = includeFlowScoreInEntry(sp)

  const { data: days, error: de } = await sb.from('trading_days')
    .select('id, date, eod_pnl, day_type, day_types, ai_analysis_json, eod_ai_analysis_json')
    .eq('user_id', uid).gte('date', HISTORY_FROM).order('date')
  if (de || !days) throw new Error(de?.message)
  const ids = days.map(d => d.id)
  const trades: (TradeForStats & { trading_day_id: string; entry_price: number | null; direction: 'long' | 'short' | null; symbol: string | null })[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb.from('trades').select(`trading_day_id, ${ROLLUP_TRADE_COLS}`).in('trading_day_id', ids.slice(i, i + 100)).order('entry_time').order('id')
    if (error) throw new Error(error.message)
    trades.push(...(data as never[]))
  }
  const ctxRows: { trading_day_id: string; symbol: string | null; atr_1m: number | null }[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await sb.from('market_context').select('trading_day_id, symbol, atr_1m').in('trading_day_id', ids.slice(i, i + 100))
    ctxRows.push(...((data ?? []) as never[]))
  }

  // the snapshots, from the hosted tape, in memory
  const loader = new FlowScoreLoader(tapeFlowSource(supabaseTapeStore(sb), { cache: null }), { cacheWrite: false })
  const recent = trades.filter(t => (ptDateOfIso(t.entry_time) ?? '') >= FROM)
  for (const t of recent) {
    const o = await loader.entryContext(t as never)
    if (o.status === 'read') {
      const ctx: TradeEntryCtx = { v: ENTRY_CTX_VERSION, src: flowFingerprint(t as never), read_at: o.read_at, bars: o.bars, tape: o.tape, tape_clock: o.tape_clock, at: '' }
      t.entry_ctx = ctx
    } else console.log(`  (no snapshot for ${t.entry_time}: ${o.status} ${'reason' in o ? o.reason : ''})`)
  }

  // ── per trade ──
  console.log(`\nYour trades since ${FROM} (rules as they will be saved; * = counts toward Entry on that trade)\n`)
  const names = FOUNDER_ENTRY_RULES.map(r => r.name)
  console.log(`date       time      side  sym  pnl      ${names.map(n => n.padEnd(6)).join('')}rules score`)
  let lastDate = ''
  for (const t of recent) {
    const res = evaluateRules(FOUNDER_ENTRY_RULES, t.entry_ctx ?? null, t)
    const d = ptDateOfIso(t.entry_time)!
    const hm = new Date(t.entry_time!).toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles' })
    const cells = res.map(r => `${r.status === 'pass' ? 'pass' : r.status === 'fail' ? 'FAIL' : 'unk'}${r.counted ? '*' : ' '}`.padEnd(6)).join('')
    const sc = tradeRulesScore(res)
    console.log(`${d === lastDate ? '          ' : d} ${hm}  ${(t.direction ?? '?').padEnd(5)} ${(t.symbol ?? '').slice(0, 3).padEnd(4)} ${String(Math.round(t.pnl ?? 0)).padStart(6)}   ${cells}${sc == null ? '—' : Math.round(sc * 100)}`)
    lastDate = d
  }
  const sep29 = recent.filter(t => ptDateOfIso(t.entry_time) === '2026-09-29')
  if (sep29.length) {
    console.log('\nSep 29, 2026 — the reasons:')
    for (const t of sep29) {
      const hm = new Date(t.entry_time!).toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles' })
      console.log(`  ${hm} ${t.direction} ${t.symbol} ${Math.round(t.pnl ?? 0)}`)
      for (const r of evaluateRules(FOUNDER_ENTRY_RULES, t.entry_ctx ?? null, t)) console.log(`    ${r.name} ${r.status}${r.counted ? '' : ' (not counted: before its start date)'} — ${r.reason}`)
    }
  }

  // ── days: without → with ──
  const byDay = new Map<string, typeof trades>()
  for (const t of trades) { if (!byDay.has(t.trading_day_id)) byDay.set(t.trading_day_id, []); byDay.get(t.trading_day_id)!.push(t) }
  const roll = (withRules: boolean) => scoreDayRollups(days.map(d => {
    const dt = byDay.get(d.id) ?? []
    const atr = (pickMarketContext(ctxRows.filter(c => c.trading_day_id === d.id) as never, dt as never) as { atr_1m?: number | null } | null)?.atr_1m ?? null
    return computeDayStats(d as unknown as DayForStats, dt, atr, { atrStopTarget, entryRules: withRules ? FOUNDER_ENTRY_RULES : [] })
  }), [], { includeFlow })
  const without = roll(false), withR = roll(true)
  console.log(`\nDays since ${FROM}: TapeScore and Entry, without the rules → with them`)
  console.log('date        TapeScore     Entry        Entry rules part')
  for (let i = 0; i < days.length; i++) {
    if (days[i].date < FROM) continue
    const a = without[i].tapescore, b = withR[i].tapescore
    const part = b?.parts?.entry.entryRules
    console.log(`${days[i].date}  ${String(a?.score ?? '—').padStart(3)} → ${String(b?.score ?? '—').padEnd(4)}   ${String(a?.components.entry ?? '—').padStart(3)} → ${String(b?.components.entry ?? '—').padEnd(4)}   ${part?.score != null ? `${Math.round(part.score)} · ${part.n} trades · ${Math.round(part.weight * 100)}% of Entry` : 'none counted'}`)
  }
  for (const [label, from, to] of [[`${FROM} → today`, FROM, '9999'], ['October', '2026-10-01', '2026-10-31'], ['Sep (from 26th)', '2026-09-26', '2026-09-30']] as const) {
    const pick = (rs: typeof without) => rs.filter((_, i) => days[i].date >= from && days[i].date <= to)
    const a = aggregateTapeScore(pick(without)), b = aggregateTapeScore(pick(withR))
    console.log(`\n${label}: TapeScore ${a.score?.toFixed(0) ?? '—'} → ${b.score?.toFixed(0) ?? '—'} · Entry ${a.entry?.toFixed(0) ?? '—'} → ${b.entry?.toFixed(0) ?? '—'} · Entry rules ${b.parts?.entry.entryRules.score?.toFixed(0) ?? '—'} (${b.parts?.entry.entryRules.n ?? 0} trades)`)
  }
  // a day with no counted rule must score exactly as before
  const untouched = days.map((d, i) => ({ d, i })).filter(({ d, i }) => d.date < '2026-09-26' && withR[i].tapescore)
  const changed = untouched.filter(({ i }) => JSON.stringify(without[i].tapescore?.score) !== JSON.stringify(withR[i].tapescore?.score) || without[i].tapescore?.components.entry !== withR[i].tapescore?.components.entry)
  console.log(`\nDays before Sep 26 (no rule counts yet): ${untouched.length - changed.length} of ${untouched.length} unchanged${changed.length ? ` — CHANGED: ${changed.map(c => c.d.date).join(', ')}` : ''}`)
}

main().catch(e => { console.error(e); process.exit(1) })
