/**
 * READ-ONLY diagnostic. Classifies every out-of-RTH trade (native + historical)
 * as mis-stamped vs genuine, by price-cross-checking entry_price against the
 * NQ .scid at the STORED time vs the SHIFTED time (stored wall-clock reread as
 * PT). A mis-stamped RTH trade's price only matches at the shifted (RTH) time;
 * a genuine overnight trade matches at its stored time. No writes.
 *
 *   npx tsx scripts/detect-tz-shift.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- read-only diagnostic */
import { readFileSync } from 'fs'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'
import { readScidBars } from '../src/lib/scid-reader.ts'
import { contractFileForRoot } from '../src/lib/futures-contracts.ts'

for (const l of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const DATA = 'D:\\SierraCharts\\Data'

// Front-month NQ by date, from the shared roll table (8 days before the
// quarterly 3rd-Friday expiry). Price is index-level so NQ stands in for MNQ.
function contractFor(dateStr: string): string | null {
  return contractFileForRoot('NQ', dateStr, DATA)
}

function ptComp(ms: number) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  const o: Record<string, string> = {}; for (const x of f.formatToParts(new Date(ms))) o[x.type] = x.value
  const h = o.hour === '24' ? 0 : parseInt(o.hour)
  return { y: +o.year, mo: +o.month, d: +o.day, h, mi: +o.minute, s: +o.second }
}
function ptWallToUtcMs(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  let guess = Date.UTC(y, mo - 1, d, h, mi, s)
  for (let i = 0; i < 3; i++) {
    const c = ptComp(guess)
    guess += Date.UTC(y, mo - 1, d, h, mi, s) - Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi, c.s)
  }
  return guess
}
function rangeAround(file: string, T: number): { lo: number; hi: number } | null {
  let r
  try { r = readScidBars(join(DATA, file), T - 120000, T + 120000, { priceDivisor: 100, bucketMs: 60000 }) }
  catch { return null }
  if (!r.bars.length) return null
  let lo = Infinity, hi = -Infinity
  for (const b of r.bars) { if (b.low < lo) lo = b.low; if (b.high > hi) hi = b.high }
  return { lo, hi }
}
const inRange = (price: number, rng: { lo: number; hi: number } | null, tol = 3) => !!rng && price >= rng.lo - tol && price <= rng.hi + tol

async function load(table: string, tsCol: string) {
  const PAGE = 1000; const out: { id: string; ts: string; price: number; table: string }[] = []
  for (let p = 0; p < 50; p++) {
    const { data } = await sb.from(table).select(`id, ${tsCol}, entry_price`).order(tsCol, { ascending: true }).range(p * PAGE, p * PAGE + PAGE - 1)
    if (!data || !data.length) break
    for (const r of data) if (r[tsCol] && r.entry_price != null) out.push({ id: r.id, ts: r[tsCol], price: Number(r.entry_price), table })
    if (data.length < PAGE) break
  }
  return out
}

;(async () => {
  const rows = [...await load('trades', 'entry_time'), ...await load('historical_trades', 'open_at')]
  const cat = { mis: [] as any[], genuine: [] as any[], ambiguous: [] as any[], unmatched: [] as any[] }
  const shiftHrs: Record<number, number> = {}
  let outOfRth = 0
  for (const r of rows) {
    const stored = Date.parse(r.ts)
    const pc = ptComp(stored)
    if (pc.h >= 6 && pc.h < 13) continue   // RTH-stamped → fine, skip
    outOfRth++
    const sd = new Date(stored)
    const shifted = ptWallToUtcMs(sd.getUTCFullYear(), sd.getUTCMonth() + 1, sd.getUTCDate(), sd.getUTCHours(), sd.getUTCMinutes(), sd.getUTCSeconds())
    const file = contractFor(r.ts.slice(0, 10))
    if (!file) { cat.unmatched.push({ ...r, reason: 'no contract' }); continue }
    const mStored = inRange(r.price, rangeAround(file, stored))
    const mShifted = inRange(r.price, rangeAround(file, shifted))
    const rec = { ...r, storedPT: `${String(pc.h).padStart(2, '0')}:${String(pc.mi).padStart(2, '0')}`, shiftedPT: `${String(ptComp(shifted).h).padStart(2, '0')}:${String(ptComp(shifted).mi).padStart(2, '0')}`, file }
    if (mShifted && !mStored) { cat.mis.push(rec); const dh = Math.round((shifted - stored) / 3.6e6); shiftHrs[dh] = (shiftHrs[dh] || 0) + 1 }
    else if (mStored && !mShifted) cat.genuine.push(rec)
    else if (mStored && mShifted) cat.ambiguous.push(rec)
    else cat.unmatched.push(rec)
  }
  console.log(`\nout-of-RTH trades examined: ${outOfRth}  (of ${rows.length} total timed)`)
  console.log(`  MIS-STAMPED (price matches shifted/RTH time): ${cat.mis.length}`)
  console.log(`  GENUINE     (price matches stored time):      ${cat.genuine.length}`)
  console.log(`  AMBIGUOUS   (matches both):                   ${cat.ambiguous.length}`)
  console.log(`  UNMATCHED   (no bar / no price match):        ${cat.unmatched.length}`)
  console.log(`  shift hours among mis-stamped:`, JSON.stringify(shiftHrs))
  const tally = (a: any[]) => { const t: Record<string, number> = {}; for (const x of a) t[x.table] = (t[x.table] || 0) + 1; return JSON.stringify(t) }
  console.log(`  by table — mis: ${tally(cat.mis)}  genuine: ${tally(cat.genuine)}  unmatched: ${tally(cat.unmatched)}`)
  console.log('\nGENUINE samples (should look like real overnight trades):')
  for (const r of cat.genuine.slice(0, 8)) console.log(`  ${r.ts} storedPT=${r.storedPT} price=${r.price} (${r.table})`)
  console.log('\nMIS-STAMPED samples (stored overnight → shifts to RTH):')
  for (const r of cat.mis.slice(0, 8)) console.log(`  ${r.ts} storedPT=${r.storedPT} → shiftedPT=${r.shiftedPT} price=${r.price} (${r.table})`)
  console.log('\nUNMATCHED samples:')
  for (const r of cat.unmatched.slice(0, 6)) console.log(`  ${r.ts} price=${r.price} file=${r.file ?? '—'} (${r.table})`)
})()
