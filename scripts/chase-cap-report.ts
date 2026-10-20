/**
 * What the chase rule (src/lib/tapescore-day-rules.ts: 2 or more chase trades
 * cap the day at 69; "Waited after a loss" in a re-entry's Score) changes on a
 * trader's real days and trades — READ ONLY. Runs the same in any version of
 * the code, so the change is measured against what the site shows today:
 *
 *   npx tsx scripts/chase-cap-report.ts --envfile .env.public-feed --out new.json
 *   (the same script, run from an export of live-server-version)  --out old.json
 *   npx tsx scripts/chase-cap-report.ts --compare old.json new.json
 *
 * Days are scored as the dashboard scores them; trades as the Recap's Score
 * column grades them (with the day's re-entry reads where the code has them).
 */
import { readFileSync, writeFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { computeDayStats, scoreDayRollups, ROLLUP_TRADE_COLS, type DayForStats, type TradeForStats } from '../src/lib/day-stats.ts'
import { readEntryRules } from '../src/lib/entry-rules.ts'
import { readRunnerRules } from '../src/lib/runner-rules.ts'
import { resolveRubric, includeFlowScoreInEntry, type ScoringProfile } from '../src/lib/scoring-profile.ts'
import { normalizeAtrStopTarget } from '../src/lib/exit-rollup.ts'
import { tradeGrade } from '../src/lib/trade-grade.ts'
// a namespace import, so the same script runs on code from before reentryReads existed
import * as dayRules from '../src/lib/tapescore-day-rules.ts'

const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null)
const FROM = arg('--from') ?? '2026-05-01'
const ptDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
const ptHms = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles' })

interface Report {
  days: Record<string, { score: number | null; chase: number | null; capped: boolean | null; uncapped: number | null }>
  trades: Record<string, { date: string; at: string; pnl: number | null; score: number | null; waited: number | null }>
}
type Reads = (t: unknown[]) => Map<string, unknown>

async function build(): Promise<Report> {
  const env: Record<string, string> = {}
  for (const l of readFileSync(arg('--envfile') ?? '.env.public-feed', 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '') }
  const sb = createClient(env.PUBLIC_SUPABASE_URL, env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY)
  const { data: u } = await sb.auth.admin.listUsers({ perPage: 200 })
  const uid = u.users.find(x => x.email === 'edhasrage@gmail.com')?.id
  if (!uid) throw new Error('founder not found')
  const { data: prof } = await sb.from('trader_profile').select('scoring_profile_json').eq('user_id', uid).maybeSingle()
  const sp = (prof?.scoring_profile_json ?? null) as ScoringProfile | null
  const atrStopTarget = normalizeAtrStopTarget(resolveRubric(sp).atrStopTarget)
  const entryRules = readEntryRules(sp?.entry_rules), runnerRules = readRunnerRules(sp?.runner_rules)
  const includeFlow = includeFlowScoreInEntry(sp)

  const days: (DayForStats & { id: string })[] = []
  for (let p = 0; ; p++) {
    const { data, error } = await sb.from('trading_days').select('id, date, eod_pnl, day_type, day_types, ai_analysis_json, eod_ai_analysis_json')
      .eq('user_id', uid).order('date').order('id').range(p * 1000, p * 1000 + 999)
    if (error) throw new Error(error.message)
    days.push(...(data as never[])); if (data.length < 1000) break
  }
  const ids = days.map(d => d.id)
  const trades: (TradeForStats & { trading_day_id: string })[] = []
  for (let i = 0; i < ids.length; i += 50) {
    for (let p = 0; ; p++) {
      const { data, error } = await sb.from('trades').select(`trading_day_id, ${ROLLUP_TRADE_COLS}`)
        .in('trading_day_id', ids.slice(i, i + 50)).order('entry_time').order('id').range(p * 1000, p * 1000 + 999)
      if (error) throw new Error(error.message)
      trades.push(...(data as never[])); if (data.length < 1000) break
    }
  }
  const byDay = new Map<string, typeof trades>()
  for (const t of trades) { if (!byDay.has(t.trading_day_id)) byDay.set(t.trading_day_id, []); byDay.get(t.trading_day_id)!.push(t) }
  const rolled = days.map(d => computeDayStats(d, byDay.get(d.id) ?? [], null, { atrStopTarget, entryRules, runnerRules }))
  const scored = scoreDayRollups(rolled, [], { includeFlow, runnerOwn: runnerRules.some(r => r.on) })

  const out: Report = { days: {}, trades: {} }
  scored.forEach((s, i) => {
    if (days[i].date < FROM) return
    const ts = s.tapescore as (typeof s.tapescore & { chaseTrades?: number; chaseCapped?: boolean; uncapped?: number }) | null
    out.days[days[i].date] = { score: ts?.score ?? null, chase: ts?.chaseTrades ?? null, capped: ts?.chaseCapped ?? null, uncapped: ts?.uncapped ?? null }
  })

  // trades, grouped by day so each re-entry is read against its own day
  const reads = (dayRules as unknown as { reentryReads?: Reads }).reentryReads
  const full: Record<string, unknown>[] = []
  for (let p = 0; ; p++) {
    const { data, error } = await sb.from('trades').select('*').eq('user_id', uid).gte('entry_time', `${FROM}T07:00:00Z`).order('entry_time').order('id').range(p * 1000, p * 1000 + 999)
    if (error) throw new Error(error.message)
    full.push(...data); if (data.length < 1000) break
  }
  const fullByDay = new Map<string, Record<string, unknown>[]>()
  for (const t of full) { const k = String(t.trading_day_id); if (!fullByDay.has(k)) fullByDay.set(k, []); fullByDay.get(k)!.push(t) }
  for (const list of fullByDay.values()) {
    const rd = reads ? reads(list) : null
    for (const t of list as never[]) {
      const tr = t as { id: string; entry_time: string; pnl: number | null }
      const g = tradeGrade(t, { entryRules, runnerRules, includeFlow, atrStopTarget, ...(rd ? { reentry: rd.get(tr.id) ?? null } : {}) } as never)
      out.trades[tr.id] = { date: ptDate(tr.entry_time), at: ptHms(tr.entry_time), pnl: tr.pnl, score: g.score, waited: (g.parts as { waited?: number | null }).waited ?? null }
    }
  }
  return out
}

function compare(oldR: Report, newR: Report) {
  const dates = Object.keys(newR.days).sort()
  const changed = dates.filter(d => oldR.days[d]?.score !== newR.days[d].score)
  const capped = dates.filter(d => newR.days[d].capped)
  console.log(`DAYS: ${changed.length} of ${dates.length} change (since ${FROM}); chase-capped: ${capped.length}`)
  for (const d of changed) {
    const a = oldR.days[d], b = newR.days[d]
    console.log(`  ${d}  ${a?.score ?? '—'} → ${b.score ?? '—'}  (${b.chase} chase trades${b.capped ? `, capped from ${b.uncapped}` : ''})`)
  }
  const odd = changed.filter(d => !newR.days[d].capped)
  console.log(odd.length ? `  !! changed without the chase cap: ${odd.join(', ')}` : '  every changed day is a chase-capped day')

  const ids = Object.keys(newR.trades).sort((x, y) => (newR.trades[x].date + newR.trades[x].at).localeCompare(newR.trades[y].date + newR.trades[y].at))
  const tChanged = ids.filter(id => oldR.trades[id]?.score !== newR.trades[id].score)
  const withPart = ids.filter(id => newR.trades[id].waited != null)
  const strays = tChanged.filter(id => newR.trades[id].waited == null)
  const fails = withPart.filter(id => newR.trades[id].waited === 0), passes = withPart.filter(id => newR.trades[id].waited === 100)
  const avg = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x != null); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(0) : '—' }
  console.log(`\nTRADES: ${tChanged.length} of ${ids.length} change; with a "Waited" part: ${withPart.length} (chase ${fails.length}, fresh trigger ${passes.length})`)
  console.log(`  chase trades' Score: ${avg(fails.map(id => oldR.trades[id]?.score ?? null))} → ${avg(fails.map(id => newR.trades[id].score))}`)
  console.log(`  fresh-trigger re-entries' Score: ${avg(passes.map(id => oldR.trades[id]?.score ?? null))} → ${avg(passes.map(id => newR.trades[id].score))}`)
  console.log(strays.length ? `  !! changed without a "Waited" part: ${strays.length}` : '  every changed trade is a re-entry after a loss')
  for (const id of ids.filter(i => newR.trades[i].date === (arg('--show') ?? '2026-10-19'))) {
    const a = oldR.trades[id], b = newR.trades[id]
    console.log(`  ${b.date} ${b.at}  pnl ${b.pnl}  Score ${a?.score ?? '—'} → ${b.score ?? '—'}${b.waited != null ? `  (Waited ${b.waited})` : ''}`)
  }
}

async function main() {
  const cmp = process.argv.indexOf('--compare')
  if (cmp >= 0) {
    compare(...([process.argv[cmp + 1], process.argv[cmp + 2]].map(p => JSON.parse(readFileSync(p, 'utf8')) as Report) as [Report, Report]))
    return
  }
  const out = arg('--out')
  if (!out) throw new Error('--out <file> or --compare <old> <new>')
  const r = await build()
  writeFileSync(out, JSON.stringify(r))
  console.log(`${Object.keys(r.days).length} days, ${Object.keys(r.trades).length} trades → ${out}`)
}

main().catch(e => { console.error(e); process.exit(1) })
