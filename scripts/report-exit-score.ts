/**
 * READ-ONLY report: one trader's Exit score and TapeScore under the five-factor
 * Exit, recomputed through the SAME code the app runs —
 *
 *   dashboard path   every day → computeDayStats → scoreDayRollups → aggregateTapeScore
 *   recap path       loadPeriodDays (Review · Month) → summarizePeriod
 *   Recap day path   loadRiskHistory + avgRiskBefore (the TapeScore header's average)
 *
 * and printed side by side, so any disagreement between surfaces shows up here
 * first. Never writes: the client is wrapped so every write throws or no-ops
 * (the recap loader's best-effort cache write-back is swallowed), and every
 * read is scoped to one user even under the service key.
 *
 *   npx tsx scripts/report-exit-score.ts                 (hosted DB, founder)
 *   npx tsx scripts/report-exit-score.ts --user=<uuid> --from=2026-06 --to=2026-10 --daily=2026-10
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { computeDayStats, scoreDayRollups, ROLLUP_TRADE_COLS, type DayForStats, type ScoredDayRollup, type TradeForStats } from '../src/lib/day-stats'
import { loadAtrStopTarget, loadRiskHistory } from '../src/lib/day-stats-server'
import { loadPeriodDays, summarizePeriod, monthRange, nextMonth } from '../src/lib/period-recap'
import { aggregateTapeScore, tapeScoreWithExit } from '../src/lib/tapescore'
import {
  exitScoreView, mergeExitSums, lossSizeInputs, lossSizeScore, plannedRiskDollars, EXIT_FACTORS,
  type ExitScoreView, type ExitSums,
} from '../src/lib/exit-score'
import { avgRiskBefore, dayExitSums } from '../src/lib/exit-rollup'

const arg = (name: string, dflt: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt
const UID = arg('user', 'fa3fb352-9538-44cc-8ce1-1c76f307044c')
const FROM = arg('from', '2026-06')
const TO = arg('to', '2026-10')
const DAILY = arg('daily', '2026-10')

for (const l of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/)
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const URL = process.env.PUBLIC_SUPABASE_URL, KEY = process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) { console.error('Missing PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_SERVICE_ROLE_KEY in .env.public-feed'); process.exit(1) }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const raw: any = createClient(URL, KEY)

/** The service key sees every tenant and can write. This wrapper scopes every
 *  select to one user (what RLS does for the app) and refuses every write. */
let blockedWrites = 0
const ro = {
  from(table: string) {
    const b = raw.from(table)
    return {
      select: (cols: string, opts?: unknown) => b.select(cols, opts).eq('user_id', UID),
      update: () => ({ eq: () => { blockedWrites++; return Promise.resolve({ data: null, error: { message: 'read-only report' } }) } }),
      insert: () => { throw new Error('read-only report: insert refused') },
      upsert: () => { throw new Error('read-only report: upsert refused') },
      delete: () => { throw new Error('read-only report: delete refused') },
    }
  },
}

const PAGE = 1000
async function all<T>(table: string, cols: string, order: string): Promise<T[]> {
  const out: T[] = []
  for (let p = 0; p < 100; p++) {
    const { data, error } = await ro.from(table).select(cols).order(order, { ascending: true }).range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...(data as T[]))
    if ((data as T[]).length < PAGE) break
  }
  return out
}

const r0 = (v: number | null | undefined) => (v == null ? '—' : String(Math.round(v)))
const pad = (s: string, n: number) => s.padStart(n)
const factorRow = (f: ExitScoreView['factors'] | null | undefined) =>
  EXIT_FACTORS.map(k => pad(f && f[k].n > 0 ? `${r0(f[k].score)}(${f[k].n})` : 'none', 9)).join(' ')
const viewOf = (s: ExitSums | null | undefined) => exitScoreView(s ?? mergeExitSums([]))

async function main() {
  type DayRow = DayForStats & { id: string; date: string }
  const days = await all<DayRow>('trading_days', 'id, date, eod_pnl, day_type, day_types, ai_analysis_json, eod_ai_analysis_json', 'date')
  type T = TradeForStats & { trading_day_id: string; entry_time: string | null }
  const trades = await all<T>('trades', `trading_day_id, entry_time, ${ROLLUP_TRADE_COLS}`, 'id')
  const atrStopTarget = await loadAtrStopTarget(ro)
  console.log(`user ${UID}: ${days.length} days, ${trades.length} trades, ATR stop setting ${atrStopTarget}`)

  const byDay = new Map<string, T[]>()
  for (const t of trades) { const a = byDay.get(t.trading_day_id) ?? []; a.push(t); byDay.set(t.trading_day_id, a) }

  // ── Dashboard path: every day, read in sequence ──
  const rollups = days.map(d => computeDayStats(d, byDay.get(d.id) ?? [], null, { atrStopTarget }))
  const scored = scoreDayRollups(rollups)
  const avgByDate = new Map<string, number | null>()
  {
    // Reproduce the per-day average the sequence used (same rule, for printing).
    for (const r of rollups) avgByDate.set(r.date, avgRiskBefore(r.date, rollups))
  }

  // The prototype's yardstick, for comparison only: each losing trade against
  // the previous 30 stop trades BY TRADE (entry time), not whole prior days.
  const ordered = trades.filter(t => t.entry_time).sort((a, b) => (a.entry_time! < b.entry_time! ? -1 : 1))
  const protoLoss = new Map<string, number>()       // trade id → loss-size score
  {
    const window: number[] = []
    for (const t of ordered) {
      if (t.pnl != null && t.pnl < 0) {
        const pair = lossSizeInputs(t)
        const avg = window.length >= 5 ? window.slice(-30).reduce((a, b) => a + b, 0) / Math.min(30, window.length) : null
        const s = pair ? lossSizeScore(pair[0], pair[1], avg) : null
        if (s != null) protoLoss.set(t.id, s)
      }
      const risk = t.pnl != null ? plannedRiskDollars(t) : null
      if (risk != null) window.push(risk)
    }
  }
  const dateOfDay = new Map(days.map(d => [d.id, d.date]))

  // Old Exit (mfe_capture), for the before/after headline.
  const dayById = new Map(days.map(d => [d.id, d]))
  const oldResult = (r: ScoredDayRollup) => {
    const ex = dayById.get(r.id)?.eod_ai_analysis_json?.execution
    const capture = ex?.mfe_capture != null ? Math.max(0, Math.min(1, ex.mfe_capture)) * 100 : null
    // The old rule also forced Exit to 0 on a ran-but-unscoreable read.
    const unscoreable = r.tape?.basis === 'v15' && ex != null && capture == null && r.tape.entry === 0
    return tapeScoreWithExit(r.tape, unscoreable ? 0 : capture)
  }

  console.log('\nMONTHLY — app value = pooled over the trades of the month\'s scored days (what the TapeScore card shows)')
  console.log('          all-trades = pooled over every trade in the month (comparable to the prototype)')
  console.log(`${'month'.padEnd(8)} ${pad('app', 4)} ${pad('recap', 5)} ${pad('allTr', 5)} | ${EXIT_FACTORS.map(k => pad(k, 9)).join(' ')} | ${pad('lossProto', 9)} | TapeScore new / old (old Exit)`)
  for (let m = FROM; m <= TO; m = nextMonth(m)) {
    const { start, end } = monthRange(m)
    const inMonth = scored.filter(d => d.date >= start && d.date <= end)
    const period = aggregateTapeScore(inMonth)
    const allTrades = viewOf(mergeExitSums(inMonth.map(d => d.exit_sums)))
    const recap = summarizePeriod(await loadPeriodDays(ro, start, end)).score
    const oldPeriod = aggregateTapeScore(inMonth.map(d => ({ tapescore: oldResult(d) })))
    const oldExitMean = (() => {
      const v = inMonth.map(d => oldResult(d)?.components.exit).filter((x): x is number => x != null)
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
    })()
    const protoScores = trades.filter(t => { const dt = dateOfDay.get(t.trading_day_id); return dt != null && dt >= start && dt <= end })
      .map(t => protoLoss.get(t.id)).filter((x): x is number => x != null)
    const proto = protoScores.length ? (protoScores.reduce((a, b) => a + b, 0) / protoScores.length) * 100 : null
    console.log(`${m.padEnd(8)} ${pad(r0(period.exit), 4)} ${pad(r0(recap.exit), 5)} ${pad(r0(allTrades.score), 5)} | ${factorRow(allTrades.factors)} | ${pad(`${r0(proto)}(${protoScores.length})`, 9)} | ${r0(period.score)} / ${r0(oldPeriod.score)} (${r0(oldExitMean)})  [${period.scoredDays} scored days${recap.score !== period.score || recap.exit !== period.exit ? ' — RECAP DISAGREES' : ''}]`)
    if (period.exit !== allTrades.score && Math.round(period.exit ?? -1) !== Math.round(allTrades.score ?? -1)) {
      console.log(`         app factors (scored days only): ${factorRow(period.exitFactors)}`)
    }
  }

  // ── October daily ──
  const { start, end } = monthRange(DAILY)
  console.log(`\nDAILY ${DAILY} — avg = average $ risk going into the day (dashboard path / Recap-page path)`)
  console.log(`${'date'.padEnd(11)} ${pad('n', 3)} ${pad('avg$', 7)} ${pad('recap$', 7)} ${pad('Exit', 5)} | ${EXIT_FACTORS.map(k => pad(k, 9)).join(' ')} | TapeScore new / old (old Exit)`)
  let mismatches = 0
  for (const d of scored.filter(x => x.date >= start && x.date <= end && x.trade_count > 0)) {
    const hist = await loadRiskHistory(ro, d.date)
    const recapAvg = avgRiskBefore(d.date, hist)
    const dashAvg = avgByDate.get(d.date) ?? null
    const same = (dashAvg == null && recapAvg == null) || (dashAvg != null && recapAvg != null && Math.abs(dashAvg - recapAvg) < 0.005)
    if (!same) mismatches++
    // The Recap header path: the day's own inputs scored against the Recap average.
    const recapExit = viewOf(dayExitSums(d.exit, recapAvg)).score
    const v = viewOf(d.exit_sums)
    const old = oldResult(d)
    console.log(`${d.date.padEnd(11)} ${pad(String(d.trade_count), 3)} ${pad(dashAvg == null ? '—' : dashAvg.toFixed(0), 7)} ${pad(recapAvg == null ? '—' : recapAvg.toFixed(0), 7)} ${pad(r0(v.score), 5)} | ${factorRow(v.factors)} | ${r0(d.tapescore?.score)} / ${r0(old?.score)} (${r0(old?.components.exit)})${same && r0(recapExit) === r0(v.score) ? '' : '  <-- RECAP PAGE DIFFERS'}`)
  }
  const oct = scored.filter(x => x.date >= start && x.date <= end)
  const pNew = aggregateTapeScore(oct), pOld = aggregateTapeScore(oct.map(d => ({ tapescore: oldResult(d) })))
  console.log(`\n${DAILY} headline: TapeScore ${r0(pNew.score)} with Exit ${r0(pNew.exit)} (Risk ${r0(pNew.risk)}, Entry ${r0(pNew.entry)})  |  old: ${r0(pOld.score)} with Exit ${r0(pOld.exit)}`)
  // pOld.exit pools nothing (no exit_sums passed); print the old mean the old card showed.
  const oldExits = oct.map(d => oldResult(d)?.components.exit).filter((x): x is number => x != null)
  console.log(`old card Exit (mean of daily mfe_capture): ${r0(oldExits.length ? oldExits.reduce((a, b) => a + b, 0) / oldExits.length : null)}`)
  const unscoreable = scored.filter(d => d.tape?.basis === 'v15' && d.tape.entry === 0).map(d => d.date)
  console.log(`days with a ran-but-unscoreable execution read (Entry 0): ${unscoreable.length ? unscoreable.join(', ') : 'none'}`)
  console.log(`dashboard vs Recap-page average risk mismatches in ${DAILY}: ${mismatches}`)
  console.log(`writes attempted by the app code and refused here: ${blockedWrites}`)
}

main().catch(e => { console.error(e); process.exit(1) })
