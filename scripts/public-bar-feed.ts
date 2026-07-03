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
 *        PUBLIC_SUPABASE_SERVICE_ROLE_KEY=<public project's SECRET key>
 *      Supabase → API Keys → create a Secret key (sb_secret_…). The old
 *      "Legacy anon, service_role" JWTs are disabled on this project, so use a
 *      new secret key here — it works the same way server-side.
 *   2. Keep NQ + ES charts live in Sierra so their `.scid` files stay current.
 *      Override the folder with SIERRA_DATA_DIR if yours isn't D:\SierraCharts\Data.
 *
 * RUN
 *   npx tsx scripts/public-bar-feed.ts             # today (PT) — the scheduled run
 *   npx tsx scripts/public-bar-feed.ts 2026-06-29  # a specific date
 *   npx tsx scripts/public-bar-feed.ts --days 8    # last 8 days — one-time, so the
 *                                                  # chart's session levels have lookback
 *
 * SCHEDULE
 *   Task Scheduler, every ~3 min during your session — same cadence as BarWatcher.
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'
import { importScidDay } from '../src/lib/import-scid-day'
import { todayPT } from '../src/lib/pt-time'
import { contractFileForDate } from '../src/lib/nq-front-month'

// Local .scid → shared root symbol, resolved PER DATE. NQ uses the continuous
// front-month roll table (contractFileForDate) so a trade at ANY date reads the
// contract that was actually front-month then — that's what makes MFE/MAE-from-
// bars work across history, not just the current contract. All bars store under
// 'NQ' (the chartSeriesRoot key micros/dated contracts resolve to). ES has no
// roll table yet, so it stays on its front contract (single-contract coverage).
function feedsForDate(date: string): Array<{ scidFile: string; root: string }> {
  const feeds: Array<{ scidFile: string; root: string }> = []
  const nqFile = contractFileForDate(date)   // e.g. 2026-03-15 → NQM6.CME.scid
  if (nqFile) feeds.push({ scidFile: nqFile, root: 'NQ' })
  feeds.push({ scidFile: 'ESU6.CME.scid', root: 'ES' })
  return feeds
}

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

  // Which dates to feed:
  //   (no args)          → today only  (the frequent 3-min run)
  //   YYYY-MM-DD         → that one date
  //   --days N           → the last N calendar days (one-time backfill so the
  //                        session-levels lookback — prior day, overnight — has
  //                        data). Weekends/holidays report "no ticks" and skip.
  const args = process.argv.slice(2)
  const daysIdx = args.indexOf('--days')
  let dates: string[]
  if (daysIdx >= 0) {
    const n = Math.max(1, Number(args[daysIdx + 1]) || 8)
    const today = todayPT()
    dates = Array.from({ length: n }, (_, i) => {
      const d = new Date(`${today}T12:00:00Z`)
      d.setUTCDate(d.getUTCDate() - i)
      return d.toISOString().slice(0, 10)
    })
  } else if (args[0] && /^\d{4}-\d{2}-\d{2}$/.test(args[0])) {
    dates = [args[0]]
  } else {
    dates = [todayPT()]
  }

  console.log(`[public-bar-feed] ${dates.length === 1 ? dates[0] : `${dates[dates.length - 1]}…${dates[0]}`} → ${url.replace(/^https?:\/\//, '')}`)

  let anyOk = false
  for (const date of dates) {
    for (const f of feedsForDate(date)) {
      const out = await importScidDay(sb, {
        scidFile: f.scidFile,
        storeAs: f.root,
        date,
        priceDivisor: 100,
        writeHistory: false,
      })
      if (out.ok) {
        anyOk = true
        console.log(`  ${date} ${f.root.padEnd(4)} upserted ${out.result.upserted} bars`)
      } else {
        console.error(`  ${date} ${f.root.padEnd(4)} ${out.error}`)
      }
    }
  }
  process.exit(anyOk ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
