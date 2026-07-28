/**
 * Delta-by-price (footprint) report for one session, straight off the .scid ticks.
 *
 * Usage:
 *   npx tsx scripts/delta-by-price.ts --file=ESU6.CME.scid --date=2026-07-28 \
 *     --from=13:30 --to=17:30 --row=1 --zone=7467-7473
 *
 *   --file   .scid filename in SC_DATA_DIR, or an absolute path.
 *   --date   YYYY-MM-DD. Combined with --from/--to, which are UTC HH:MM.
 *   --row    Row height in PRICE units. 1 for ES, 5 for NQ. REQUIRED — this is
 *            the single most consequential argument (see below).
 *   --zone   lo-hi price range to total, e.g. 7467-7473. Repeatable.
 *   --top    How many rows to list per side. Default 6.
 *   --json   Emit machine-readable JSON instead of the text report.
 *
 * WHY THIS SCRIPT EXISTS. Asked to read delta-by-price off a chart SCREENSHOT,
 * the vision read was wrong — it put the large delta above the marked zone and
 * called it positive. The ticks said the opposite: three of the four largest red
 * rows of the session stacked at 7467 / 7468 / 7474, the zone totalled −1,465 on
 * 27.2% of session volume, and price was still holding above it. That is
 * absorption, and it is the opposite conclusion.
 *
 * The difference was BIN SIZE. At the 0.25 tick the selling fragmented across
 * four rows and looked ordinary; at the 1-point rows the chart actually draws it
 * consolidated into the largest prints of the day. Bin size is invisible in a
 * screenshot, which is why ticks are the SOURCE here and vision is only ever the
 * fallback. `--row` has no default for the same reason.
 *
 * Percentiles are the point of the report, not decoration: they are what makes a
 * threshold session-relative. Read p99 as "this is what "large" means today".
 */

import { readDeltaByPrice } from '../src/lib/scid-delta.ts'
import { detectDeltaLevels, rowDeltaStats, zoneTotal } from '../src/lib/delta-by-price.ts'

/** Sierra Chart data root on this machine (same constant as nq-tick-series.ts). */
const SC_DATA_DIR = 'D:/SierraCharts/Data'

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`))
  return hit?.slice(name.length + 3)
}
function argAll(name: string): string[] {
  return process.argv.slice(2)
    .filter(a => a.startsWith(`--${name}=`))
    .map(a => a.slice(name.length + 3))
}
const hasFlag = (name: string): boolean => process.argv.slice(2).includes(`--${name}`)

function fail(msg: string): never {
  console.error(`ERROR: ${msg}`)
  console.error('Usage: npx tsx scripts/delta-by-price.ts --file=ESU6.CME.scid --date=2026-07-28 --from=13:30 --to=17:30 --row=1 [--zone=lo-hi] [--top=6] [--json]')
  process.exit(1)
}

/** "13:30" + "2026-07-28" → epoch ms, interpreted as UTC. */
function utcMs(dateISO: string, hhmm: string): number {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) fail(`bad time "${hhmm}" (want HH:MM, UTC)`)
  const ms = Date.parse(`${dateISO}T${m[1].padStart(2, '0')}:${m[2]}:00Z`)
  if (!Number.isFinite(ms)) fail(`bad date "${dateISO}" (want YYYY-MM-DD)`)
  return ms
}

const num = (n: number): string => n.toLocaleString('en-US')
const signed = (n: number): string => (n > 0 ? `+${num(n)}` : num(n))
const hhmmss = (ms: number): string => new Date(ms).toISOString().slice(11, 19)

async function main(): Promise<void> {
  const file = arg('file') ?? fail('--file is required')
  const date = arg('date') ?? fail('--date is required')
  const from = arg('from') ?? '13:30'
  const to = arg('to') ?? '20:00'
  const rowRaw = arg('row') ?? fail('--row is required (1 for ES, 5 for NQ) — there is no safe default')
  const rowHeight = Number(rowRaw)
  if (!(rowHeight > 0)) fail(`--row must be a positive number (got "${rowRaw}")`)
  const top = Number(arg('top') ?? 6)
  const divisor = Number(arg('divisor') ?? 100)

  const path = /[/\\]/.test(file) ? file : `${SC_DATA_DIR}/${file}`
  const startMs = utcMs(date, from)
  const endMs = utcMs(date, to)
  if (endMs <= startMs) fail('--to must be after --from')

  const res = readDeltaByPrice(path, startMs, endMs, { rowHeight, priceDivisor: divisor })

  if (res.rows.length === 0) {
    console.error(`No ticks in ${date} ${from}–${to}Z for ${file}.`)
    if (res.fileFirstMs != null && res.fileLastMs != null) {
      console.error(`File covers ${new Date(res.fileFirstMs).toISOString()} → ${new Date(res.fileLastMs).toISOString()}`)
    }
    process.exit(2)
  }

  const stats = rowDeltaStats(res.rows)
  // breakDistance = one row: price has to clear the level by a full row height
  // before we call it broken, so a wick back through the row is not a break.
  const det = detectDeltaLevels(res.rows, res.bars, { rowHeight, breakDistance: rowHeight })

  const zones = argAll('zone').map(z => {
    const m = z.match(/^(-?[\d.]+)\s*-\s*(-?[\d.]+)$/)
    if (!m) fail(`bad --zone "${z}" (want lo-hi, e.g. 7467-7473)`)
    const lo = Number(m[1])
    const hi = Number(m[2])
    return { lo, hi, ...zoneTotal(res.rows, Math.min(lo, hi), Math.max(lo, hi)) }
  })

  if (hasFlag('json')) {
    console.log(JSON.stringify({
      file, date, from, to, rowHeight,
      sessionDelta: res.sessionDelta,
      sessionVolume: res.sessionVolume,
      tickCount: res.tickCount,
      rowCount: res.rows.length,
      stats,
      threshold: det.threshold,
      levels: det.levels,
      zones,
    }, null, 2))
    return
  }

  const sorted = [...res.rows].sort((a, b) => b.delta - a.delta)
  const topBuy = sorted.slice(0, top)
  const topSell = sorted.slice(-top).reverse()

  console.log(`\nDelta-by-price — ${file}  ${date}  ${from}–${to}Z  (${rowHeight}pt rows)`)
  console.log('='.repeat(72))
  console.log(`Session delta   ${signed(res.sessionDelta)} on ${num(res.sessionVolume)} contracts`)
  console.log(`Ticks           ${num(res.tickCount)} across ${num(res.rows.length)} rows, ${num(res.bars.length)} 1-min bars`)
  console.log(`Row |delta|     median ${num(stats.median)} · p90 ${num(stats.p90)} · p99 ${num(stats.p99)} · max ${num(stats.max)}`)
  console.log(`Threshold       ${num(det.threshold)} (p99 of THIS session — not a fixed number)`)

  console.log(`\nTop ${top} BUY rows (ask-side aggression)`)
  for (const r of topBuy) {
    console.log(`  ${r.price.toFixed(2).padStart(9)}  ${signed(r.delta).padStart(9)}  vol ${num(r.volume).padStart(8)}  (${(r.volume / res.sessionVolume * 100).toFixed(1)}%)`)
  }
  console.log(`\nTop ${top} SELL rows (bid-side aggression)`)
  for (const r of topSell) {
    console.log(`  ${r.price.toFixed(2).padStart(9)}  ${signed(r.delta).padStart(9)}  vol ${num(r.volume).padStart(8)}  (${(r.volume / res.sessionVolume * 100).toFixed(1)}%)`)
  }

  console.log(`\nDetected levels (|delta| >= ${num(det.threshold)})`)
  if (det.levels.length === 0) {
    console.log('  none — no row cleared this session\'s own significance bar')
  }
  for (const l of det.levels) {
    const ft = l.kind === 'unresolved' ? '—' : `${l.followThrough >= 0 ? '+' : ''}${l.followThrough.toFixed(2)}pt`
    console.log(
      `  ${l.price.toFixed(2).padStart(9)}  ${signed(l.delta).padStart(9)}  ${l.side.toUpperCase().padEnd(4)}` +
      `  ${l.kind.padEnd(12)}  ${l.strength.toFixed(2)}x  ${(l.volumeShare * 100).toFixed(1)}% vol` +
      `  last ${hhmmss(l.lastMs)}  follow ${ft}`,
    )
  }

  for (const z of zones) {
    const share = res.sessionVolume > 0 ? (z.volume / res.sessionVolume * 100).toFixed(1) : '0.0'
    console.log(`\nZone ${z.lo}–${z.hi}`)
    console.log(`  delta ${signed(z.delta)} on ${num(z.volume)} contracts (${share}% of session) across ${z.rows} rows`)
  }
  console.log('')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
