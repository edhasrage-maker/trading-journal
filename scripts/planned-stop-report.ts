/**
 * What the planned stop (src/lib/planned-stop.ts) changes on a trader's real
 * days and trades — READ ONLY. Runs the same in any version of the code, so
 * the change is measured against what the site shows today:
 *
 *   npx tsx scripts/planned-stop-report.ts --envfile .env.public-feed --out new.json
 *   (the same script, run from an export of live-server-version)  --out old.json
 *   npx tsx scripts/planned-stop-report.ts --compare old.json new.json
 *
 * Reads the founder's days and trades from the PUBLIC project (service key;
 * nothing is written). Days are scored as the dashboard scores them (the
 * trader's own rules and settings, the risk yardstick in sequence); trades as
 * the Score chip, R and the "past stop" label read them.
 */
import { readFileSync, writeFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { computeDayStats, scoreDayRollups, ROLLUP_TRADE_COLS, type DayForStats, type TradeForStats } from '../src/lib/day-stats.ts'
import { readEntryRules } from '../src/lib/entry-rules.ts'
import { readRunnerRules } from '../src/lib/runner-rules.ts'
import { resolveRubric, includeFlowScoreInEntry, type ScoringProfile } from '../src/lib/scoring-profile.ts'
import { normalizeAtrStopTarget } from '../src/lib/exit-rollup.ts'
import { tradeGrade } from '../src/lib/trade-grade.ts'
import { maeHeatRatio, rMultiple } from '../src/lib/analytics.ts'
import { exitKind } from '../src/lib/trade-management.ts'
// a namespace import, so the same script runs on code from before stopCheck existed
import * as exitScore from '../src/lib/exit-score.ts'

const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null)
const FROM = arg('--from') ?? '2026-05-01'
const ptDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
const ptHm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', second: '2-digit' })

interface DayOut { tapescore: number | null; risk: number | null; entry: number | null; exit: number | null; stopRespected: [number | null, number]; stopSize: [number | null, number]; lossSize: [number | null, number] }
interface TradeOut { date: string; at: string; dir: string; pnl: number | null; score: number | null; exit: number | null; stopRespected: number | null; r: number | null; heat: number | null; past: boolean; kind: string | null; hasStops: boolean }
interface Report { days: Record<string, DayOut>; trades: Record<string, TradeOut> }

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

  // every day (the yardstick reads the days before), oldest first
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
  const part = (p: { score: number | null; n: number | null } | undefined): [number | null, number] => [p?.score != null ? Math.round(p.score) : null, p?.n ?? 0]
  scored.forEach((s, i) => {
    if (days[i].date < FROM) return
    const ts = s.tapescore
    out.days[days[i].date] = {
      tapescore: ts?.score ?? null, risk: ts?.components.risk ?? null, entry: ts?.components.entry ?? null, exit: ts?.components.exit ?? null,
      stopRespected: part(ts?.parts?.exit.stopRespected), stopSize: part(ts?.parts?.risk.stopSize), lossSize: part(ts?.parts?.risk.lossSize),
    }
  })

  // trades as the table reads them (full rows: the Score reads review_json)
  for (let p = 0; ; p++) {
    const { data, error } = await sb.from('trades').select('*').eq('user_id', uid).gte('entry_time', `${FROM}T07:00:00Z`)
      .order('entry_time').order('id').range(p * 1000, p * 1000 + 999)
    if (error) throw new Error(error.message)
    for (const t of data) {
      const g = tradeGrade(t, { entryRules, runnerRules, includeFlow, atrStopTarget })
      out.trades[t.id] = {
        date: ptDate(t.entry_time), at: ptHm(t.entry_time), dir: t.direction, pnl: t.pnl,
        score: g.score, exit: g.exit, stopRespected: g.parts.stopRespected,
        r: rMultiple(t), heat: maeHeatRatio(t), kind: exitKind(t), hasStops: !!t.review_json?.stops?.orders?.length,
        // the label: stopCheck where the code has it, else heat over 1 (what the table drew before)
        past: (exitScore as { stopCheck?: (x: unknown) => { past: boolean } | null }).stopCheck?.(t)?.past ?? ((maeHeatRatio(t) ?? 0) > 1),
      }
    }
    if (data.length < 1000) break
  }
  return out
}

function compare(oldR: Report, newR: Report) {
  const f = (x: number | null | undefined, d = 0) => (x == null ? '—' : x.toFixed(d))
  const fp = (p: [number | null, number]) => `${f(p[0])} (${p[1]})`
  const dates = Object.keys(newR.days).sort()
  const changed = dates.filter(d => JSON.stringify(oldR.days[d]) !== JSON.stringify(newR.days[d]))
  console.log(`DAYS: ${changed.length} of ${dates.length} change (since ${FROM})\n`)
  console.log('date        TapeScore   Risk      Entry     Exit      Stop respected      Stop size           Loss size')
  for (const d of changed) {
    const a = oldR.days[d], b = newR.days[d]
    const cell = (x: number | null, y: number | null) => `${f(x)}→${f(y)}`.padEnd(10)
    const pc = (x: [number | null, number], y: [number | null, number]) => (JSON.stringify(x) === JSON.stringify(y) ? '·' : `${fp(x)}→${fp(y)}`).padEnd(20)
    console.log(`${d}  ${cell(a.tapescore, b.tapescore)}  ${cell(a.risk, b.risk)}${cell(a.entry, b.entry)}${cell(a.exit, b.exit)}${pc(a.stopRespected, b.stopRespected)}${pc(a.stopSize, b.stopSize)}${pc(a.lossSize, b.lossSize)}`)
  }
  const ids = Object.keys(newR.trades).sort((x, y) => (newR.trades[x].date + newR.trades[x].at).localeCompare(newR.trades[y].date + newR.trades[y].at))
  const tChanged = ids.filter(id => { const a = oldR.trades[id], b = newR.trades[id]; return !a || a.score !== b.score || a.stopRespected !== b.stopRespected || a.past !== b.past || f(a.r, 2) !== f(b.r, 2) || a.kind !== b.kind })
  const withStops = ids.filter(id => newR.trades[id].hasStops).length
  console.log(`\nTRADES: ${tChanged.length} of ${ids.length} change (${withStops} have Sierra stop history; the rest keep the logged stop)\n`)
  console.log('date        time      dir    P&L    Score     Stop resp.  R              past stop  ended')
  for (const id of tChanged) {
    const a = oldR.trades[id], b = newR.trades[id]
    const ps = (x: TradeOut) => (x.past ? 'yes' : 'no')
    console.log(`${b.date}  ${b.at}  ${b.dir.padEnd(5)} ${String(Math.round(b.pnl ?? 0)).padStart(5)}  ${`${f(a?.score)}→${f(b.score)}`.padEnd(9)} ${`${f(a?.stopRespected)}→${f(b.stopRespected)}`.padEnd(11)} ${`${f(a?.r, 2)}→${f(b.r, 2)}`.padEnd(14)} ${a ? `${ps(a)}→${ps(b)}`.padEnd(10) : ''} ${a?.kind === b.kind ? '·' : `${a?.kind}→${b.kind}`}`)
  }
}

async function main() {
  const cmp = process.argv.indexOf('--compare')
  if (cmp >= 0) {
    const [a, b] = [process.argv[cmp + 1], process.argv[cmp + 2]].map(p => JSON.parse(readFileSync(p, 'utf8')) as Report)
    compare(a, b)
    return
  }
  const r = await build()
  const out = arg('--out')
  if (!out) throw new Error('--out <file> or --compare <old> <new>')
  writeFileSync(out, JSON.stringify(r))
  console.log(`${Object.keys(r.days).length} days, ${Object.keys(r.trades).length} trades → ${out}`)
}

main().catch(e => { console.error(e); process.exit(1) })
