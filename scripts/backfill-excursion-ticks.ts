/**
 * Recompute trades.high_during_position / low_during_position from SCID TICKS
 * within each trade's EXACT [entry, exit] window — replacing the padded 1-minute
 * bar excursion that inflated MFE (and so deflated capture) for short-duration
 * scalps. See the audit in the Pt 11 thread: a 73s trade read $120 of "MFE" from
 * bars when the true tick excursion inside the hold window was ~$3.
 *
 * Method — basis-clean: the excursion RANGE comes from the NQ front-month tick
 * series (index proxy for MNQ), anchored to the trade's own entry_price so any
 * MNQ/NQ or calendar-roll basis cancels:
 *   entryTick = first NQ tick at/after entry
 *   high_during_position = entry_price + (max(ticks) − entryTick)
 *   low_during_position  = entry_price + (min(ticks) − entryTick)
 * captureComponents clamps mfe_dollars_per_leg to the high/low ceiling, so fixing
 * the extremes fixes capture app-wide while preserving the per-leg scale-out value
 * where it sits below the (now-correct) ceiling.
 *
 * NOTE: this script rewrites mfe_dollars_per_leg TOO — an older header claimed it
 * was left alone, which was wrong. The two changes move capture in OPPOSITE
 * directions and should be judged separately. Measured on the owner's 5,634
 * NQ-family trades:
 *     stored high/low + stored per-leg  ->  68.0%
 *     TICK   high/low + stored per-leg  ->  74.3%   (excursion fix alone)
 *     TICK   high/low + TICK   per-leg  ->  50.5%   (what --commit writes)
 * The excursion fix RAISES capture, as it must when an inflated MFE denominator
 * is corrected. The 24-point drop is entirely the per-leg rewrite. Use
 * --skip-per-leg to apply only the excursion half.
 *
 * Covers NQ-family only (NQ/MNQ) — the only root with 2026 .scid coverage.
 * ES/MES and unrecognized symbols are skipped and counted.
 *
 * Targets the PUBLIC/cloud DB. DRY RUN by default; prints the before/after
 * capture for the scoped set so the change is visible before it's written.
 *
 *   npx tsx scripts/backfill-excursion-ticks.ts --user you@x.com          # dry, one account
 *   npx tsx scripts/backfill-excursion-ticks.ts --user you@x.com --commit # write, one account
 *   npx tsx scripts/backfill-excursion-ticks.ts --commit                  # write, ALL users
 *   flags: --limit=N (cap per table)
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { makeTickReader } from '../src/lib/scid-reader.ts'
import { avgCaptureRatio, type ExitLeg } from '../src/lib/analytics.ts'
import { symbolToMultiplier } from '../src/lib/futures-symbols.ts'

for (const l of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(process.env.PUBLIC_SUPABASE_URL!, process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY!)
const COMMIT = process.argv.includes('--commit')
// Apply ONLY the high/low excursion correction, leaving mfe_dollars_per_leg
// untouched. The two are independent fixes bundled in one pass and they push
// capture opposite ways; this lets the verified half land on its own.
const SKIP_PER_LEG = process.argv.includes('--skip-per-leg')
const userArg = process.argv.find(a => a.startsWith('--user='))?.split('=')[1]
  ?? (process.argv.includes('--user') ? process.argv[process.argv.indexOf('--user') + 1] : undefined)
const LIMIT = (() => { const a = process.argv.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : Infinity })()
const DATA = 'D:/SierraCharts/Data'

// NQ front-month roll table (each file is front-month in [prevRoll, thisRoll)).
// Same table as scripts/backfill-structure-regime.ts.
const CONTRACTS: { roll: string; file: string }[] = [
  { roll: '2023-03-09', file: 'NQH3.CME.scid' }, { roll: '2023-06-08', file: 'NQM3.CME.scid' },
  { roll: '2023-09-07', file: 'NQU3.CME.scid' }, { roll: '2023-12-07', file: 'NQZ3.CME.scid' },
  { roll: '2024-03-07', file: 'NQH4.CME.scid' }, { roll: '2024-06-13', file: 'NQM4.CME.scid' },
  { roll: '2024-09-12', file: 'NQU4.CME.scid' }, { roll: '2024-12-12', file: 'NQZ4.CME.scid' },
  { roll: '2025-03-13', file: 'NQH5.CME.scid' }, { roll: '2025-06-12', file: 'NQM5.CME.scid' },
  { roll: '2025-09-11', file: 'NQU5.CME.scid' }, { roll: '2025-12-11', file: 'NQz5.CME.scid' },
  { roll: '2026-03-12', file: 'NQH6.CME.scid' }, { roll: '2026-06-11', file: 'NQM6.CME.scid' },
  { roll: '2026-09-11', file: 'NQU6.CME.scid' },
]
function contractFor(dateISO: string): string | null {
  for (const c of CONTRACTS) if (dateISO < c.roll) return c.file
  return null
}
const isNQ = (sym: string | null | undefined) => !!sym && /(^|[^A-Z])M?NQ/i.test(sym)

const readers = new Map<string, ReturnType<typeof makeTickReader>>()
function reader(file: string) {
  let r = readers.get(file)
  if (!r) { r = makeTickReader(`${DATA}/${file}`); readers.set(file, r) }
  return r
}

interface Row {
  id: string; entry_price: number | null; quantity: number | null; symbol: string | null
  direction: string | null; startMs: number | null; endMs: number | null; date: string
  high_during_position: number | null; low_during_position: number | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any
}

/**
 * Tick-true excursion for one trade, all off the SAME NQ tick series so basis
 * cancels:
 *  - high/low_during_position: range over [entry, exit], anchored to entry_price.
 *  - mfeLeg (mfe_dollars_per_leg): the scaling-aware favorable-$ ceiling. For a
 *    multi-leg trade, each leg's peak is measured in ITS window
 *    [prevLegExit, legExit] off the entry baseline × that leg's qty (ports
 *    perLegMaxDollars to ticks). Single-exit / no legs → full-qty × peak.
 */
function excursion(r: Row): { high: number; low: number; mfeLeg: number | null } | null {
  if (r.entry_price == null || r.startMs == null || r.endMs == null || r.endMs <= r.startMs) return null
  if (!isNQ(r.symbol)) return null
  const file = contractFor(r.date); if (!file) return null
  const rdr = reader(file)
  let ticks: number[]
  try { ticks = rdr.read(r.startMs, r.endMs + 1000) } catch { return null }
  if (ticks.length < 2) return null
  const entryTick = ticks[0]
  let mx = -Infinity, mn = Infinity
  for (const p of ticks) { if (p > mx) mx = p; if (p < mn) mn = p }
  const high = r.entry_price + (mx - entryTick)
  const low = r.entry_price + (mn - entryTick)

  // Per-leg scaling-aware $ ceiling. entryTick is the shared NQ baseline.
  const mult = symbolToMultiplier(r.symbol ?? '')
  const isLong = r.direction === 'long'
  const favPts = (peak: number) => Math.max(0, isLong ? (peak - entryTick) : (entryTick - peak))
  const legs = Array.isArray(r.exits_json) ? (r.exits_json as ExitLeg[]).filter(l => l && l.time && l.qty).slice() : []
  let mfeLeg: number | null = null
  if (legs.length > 1) {
    legs.sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
    let sum = 0, ok = true
    for (const leg of legs) {
      const legEnd = Date.parse(leg.time)
      if (!Number.isFinite(legEnd) || legEnd <= r.startMs) continue
      // Each leg held from ENTRY to its own exit, so its favorable-$ ceiling is
      // the peak over [entry, legExit] — NOT [prevLegExit, legExit], which
      // under-counts a later leg when the peak came early and pushes capture
      // impossibly past 100%. A leg that exited early is still capped at ITS
      // exit time, so an earlier leg can't claim a later peak.
      let lt: number[]
      try { lt = rdr.read(r.startMs, legEnd + 1000) } catch { ok = false; break }
      if (lt.length === 0) continue
      // Loop, not Math.max(...lt) — a leg window can hold tens of thousands of
      // ticks and spreading them overflows the call stack.
      let peak = isLong ? -Infinity : Infinity
      for (const p of lt) { if (isLong ? p > peak : p < peak) peak = p }
      sum += favPts(peak) * mult * leg.qty
    }
    if (ok && sum > 0) mfeLeg = Math.round(sum * 100) / 100
  } else {
    // Single-exit / historical: full-position ceiling from the window peak.
    const qty = r.quantity ?? (legs[0]?.qty ?? 0)
    const peak = isLong ? mx : mn
    const v = favPts(peak) * mult * (qty || 0)
    if (v > 0) mfeLeg = Math.round(v * 100) / 100
  }
  return { high, low, mfeLeg }
}

async function resolveUserId(email: string): Promise<string | undefined> {
  const { data } = await sb.auth.admin.listUsers()
  return (data?.users ?? []).find((u: { email?: string; id: string }) => u.email === email)?.id
}

async function processTable(table: 'historical_trades' | 'trades', uid: string | undefined) {
  const isHist = table === 'historical_trades'
  // historical_trades has neither exits_json nor stop_price (captureComponents
  // treats both as optional → undefined is fine).
  const cols = isHist
    ? 'id, trade_date, open_at, close_at, side, entry_price, quantity, symbol, net_pnl, high_during_position, low_during_position, mfe_dollars_per_leg, entry_atr_1m'
    : 'id, entry_time, exit_time, direction, entry_price, quantity, symbol, pnl, high_during_position, low_during_position, mfe_dollars_per_leg, exits_json, entry_atr_1m, stop_price'
  const rows: Row[] = []
  for (let p = 0; p < 60; p++) {
    let q = sb.from(table).select(cols).order('id', { ascending: true }).range(p * 1000, p * 1000 + 999)
    if (uid) q = q.eq('user_id', uid)
    const { data, error } = await q
    if (error) { console.error(`  ${table} fetch failed:`, error.message); break }
    if (!data || data.length === 0) break
    for (const d of data) {
      const startMs = Date.parse(isHist ? d.open_at : d.entry_time)
      const endMs = Date.parse(isHist ? d.close_at : d.exit_time)
      rows.push({
        ...d,
        direction: isHist ? d.side : d.direction,
        startMs: Number.isFinite(startMs) ? startMs : null,
        endMs: Number.isFinite(endMs) ? endMs : null,
        date: isHist ? d.trade_date : String(d.entry_time ?? '').slice(0, 10),
        pnl: isHist ? d.net_pnl : d.pnl,
      })
    }
    if (data.length < 1000) break
  }

  // Build before/after capture over the SAME rows (using the real captureComponents
  // basis: swap only high/low_during_position). Rows we can't recompute keep old.
  const before: Row[] = [], after: Row[] = []
  let written = 0, recomputed = 0, skipped = 0, deltaSum = 0, legFixed = 0
  const updates: { id: string; high: number; low: number; mfeLeg: number | null }[] = []
  for (const r of rows) {
    if (recomputed + skipped >= LIMIT) break
    const ex = excursion(r)
    before.push(r)
    if (!ex) { skipped++; after.push(r); continue }
    recomputed++
    if (r.high_during_position != null) deltaSum += Math.abs((r.high_during_position) - ex.high)
    if (ex.mfeLeg != null) legFixed++
    // The after-row carries the new mfe_dollars_per_leg too, so the before/after
    // capture reflects BOTH fixes (captureComponents prefers mfe_dollars_per_leg,
    // clamped to the new high/low ceiling).
    after.push({
      ...r,
      high_during_position: ex.high,
      low_during_position: ex.low,
      mfe_dollars_per_leg: SKIP_PER_LEG ? r.mfe_dollars_per_leg : (ex.mfeLeg ?? r.mfe_dollars_per_leg),
    })
    updates.push({ id: r.id, high: ex.high, low: ex.low, mfeLeg: SKIP_PER_LEG ? null : ex.mfeLeg })
  }

  const capBefore = avgCaptureRatio(before as never)
  const capAfter = avgCaptureRatio(after as never)
  console.log(`\n[${table}] rows=${rows.length} recomputed=${recomputed} skipped(non-NQ/no-cover)=${skipped}`)
  console.log(`  capture: ${capBefore.avg == null ? 'n/a' : (capBefore.avg * 100).toFixed(1) + '%'} (n=${capBefore.count})  →  ${capAfter.avg == null ? 'n/a' : (capAfter.avg * 100).toFixed(1) + '%'} (n=${capAfter.count})`)
  console.log(`  avg |old high − new high|: ${recomputed ? (deltaSum / recomputed).toFixed(1) : 'n/a'} pts | mfe_dollars_per_leg: ${SKIP_PER_LEG ? `${legFixed} computed, NOT written (--skip-per-leg)` : `${legFixed} recomputed`}`)

  if (COMMIT) {
    for (let i = 0; i < updates.length; i += 200) {
      const batch = updates.slice(i, i + 200)
      await Promise.all(batch.map(u => {
        const patch: Record<string, number> = { high_during_position: u.high, low_during_position: u.low }
        if (u.mfeLeg != null) patch.mfe_dollars_per_leg = u.mfeLeg
        // Scope the WRITE by user too, not just the read. Ids are unique so this
        // is belt-and-braces, but the public project is multi-tenant and this
        // key bypasses RLS — an unscoped update is the shape of the mistake.
        let q = sb.from(table).update(patch).eq('id', u.id)
        if (uid) q = q.eq('user_id', uid)
        return q
      }))
      written += batch.length
      if (written % 1000 === 0) console.log(`    …${written} written`)
    }
    console.log(`  WROTE ${written} rows.`)
  }
}

async function main() {
  let uid: string | undefined
  if (userArg) { uid = await resolveUserId(userArg); if (!uid) { console.error(`user not found: ${userArg}`); process.exit(1) } }
  console.log(`Target: PUBLIC DB | ${userArg ? `user ${userArg}` : 'ALL USERS'} | ${COMMIT ? 'COMMIT' : 'DRY RUN'}${LIMIT !== Infinity ? ` | limit ${LIMIT}` : ''}`)
  await processTable('historical_trades', uid)
  await processTable('trades', uid)
  for (const r of readers.values()) r.close()
  console.log(COMMIT ? '\nDone (written).' : '\nDRY RUN — nothing written. Add --commit to persist.')
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
