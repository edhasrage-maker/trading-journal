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
 *   # Deep history backfill: an explicit range, one root at a time (their gaps
 *   # differ, and one root at a time keeps each run's blast radius small).
 *   npx tsx scripts/public-bar-feed.ts --from 2023-08-01 --to 2025-09-25 --roots NQ
 *
 * SCHEDULE
 *   Task Scheduler, every ~3 min during your session — same cadence as BarWatcher.
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'
import { importScidDay } from '../src/lib/import-scid-day'
import { todayPT, sessionUtcWindow } from '../src/lib/pt-time'
import { contractFileForRoot, type ContractRoot } from '../src/lib/futures-contracts'

const ROOTS: ContractRoot[] = ['NQ', 'ES']

// One-minute bars in a FULL PT session, by weekday — measured against the
// .scid files, not assumed. CME equity futures run Sunday 15:00 PT through
// Friday 14:00 PT with a 1-hour maintenance break at 14:00 PT each day, so:
// a midweek PT day holds 23h (1380), Friday stops at the close (840), Sunday
// only starts at the open (540), and Saturday is genuinely empty.
// Used two ways — which dates are worth reading at all, and whether a
// symbol-day is already complete on a resume. Getting Sunday wrong here would
// silently drop a real session from every backfill.
const FULL_SESSION_BARS: Record<number, number> = {
  0: 540,   // Sun — 15:00 PT open
  1: 1380, 2: 1380, 3: 1380, 4: 1380,
  5: 840,   // Fri — 14:00 PT close
  6: 0,     // Sat — market closed
}
/** Weekday of a PT calendar date (noon UTC keeps it off any DST boundary). */
const weekdayOf = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay()

// Local .scid → shared root symbol, resolved PER DATE off the quarterly roll
// table, so a trade at ANY date reads the contract that was actually front-month
// then — that's what makes MFE/MAE-from-bars work across history rather than
// only for the current contract. Both roots store under their mini root ('NQ',
// 'ES'), the key micros and dated contracts collapse to via chartSeriesRoot().
function feedsForDate(date: string, roots: ContractRoot[]): Array<{ scidFile: string; root: string }> {
  const feeds: Array<{ scidFile: string; root: string }> = []
  for (const root of roots) {
    const file = contractFileForRoot(root, date)   // e.g. 2026-03-15 → NQM6.CME.scid
    if (file) feeds.push({ scidFile: file, root })
  }
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

// Watchdog: a run must never outlive the scheduler interval. This runs hidden
// and detached, so a hung await (Supabase upsert, DNS) would otherwise leak an
// invisible node process every few minutes until the machine runs out of commit
// memory (happened 2026-07-13). Backfills get a longer leash — a --from/--to
// range can legitimately run for hours (~1s per symbol-day), so it must not
// inherit the --days ceiling; that would kill a deep run partway through.
const WATCHDOG_MS = process.argv.includes('--from')
  ? 8 * 60 * 60_000
  : process.argv.includes('--days') ? 30 * 60_000 : 4 * 60_000
setTimeout(() => {
  console.error(`[public-bar-feed] watchdog: still running after ${WATCHDOG_MS / 60_000} min — force exit`)
  process.exit(3)
}, WATCHDOG_MS)

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
  //   --from A --to B    → an explicit range, oldest first (deep history).
  const args = process.argv.slice(2)
  const flag = (name: string): string | null => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] ?? null : null
  }
  const daysIdx = args.indexOf('--days')
  const from = flag('--from')
  let dates: string[]
  if (from) {
    const to = flag('--to') || todayPT()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      console.error('--from / --to must be YYYY-MM-DD'); process.exit(1)
    }
    // Oldest first so an interrupted run resumes by moving --from forward.
    // Saturdays are skipped — the market is shut, so they'd cost a multi-GB
    // .scid seek each just to learn there are no ticks. Sundays are KEPT: the
    // week opens at 15:00 PT Sunday, which is a real 540-bar session.
    dates = []
    for (const d = new Date(`${from}T12:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      if (d.getUTCDay() !== 6) dates.push(d.toISOString().slice(0, 10))
    }
  } else if (daysIdx >= 0) {
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

  // --roots NQ  (default: every root). Their coverage gaps differ, so a deep
  // backfill normally runs one root at a time.
  const rootsArg = flag('--roots')
  const roots: ContractRoot[] = rootsArg
    ? rootsArg.split(',').map(s => s.trim().toUpperCase()).filter((r): r is ContractRoot => (ROOTS as string[]).includes(r))
    : ROOTS
  if (roots.length === 0) { console.error(`--roots must name one of: ${ROOTS.join(', ')}`); process.exit(1) }

  // Resume support for deep runs: a symbol-day that already has a full session
  // of bars is left alone. Upserts are idempotent, so this is purely to avoid
  // re-reading and re-sending work already done (and re-burning bandwidth) when
  // a long run is interrupted. --force re-feeds regardless.
  const skipExisting = Boolean(from) && !args.includes('--force')

  console.log(`[public-bar-feed] ${dates.length === 1 ? dates[0] : `${dates[0]}…${dates[dates.length - 1]}`} (${dates.length} d) roots=${roots.join(',')} → ${url.replace(/^https?:\/\//, '')}`)

  let anyOk = false
  let done = 0, skipped = 0, empty = 0, upsertedTotal = 0
  const startedAt = Date.now()
  for (const date of dates) {
    for (const f of feedsForDate(date, roots)) {
      if (skipExisting) {
        // Same PT-session window importScidDay writes, so the count is
        // comparable — a raw UTC day would straddle two sessions and miscount.
        const { start, end } = sessionUtcWindow(date)
        const { count } = await sb
          .from('ohlcv_bars')
          .select('ts', { count: 'exact', head: true })
          .eq('symbol', f.root)
          .gte('ts', start)
          .lte('ts', end)
        // Compare against THIS weekday's full session, so a complete Friday
        // (840) or Sunday (540) counts as done instead of being re-fed every
        // resume — while a run interrupted mid-day (importScidDay upserts in
        // 1000-row chunks) still falls short and gets rewritten. Holiday early
        // closes also fall short and are simply re-read; that's a few days a
        // year and cheap.
        if ((count ?? 0) >= FULL_SESSION_BARS[weekdayOf(date)]) { skipped++; anyOk = true; continue }
      }
      const out = await importScidDay(sb, {
        scidFile: f.scidFile,
        storeAs: f.root,
        date,
        priceDivisor: 100,
        writeHistory: false,
      })
      if (out.ok) {
        anyOk = true
        done++
        upsertedTotal += out.result.upserted
        if (from) {
          const rate = (Date.now() - startedAt) / Math.max(1, done)
          process.stdout.write(`  ${date} ${f.root.padEnd(3)} ${String(out.result.upserted).padStart(4)} bars  (${done} fed, ${skipped} skipped, ${empty} empty, ~${Math.round(rate)}ms/day)\r`)
        } else {
          console.log(`  ${date} ${f.root.padEnd(4)} upserted ${out.result.upserted} bars`)
        }
      } else {
        // A holiday or a not-yet-created contract file is expected noise in a
        // deep range — count it rather than spamming a line per date.
        empty++
        if (!from) console.error(`  ${date} ${f.root.padEnd(4)} ${out.error}`)
      }
    }
  }
  if (from) {
    console.log(`\n[public-bar-feed] done: ${done} symbol-days fed (${upsertedTotal.toLocaleString()} bars), ${skipped} already present, ${empty} with no ticks, in ${Math.round((Date.now() - startedAt) / 1000)}s`)
  }
  process.exit(anyOk ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
