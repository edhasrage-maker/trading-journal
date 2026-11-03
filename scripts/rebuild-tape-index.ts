/**
 * Rebuild a root's tick-tape index (`<ROOT>/index.json` in the private
 * `tick-tape` bucket) from the hourly chunks already stored there — the same
 * per-hour stats, RTH flag and 30-minute bars publishTapeDay writes. Only
 * downloads chunks; the index is the one object it writes.
 *
 * For an index that lost days its chunks still hold (NQ, 2026-11-02: a failed
 * index read let the feed start a blank one). Dates the current index already
 * lists are re-read too, and the dry run reports any that differ, so the run
 * checks itself against what the publisher wrote.
 *
 *   npx tsx scripts/rebuild-tape-index.ts NQ            # dry run
 *   npx tsx scripts/rebuild-tape-index.ts NQ --commit   # back up + save
 *
 * Reads .env.public-feed (the PUBLIC project's service-role key).
 */
import { readFileSync, mkdirSync, writeFileSync } from 'fs'
import { gunzipSync } from 'zlib'
import { createClient } from '@supabase/supabase-js'
import { supabaseTapeStore, loadTapeIndex, saveTapeIndex } from '../src/lib/orderflow/server/tape-store'
import { tapeChunkKey, decodeTape, tapeHourStat, tapeHalfHours, type TapeDay, type TapeIndex } from '../src/lib/orderflow/tape'
import { utcMsToSierraUs, type OfRoot } from '../src/lib/orderflow/ticks'
import { ptMidnight, ptDate, ptToUtcMs, utcToPtMs, PT_HOUR_MS } from '../src/lib/orderflow/pt-clock'

for (const l of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const URL = process.env.PUBLIC_SUPABASE_URL || ''
const KEY = process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY || ''
const PUBLIC_REF = 'dmutgkycrjudfejswvhg'
if (!URL.includes(PUBLIC_REF)) { console.error(`REFUSING TO RUN: .env.public-feed is not the public project (${PUBLIC_REF}).`); process.exit(1) }

const root = (process.argv[2] || '').toUpperCase() as OfRoot
if (root !== 'NQ' && root !== 'ES') { console.error('usage: rebuild-tape-index.ts NQ|ES [--commit]'); process.exit(1) }
const commit = process.argv.includes('--commit')

const sb = createClient(URL, KEY, { auth: { persistSession: false } })
const store = supabaseTapeStore(sb)
const usOfPt = (ptMs: number) => utcMsToSierraUs(ptToUtcMs(ptMs))

/** One date rebuilt from its chunks, the way publishTapeDay builds it hour by hour. */
async function rebuildDay(date: string): Promise<TapeDay | null> {
  const names = (await store.list!(`${root}/${date}`)).filter(n => /^\d{2}\.tst\.gz$/.test(n)).sort()
  const day0 = ptMidnight(date)
  const rthLo = usOfPt(day0 + 6.5 * PT_HOUR_MS), rthHi = usOfPt(day0 + 13 * PT_HOUR_MS)
  const day: TapeDay = { rth: false, hours: {}, b30: [] }
  for (const name of names) {
    const h = Number(name.slice(0, 2))
    const raw = await store.get(tapeChunkKey(root, date, h))
    if (!raw) throw new Error(`${date} ${name}: listed but could not be downloaded`)
    const t = decodeTape(gunzipSync(raw))
    if (!t.n) continue
    if (!day.rth && h >= 6 && h <= 12) for (let i = 0; i < t.n; i++) if (t.us[i] >= rthLo && t.us[i] < rthHi) { day.rth = true; break }
    day.b30 = [...day.b30!.filter(b => b[0] >> 1 !== h), ...tapeHalfHours(t, day0)].sort((a, b) => a[0] - b[0])
    day.hours[name.slice(0, 2)] = tapeHourStat(t)
  }
  return Object.keys(day.hours).length ? day : null
}

async function main() {
  console.log(`\n=== rebuild-tape-index ${root} (${commit ? 'COMMIT' : 'DRY RUN'}) ===`)
  let current: TapeIndex | null = null
  try { current = await loadTapeIndex(store, root) } catch (e) { console.log(`current index unreadable: ${(e as Error).message}`) }
  const listed = new Set(Object.keys(current?.days ?? {}))
  const dates = (await store.list!(root)).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort()
  console.log(`chunk folders: ${dates.length} (${dates[0]} … ${dates[dates.length - 1]}); current index lists ${listed.size}`)

  const days: Record<string, TapeDay> = {}
  let mismatched = 0
  // today's date is still being published while this reads, so it can't be compared
  const today = ptDate(utcToPtMs(Date.now()))
  for (const date of dates) {
    const d = await rebuildDay(date)
    if (!d) { console.log(`  ${date}: no trades in its chunks — skipped`); continue }
    days[date] = d
    if (listed.has(date) && date !== today && JSON.stringify(current!.days[date]) !== JSON.stringify(d)) {
      mismatched++
      console.log(`  ${date}: DIFFERS from the current index entry`)
    }
    process.stdout.write(`  ${date} ${Object.keys(d.hours).length}h${d.rth ? ' rth' : ''}${listed.has(date) ? ' (already listed)' : ''}\n`)
  }
  console.log(`rebuilt ${Object.keys(days).length} days; ${listed.size - mismatched}/${listed.size} already-listed days match exactly${listed.has(today) ? ` (today, ${today}, still being published: not compared)` : ''}`)
  if (!commit) { console.log('[dry] re-run with --commit to back up the current index and save the rebuilt one'); return }
  if (mismatched) { console.error('REFUSING TO SAVE: rebuilt entries disagree with the publisher\'s — investigate first'); process.exit(1) }

  // Back up, then re-read right before saving: the feed may have published new
  // hours while this ran, and its entries for those dates win.
  const raw = await store.get(`${root}/index.json`)
  mkdirSync('scripts/.repair-backups', { recursive: true })
  const backup = `scripts/.repair-backups/tape-index-${root}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  writeFileSync(backup, raw ? Buffer.from(raw) : '')
  const latest = await loadTapeIndex(store, root).catch(() => null)
  const merged: TapeIndex = { v: 1, root, updated: '', days: { ...days, ...(latest?.days ?? {}) } }
  merged.days = Object.fromEntries(Object.entries(merged.days).sort(([a], [b]) => a.localeCompare(b)))
  await saveTapeIndex(store, merged)
  console.log(`backup → ${backup}\nsaved ${root}/index.json with ${Object.keys(merged.days).length} days`)
}

main().catch(e => { console.error('FAILED:', e instanceof Error ? e.message : e); process.exit(1) })
