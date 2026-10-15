/**
 * The founder's runner rules on their real trades — READ ONLY.
 *
 *   npx tsx scripts/runner-rules-report.ts [--be 2] [--from 2026-10-14]
 *
 * Reads the founder's trades and days from the PUBLIC project (service key from
 * .env.public-feed; nothing is written) and prints:
 *   - every runner since May with T1 / T2 / T3 and the reasons, under the
 *     study's mechanics (60% at TP1; runner out only at breakeven within --be
 *     ticks, 4×ATR ±0.25, or 13:00 PT), next to the trader's own TP2 tag
 *   - a second, independent reading of the same fills (the prototype's code,
 *     re-stated below) and where the two disagree
 *   - the TapeScore days with the rules counting from --from vs without them
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { evaluateRunnerRules, newRunnerRule, type RunnerRuleConfig } from '../src/lib/runner-rules.ts'
import { computeDayStats, scoreDayRollups, ROLLUP_TRADE_COLS, type DayForStats, type TradeForStats } from '../src/lib/day-stats.ts'
import { FOUNDER_ENTRY_RULES } from '../src/lib/entry-rules.ts'
import { resolveRubric, includeFlowScoreInEntry, type ScoringProfile } from '../src/lib/scoring-profile.ts'
import { normalizeAtrStopTarget } from '../src/lib/exit-rollup.ts'

const arg = (k: string, d: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d)
const BE = Number(arg('--be', '2'))
const FROM = arg('--from', '2026-10-14')
const rulesFrom = (from: string): RunnerRuleConfig[] => [
  newRunnerRule('scale_out', 'T1', from, 't1'),
  { ...newRunnerRule('runner_exit', 'T2', from, 't2'), be_ticks: BE },
  newRunnerRule('be_after_tp1', 'T3', from, 't3'),
]
const ptDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
const ptHm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit' })

/** The prototype's reading (scratchpad runner_rules_check.cjs), re-stated independently. */
function prototype(t: { direction: string | null; entry_price: number | null; tp1_price: number | null; entry_atr_1m: number | null; exits_json: unknown }) {
  const s = t.direction === 'long' ? 1 : -1
  if (t.tp1_price == null || t.entry_price == null || !t.direction || (t.tp1_price - t.entry_price) * s <= 0) return null
  const legs = (Array.isArray(t.exits_json) ? t.exits_json : []).map((l: { time: string; price: number; qty: number }) => ({ t: Date.parse(l.time), iso: l.time, px: Number(l.price), q: Number(l.qty) }))
    .filter(l => Number.isFinite(l.t) && Number.isFinite(l.px) && l.q > 0).sort((a, b) => a.t - b.t)
  if (!legs.length) return null
  const groups: typeof legs[] = []
  for (const l of legs) { const g = groups.at(-1); if (g && l.t - g.at(-1)!.t <= 30_000) g.push(l); else groups.push([l]) }
  const gi = groups.findIndex(g => g.some(l => (l.px - t.tp1_price!) * s >= -1e-9))
  if (gi < 0) return null
  const runner = groups.slice(gi + 1).flat()
  if (!runner.length) return null
  const Q = legs.reduce((a, l) => a + l.q, 0)
  const A = groups[gi].reduce((a, l) => a + l.q, 0) / Q >= 0.6 - 1e-9
  const atr = t.entry_atr_1m
  let unknown = false
  const ok = runner.every(l => {
    const pts = (l.px - t.entry_price!) * s
    if (Math.abs(pts) <= BE * 0.25 + 1e-9) return true
    const hm = ptHm(l.iso)
    if (hm >= '13:00' && hm < '13:15') return true
    if (!atr) { unknown = true; return true }
    return pts / atr >= 3.75 - 1e-9
  })
  return { A, B: unknown && ok ? null : ok }
}

async function main() {
  const env: Record<string, string> = {}
  for (const l of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '') }
  const sb = createClient(env.PUBLIC_SUPABASE_URL, env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY)
  const { data: u } = await sb.auth.admin.listUsers({ perPage: 200 })
  const uid = u.users.find(x => x.email === 'edhasrage@gmail.com')?.id
  if (!uid) throw new Error('founder not found')

  // ── every runner, all history on the site ──
  const all: Record<string, unknown>[] = []
  for (let p = 0; ; p++) {
    const { data, error } = await sb.from('trades').select('id, entry_time, symbol, direction, quantity, entry_price, tp1_price, pnl, exits_json, entry_atr_1m, tags_json')
      .eq('user_id', uid).order('entry_time').order('id').range(p * 1000, p * 1000 + 999)
    if (error) throw new Error(error.message)
    all.push(...data); if (data.length < 1000) break
  }
  const everyRunner = rulesFrom('1970-01-01')
  let t1p = 0, t1f = 0, t2p = 0, t2f = 0, t2u = 0, agree = 0, compared = 0
  const disagreements: string[] = []
  console.log(`Runners on the site (${all.length} trades, ${ptDate(String(all[0]?.entry_time))} → ${ptDate(String(all.at(-1)?.entry_time))}), breakeven window ${BE} ticks:\n`)
  for (const t of all as never[]) {
    const tr = t as { id: string; entry_time: string; symbol: string; direction: string; quantity: number; pnl: number; tags_json: { trade_management?: string[] } | null }
    const res = evaluateRunnerRules(everyRunner, t)
    const proto = prototype(t)
    if ((res == null) !== (proto == null)) { disagreements.push(`${tr.entry_time} judged: site ${res ? 'runner' : 'not'} vs prototype ${proto ? 'runner' : 'not'}`); continue }
    if (!res || !proto) continue
    compared++
    const [a, b] = [res[0].status, res[1].status]
    if ((a === 'pass') === proto.A && (proto.B == null ? b === 'unknown' : (b === 'pass') === proto.B)) agree++
    else disagreements.push(`${tr.entry_time} site T1 ${a} T2 ${b} vs prototype A ${proto.A} B ${proto.B}`)
    if (a === 'pass') t1p++; else t1f++
    if (b === 'pass') t2p++; else if (b === 'fail') t2f++; else t2u++
    const tag = (tr.tags_json?.trade_management ?? []).find(x => /^tp2\b/i.test(String(x).trim())) ?? ''
    console.log(`${ptDate(tr.entry_time)} ${ptHm(tr.entry_time)} ${tr.symbol.slice(0, 3)} ${tr.direction.padEnd(5)} ${String(Math.round(tr.pnl)).padStart(5)}  T1 ${a.padEnd(4)} T2 ${b.padEnd(7)} ${tag ? `[${tag}]` : ''}\n      ${res[1].reason}`)
  }
  console.log(`\nT1 scale-out: pass ${t1p} / fail ${t1f} · T2 runner exit: pass ${t2p} / fail ${t2f} / unknown ${t2u} · T3 unknown on all`)
  console.log(`Site engine vs independent prototype: ${agree} of ${compared} runners agree on T1 and T2${disagreements.length ? `\n  ${disagreements.join('\n  ')}` : ''}`)

  // ── TapeScore days: runner rules from FROM vs none (entry rules on in both, as live) ──
  const { data: prof } = await sb.from('trader_profile').select('scoring_profile_json').eq('user_id', uid).maybeSingle()
  const sp = (prof?.scoring_profile_json ?? null) as ScoringProfile | null
  const atrStopTarget = normalizeAtrStopTarget(resolveRubric(sp).atrStopTarget)
  const { data: days } = await sb.from('trading_days').select('id, date, eod_pnl, day_type, day_types, ai_analysis_json, eod_ai_analysis_json').eq('user_id', uid).gte('date', '2026-07-01').order('date')
  const ids = (days ?? []).map(d => d.id)
  const trades: (TradeForStats & { trading_day_id: string })[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb.from('trades').select(`trading_day_id, ${ROLLUP_TRADE_COLS}`).in('trading_day_id', ids.slice(i, i + 100)).order('entry_time').order('id')
    if (error) throw new Error(error.message)
    trades.push(...(data as never[]))
  }
  const byDay = new Map<string, typeof trades>()
  for (const t of trades) { if (!byDay.has(t.trading_day_id)) byDay.set(t.trading_day_id, []); byDay.get(t.trading_day_id)!.push(t) }
  const roll = (runnerRules: RunnerRuleConfig[]) => scoreDayRollups((days ?? []).map(d => computeDayStats(d as unknown as DayForStats, byDay.get(d.id) ?? [], null,
    { atrStopTarget, entryRules: FOUNDER_ENTRY_RULES, runnerRules })), [], { includeFlow: includeFlowScoreInEntry(sp), runnerOwn: runnerRules.length > 0 })
  const off = roll([]), on = roll(rulesFrom(FROM))
  let same = 0, before = 0
  console.log(`\nTapeScore with runner rules counting from ${FROM} (entry rules on in both):`)
  for (let i = 0; i < (days ?? []).length; i++) {
    const d = days![i]
    const a = off[i].tapescore, b = on[i].tapescore
    if (d.date < FROM) {
      // the numbers, part by part — the "your rules" display flag differs by design
      const nums = (x: typeof a) => JSON.stringify(x ? { score: x.score, c: x.components, risk: x.parts?.risk, entry: x.parts?.entry, exit: x.parts?.exit } : null)
      before++; if (nums(a) === nums(b)) same++; else console.log(`  CHANGED ${d.date}: ${nums(a)} vs ${nums(b)}`)
      continue
    }
    const ra = a?.parts?.exit.runner, rb = b?.parts?.exit.runner
    console.log(`  ${d.date}  TapeScore ${a?.score ?? '—'} → ${b?.score ?? '—'} · Exit ${a?.components.exit ?? '—'} → ${b?.components.exit ?? '—'} · Runner part ${ra?.score != null ? Math.round(ra.score) : '—'} (${ra?.n ?? 0}) → ${rb?.score != null ? Math.round(rb.score) : '—'} (${rb?.n ?? 0})`)
  }
  console.log(`Days before ${FROM}: ${same} of ${before} identical with and without the runner rules`)
}

main().catch(e => { console.error(e); process.exit(1) })
