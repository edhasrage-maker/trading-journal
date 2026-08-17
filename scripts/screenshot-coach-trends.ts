/**
 * Screenshot coach — TRENDS. Cross-trade observations from the harness truth.
 *
 *   npx tsx scripts/screenshot-coach-trends.ts                # all trades + last 4 weeks
 *   npx tsx scripts/screenshot-coach-trends.ts --week=2026-08-11
 *   npx tsx scripts/screenshot-coach-trends.ts --min=6        # min trades for a bucket to speak
 *
 * The trader's ask (2026-08-17): "LVN trades aren't working", "10 of 12 this
 * week were in the middle of a profile", "your trades reach 1 ATR 10/15 times
 * but 2 ATR 5/15 — consider shortening TPs this week". Those are rollups over
 * the same context features the per-trade coach uses — no model, no image,
 * no variance. Each line is a count with its numbers; a bucket speaks only
 * when it has enough trades (--min), and the biggest gap speaks first.
 *
 * Reads evals/screenshot-coach/*-trades.jsonl. Writes trends.txt beside it.
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const argv = process.argv.slice(2)
const argVal = (n: string): string | null => argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? null
const DIR = join(process.cwd(), 'evals', 'screenshot-coach')
const MIN = Number(argVal('min') ?? '6') || 6
const WEEK = argVal('week')

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = any
const file = ['labelled-trades.jsonl', 'unlabelled-trades.jsonl'].map(f => join(DIR, f)).find(p => { try { readFileSync(p); return true } catch { return false } })!
const ALL: Rec[] = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── helpers ─────────────────────────────────────────────────────────────────
const mondayOf = (date: string): string => {
  const [y, m, d] = date.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); return dt.toISOString().slice(0, 10)
}
const pnl = (r: Rec): number => r.truth.exit.pnl ?? 0
const won = (r: Rec) => pnl(r) > 0
const pct = (k: number, n: number) => n ? `${Math.round((k / n) * 100)}%` : '—'
const usd = (v: number) => `${v < 0 ? '−' : '+'}$${Math.abs(Math.round(v)).toLocaleString()}`
const wr = (rs: Rec[]) => `${rs.filter(won).length}/${rs.length} won (${pct(rs.filter(won).length, rs.length)}), ${usd(rs.reduce((s, r) => s + pnl(r), 0))}`

interface Obs { weight: number; text: string }

function observe(rs: Rec[], label: string): Obs[] {
  const out: Obs[] = []
  const n = rs.length
  if (n < MIN) return [{ weight: 0, text: `${label}: only ${n} trade${n === 1 ? '' : 's'} with a screenshot — not enough to say anything.` }]
  const base = rs.filter(won).length / n

  // A bucket earns a line when it's big enough AND its win-rate sits well off
  // the base rate, or its dollar total is the largest drag/lift.
  const bucketLine = (name: string, buckets: Record<string, Rec[]>, phrase: (k: string, b: Rec[]) => string) => {
    for (const [k, b] of Object.entries(buckets)) {
      if (b.length < MIN) continue
      const w = b.filter(won).length / b.length
      const gap = w - base
      const share = b.length / n
      // weight: how much it moves the needle — size × gap, plus a bump for
      // dominance ("10 of 12 were mid-profile")
      const weight = Math.abs(gap) * b.length + (share >= 0.6 ? 3 : 0)
      if (Math.abs(gap) >= 0.15 || share >= 0.6) out.push({ weight, text: `${phrase(k, b)} — ${wr(b)}${Math.abs(gap) >= 0.15 ? ` vs ${pct(Math.round(base * n), n)} overall` : ''}.` })
    }
  }

  // 1. profile position at entry (session profile, falling back to prior day)
  const zone = (r: Rec): string | null => r.truth.context?.session_profile_at_entry?.zone ?? r.truth.context?.prior_day_profile?.zone ?? null
  const node = (r: Rec): string | null => r.truth.context?.session_profile_at_entry?.node ?? null
  const byZone: Record<string, Rec[]> = {}
  for (const r of rs) { const z = zone(r); if (z) (byZone[z] ??= []).push(r) }
  const mid = rs.filter(r => (zone(r) ?? '').startsWith('inside value'))
  const edge = rs.filter(r => ['at VAH', 'at VAL', 'at POC'].includes(zone(r) ?? ''))
  const outside = rs.filter(r => ['above value', 'below value'].includes(zone(r) ?? ''))
  if (mid.length + edge.length + outside.length >= MIN) {
    const grp = { 'inside value (middle of the profile)': mid, 'at an edge of value (VAH/VAL/POC)': edge, 'outside value': outside }
    bucketLine('zone', grp, k => `${k}: ${grp[k as keyof typeof grp].length} of ${n} entries`)
  }
  const byNode: Record<string, Rec[]> = {}
  for (const r of rs) { const v = node(r); if (v) (byNode[v] ??= []).push(r) }
  bucketLine('node', byNode, (k, b) => `entries in a ${k === 'HVN' ? 'high-volume node' : k === 'LVN' ? 'low-volume node' : 'average-volume spot'}: ${b.length} of ${n}`)

  // 2. swing structure
  const bySw: Record<string, Rec[]> = {}
  for (const r of rs) { const v = r.truth.context?.swing_structure_5m?.trade_is; if (v) (bySw[v] ??= []).push(r) }
  bucketLine('swing', bySw, (k, b) => `${k === 'with' ? 'with' : 'against'} the 5-minute swing structure (${k === 'with' ? 'HH+HL or LH+LL in your favour' : 'you faded a structure that had already made its swings'}): ${b.length} of ${n}`)

  // 3. attempts
  const first = rs.filter(r => (r.truth.context?.attempts_before?.count ?? 0) === 0)
  const repeat = rs.filter(r => (r.truth.context?.attempts_before?.count ?? 0) >= 1)
  const third = rs.filter(r => (r.truth.context?.attempts_before?.count ?? 0) >= 2)
  bucketLine('attempts', { first, repeat }, (k, b) => k === 'first' ? `first attempt at the idea: ${b.length} of ${n}` : `a repeat attempt at the same idea (same direction, same price area, same session): ${b.length} of ${n}`)
  if (third.length >= 3) out.push({ weight: third.length, text: `Third-or-later attempts at the same idea: ${third.length} — ${wr(third)}.` })

  // 4. volatility regime + IB regime
  const quiet = rs.filter(r => (r.truth.context?.atr_vs_typical ?? 1) < 0.8)
  const active = rs.filter(r => (r.truth.context?.atr_vs_typical ?? 1) > 1.2)
  bucketLine('atr', { quiet, active }, (k, b) => k === 'quiet' ? `entered when ATR was under 0.8x its typical (quiet tape): ${b.length} of ${n}` : `entered when ATR was over 1.2x typical (active tape): ${b.length} of ${n}`)
  const byIb: Record<string, Rec[]> = {}
  for (const r of rs) { const v = r.truth.context?.ib_regime; if (v) (byIb[v] ??= []).push(r) }
  bucketLine('ib', byIb, (k, b) => `IB regime ${k}: ${b.length} of ${n}`)

  // 5. level proximity
  const at = rs.filter(r => (r.truth.location.nearest?.dist_adr ?? 9) <= 0.05)
  const space = rs.filter(r => (r.truth.location.nearest?.dist_adr ?? 0) > 0.15 && r.truth.location.nearest)
  bucketLine('level', { at, space }, (k, b) => k === 'at' ? `entered right at a session level (≤0.05 ADR): ${b.length} of ${n}` : `entered in open space (>0.15 ADR from any level): ${b.length} of ${n}`)

  // 6. MFE reach — the TP question. Movers only (MFE data present).
  const movers = rs.filter(r => r.truth.exit.mfe_atr != null)
  if (movers.length >= MIN) {
    const reach = (k: number) => movers.filter(r => r.truth.exit.mfe_atr >= k).length
    const r1 = reach(1), r15 = reach(1.5), r2 = reach(2), r3 = reach(3)
    const withR = movers.filter(r => r.truth.exit.risk_pts && r.truth.exit.mfe_pts != null)
    const reachR = (k: number) => withR.filter(r => r.truth.exit.mfe_pts / r.truth.exit.risk_pts >= k).length
    let line = `Your trades reached 1 ATR ${r1} of ${movers.length} times, 1.5 ATR ${r15}, 2 ATR ${r2}, 3 ATR ${r3}`
    if (withR.length >= MIN) line += `; in R terms: 1R ${reachR(1)} of ${withR.length}, 2R ${reachR(2)}, 3R ${reachR(3)}`
    line += '.'
    // the TP suggestion, only when the drop-off is steep
    if (r1 >= MIN && r2 / r1 <= 0.5) line += ` The move dies between 1 and 2 ATR more often than not — a 2 ATR target is asking for something the tape delivers ${pct(r2, movers.length)} of the time.`
    if (withR.length >= MIN && reachR(2) / Math.max(1, reachR(1)) <= 0.5) line += ` Same in R: 2R came ${pct(reachR(2), withR.length)} of the time, 1R ${pct(reachR(1), withR.length)}.`
    out.push({ weight: 4, text: line })
    // capture on movers ≥ 1 ATR
    const big = movers.filter(r => r.truth.exit.mfe_atr >= 1 && r.truth.exit.capture_pct != null)
    if (big.length >= MIN) {
      const caps = big.map(r => r.truth.exit.capture_pct).sort((a, b) => a - b)
      const med = caps[Math.floor(caps.length / 2)]
      const zero = big.filter(r => r.truth.exit.capture_pct === 0).length
      out.push({ weight: 3, text: `On the ${big.length} trades that moved at least 1 ATR your way, median capture was ${med}%; ${zero} of them ended with 0% captured (the move came and you left with nothing).` })
    }
  }

  // 7. stopped, then it went
  const post = rs.filter(r => r.truth.exit.post_exit_against_atr != null && pnl(r) < 0)
  if (post.length >= MIN) {
    const went = post.filter(r => r.truth.exit.post_exit_against_atr >= 1)
    if (went.length / post.length >= 0.4) out.push({ weight: went.length, text: `Of ${post.length} losers with post-exit data, ${went.length} saw price go at least 1 ATR back your way within 15 minutes of the stop — the idea was often right and the stop was in the noise.` })
  }

  // 8. session phase
  const byPhase: Record<string, Rec[]> = {}
  for (const r of rs) { const v = r.truth.context?.session_phase; if (v) (byPhase[v] ??= []).push(r) }
  bucketLine('phase', byPhase, (k, b) => `trades taken in the ${k}: ${b.length} of ${n}`)

  return out.sort((a, b) => b.weight - a.weight)
}

// ── run ─────────────────────────────────────────────────────────────────────
const byWeek = new Map<string, Rec[]>()
for (const r of ALL) { const w = mondayOf(r.date); byWeek.set(w, [...(byWeek.get(w) ?? []), r]) }
const weeks = Array.from(byWeek.keys()).sort()
const target = WEEK ? [WEEK] : weeks.slice(-4)

const lines: string[] = [`SCREENSHOT COACH — TRENDS  (${ALL.length} trades with screenshots, ${weeks.length} weeks, min ${MIN} per bucket)`]
for (const w of target) {
  const rs = byWeek.get(w) ?? []
  lines.push(``, `WEEK OF ${w}  (${rs.length} trades, ${wr(rs)})`)
  for (const o of observe(rs, `week of ${w}`).slice(0, 6)) lines.push(`  • ${o.text}`)
}
lines.push(``, `ALL ${ALL.length} TRADES  (${wr(ALL)})`)
for (const o of observe(ALL, 'all trades').slice(0, 10)) lines.push(`  • ${o.text}`)

const text = lines.join('\n')
writeFileSync(join(DIR, 'trends.txt'), text + '\n', 'utf8')
console.log(text)
