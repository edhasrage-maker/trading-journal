/**
 * Public bar feed — LOCAL ingest agent (runs on YOUR machine, never the cloud).
 *
 * Reads today's NQ + ES 1-minute bars from the local Sierra `.scid` files and
 * upserts them into the PUBLIC project's SHARED `ohlcv_bars` table, keyed by the
 * mini price-series root (NQ, ES). Every tester's LiveChart then gets candles
 * with zero upload on their side — micros (MNQ/MES) resolve to the same series
 * via chartSeriesRoot(), so it lines up regardless of how their broker names the
 * contract.
 *
 * SAFETY
 *   The PUBLIC project's service_role key lives ONLY on this machine, in a local
 *   `.env.public-feed` file (matched by `.env*` in .gitignore — never committed,
 *   never on Vercel). The hosted web app uses only the anon key; this is a
 *   separate local process that writes public market data (no user data).
 *
 * SETUP (once)
 *   1. Create `.env.public-feed` in the repo root:
 *        PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
 *        PUBLIC_SUPABASE_SERVICE_ROLE_KEY=<public project's service_role key>
 *      (Supabase → API Keys → "Legacy anon, service_role" tab → service_role.)
 *   2. Keep NQ + ES charts live in Sierra so their `.scid` files stay current.
 *      Override the folder with SIERRA_DATA_DIR if yours isn't D:\SierraCharts\Data.
 *
 * RUN
 *   npx tsx scripts/public-bar-feed.ts             # today (PT)
 *   npx tsx scripts/public-bar-feed.ts 2026-06-29  # a specific date (backfill)
 *
 * SCHEDULE
 *   Task Scheduler, every ~3 min during your session — same cadence as BarWatcher.
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'
import { importScidDay } from '../src/lib/import-scid-day'
import { todayPT } from '../src/lib/pt-time'

// Local .scid → shared root symbol. Add more pairs here to feed more markets
// (the chart resolves any micro/mini/dated contract to these roots).
const FEEDS: Array<{ scidFile: string; root: string }> = [
  { scidFile: 'NQU6.CME.scid', root: 'NQ' },
  { scidFile: 'ESU6.CME.scid', root: 'ES' },
]

/** Load PUBLIC-project creds from the local, gitignored `.env.public-feed`. */
function loadEnv(): void {
  const path = join(process.cwd(), '.env.public-feed')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
}

async function main() {
  loadEnv()
  const url = process.env.PUBLIC_SUPABASE_URL
  const key = process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error(
      'Missing PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_SERVICE_ROLE_KEY.\n' +
      'Put them in .env.public-feed (repo root) or the environment.',
    )
    process.exit(1)
  }

  const sb = createClient(url, key, { auth: { persistSession: false } })
  const date = process.argv[2] || todayPT()
  console.log(`[public-bar-feed] ${date} → ${url.replace(/^https?:\/\//, '')}`)

  let anyOk = false
  for (const f of FEEDS) {
    const out = await importScidDay(sb, {
      scidFile: f.scidFile,
      storeAs: f.root,
      date,
      priceDivisor: 100,
      writeHistory: false,
    })
    if (out.ok) {
      anyOk = true
      console.log(`  ${f.root.padEnd(4)} upserted ${out.result.upserted} bars  (${f.scidFile})`)
    } else {
      console.error(`  ${f.root.padEnd(4)} ${out.error}${out.hint ? `  — ${out.hint}` : ''}`)
    }
  }
  process.exit(anyOk ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
