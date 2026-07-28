/**
 * Backfill `trades.symbol` on rows that lost it, by INFERRING the contract from
 * each trade's own economics.
 *
 * WHY. 4,137 Sierra-imported trades (2023-08 → 2026-05) carry symbol = NULL.
 * That single null blocks everything downstream: `backfill-excursion-from-bars`
 * requires a symbol to pick a bar series, so those trades can never get
 * MFE/MAE, and without MFE/MAE there's no capture, no heat, and no Exit axis on
 * their TapeScore.
 *
 * WHY NOT JUST STAMP "NQ". Their prices (18k-25k) look like NQ, and that guess
 * would even join the right BARS — chartSeriesRoot maps NQ and MNQ to the same
 * price series. But it would be wrong where it counts: MULTIPLIERS.NQ is 20 and
 * MULTIPLIERS.MNQ is 2, so mislabelling a micro as a mini inflates every dollar
 * figure derived from it TENFOLD — $ captured, $ of heat, $ left on the table.
 * Sampling 400 of these trades put the implied multiplier at ~2 on 395 of them:
 * they're micros. A blanket label would have been silently, expensively wrong.
 *
 * HOW. For each trade the dollar multiplier is recoverable from data already on
 * the row:
 *
 *     multiplier = pnl / (signed price move × quantity)
 *
 * Match that against MULTIPLIERS and the contract follows. Commissions skew it
 * a little (P&L is usually net), which is why matching is tolerant and, more
 * importantly, why an ambiguous result is SKIPPED rather than guessed — a wrong
 * symbol is worse than a null one, because null is visibly missing while wrong
 * quietly corrupts every dollar figure built on it.
 *
 * Two independent checks must agree before anything is written:
 *   1. the implied multiplier matches a known contract within tolerance, and
 *   2. the entry price sits in that instrument's plausible band
 *      (NQ-family ≫ ES-family — they don't overlap).
 *
 * SAFETY. The public project is MULTI-TENANT and this key BYPASSES RLS, so
 * every query here is scoped to --user (defaulting to the owner). Dry run is
 * the default; writing requires --write.
 *
 * USAGE
 *   npx tsx scripts/backfill-trade-symbol.ts                  # dry run, owner
 *   npx tsx scripts/backfill-trade-symbol.ts --write          # apply
 *   npx tsx scripts/backfill-trade-symbol.ts --user <uuid>    # another tenant
 *   npx tsx scripts/backfill-trade-symbol.ts --limit 50 --write
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'
import { MULTIPLIERS } from '../src/lib/futures-symbols'

// The owner. Scoping to a single tenant is mandatory here — see SAFETY above.
const OWNER_USER_ID = 'fa3fb352-9538-44cc-8ce1-1c76f307044c'

/** Candidate contracts, with the price band each realistically trades in over
 *  this journal's history. The band is the second, independent check: implied
 *  multipliers can collide across instruments (ES 50 vs RTY 50), but their
 *  price levels don't. Deliberately narrow — an instrument that isn't listed
 *  here is skipped rather than force-fitted to the nearest match. */
const CANDIDATES: Array<{ root: string; minPrice: number; maxPrice: number }> = [
  { root: 'MNQ', minPrice: 8_000, maxPrice: 40_000 },
  { root: 'NQ', minPrice: 8_000, maxPrice: 40_000 },
  { root: 'MES', minPrice: 2_000, maxPrice: 10_000 },
  { root: 'ES', minPrice: 2_000, maxPrice: 10_000 },
]

/** Relative tolerance on the implied multiplier. Generous because P&L is
 *  usually NET of commissions, which bites hardest on small moves — a 2-point
 *  MNQ scalp can read 3.3 instead of 2.0. Ambiguity is resolved by rejecting,
 *  never by picking the closest. */
const TOLERANCE = 0.35

function loadEnv(): void {
  const path = join(process.cwd(), '.env.public-feed')
  if (!existsSync(path)) { console.error('Missing .env.public-feed in repo root.'); process.exit(1) }
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
}
loadEnv()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(
  process.env.PUBLIC_SUPABASE_URL!,
  process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const userIdx = args.indexOf('--user')
const USER_ID = userIdx >= 0 ? args[userIdx + 1] : OWNER_USER_ID
const limitIdx = args.indexOf('--limit')
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity

interface Row {
  id: string
  direction: string | null
  quantity: number | null
  entry_price: number | null
  exit_price: number | null
  pnl: number | null
  entry_time: string | null
}

type Verdict =
  | { ok: true; root: string; implied: number }
  | { ok: false; reason: string }

/** Infer the contract from the trade's own economics. Returns a rejection
 *  reason rather than a guess whenever the evidence is thin. */
export function inferRoot(t: Row): Verdict {
  if (t.pnl == null) return { ok: false, reason: 'no pnl' }
  if (t.entry_price == null || t.exit_price == null) return { ok: false, reason: 'no prices' }
  if (!t.quantity) return { ok: false, reason: 'no quantity' }

  const dir = t.direction === 'short' ? -1 : 1
  const move = (t.exit_price - t.entry_price) * dir
  if (move === 0) return { ok: false, reason: 'scratch (zero move)' }

  const implied = t.pnl / (move * t.quantity)
  // A negative implied multiplier means P&L and price move disagree in sign —
  // a mislabelled direction or a bad fill price. Never infer from that.
  if (implied <= 0) return { ok: false, reason: 'pnl/move sign mismatch' }

  const matches = CANDIDATES.filter(c => {
    const mult = MULTIPLIERS[c.root]
    const withinMultiplier = Math.abs(implied - mult) / mult <= TOLERANCE
    const withinBand = t.entry_price! >= c.minPrice && t.entry_price! <= c.maxPrice
    return withinMultiplier && withinBand
  })

  if (matches.length === 0) return { ok: false, reason: `no contract matches implied ×${implied.toFixed(2)}` }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous (${matches.map(m => m.root).join('/')}) at implied ×${implied.toFixed(2)}` }
  }
  return { ok: true, root: matches[0].root, implied }
}

async function fetchNullSymbolTrades(): Promise<Row[]> {
  const PAGE = 1000
  const out: Row[] = []
  for (let p = 0; p < 50; p++) {
    const { data, error } = await sb
      .from('trades')
      .select('id, direction, quantity, entry_price, exit_price, pnl, entry_time')
      .eq('user_id', USER_ID)          // multi-tenant: never touch another trader's rows
      .is('symbol', null)
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) { console.error('fetch trades:', error.message); break }
    const rows = (data ?? []) as Row[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

async function main(): Promise<void> {
  console.log(`Mode: ${WRITE ? 'WRITE' : 'DRY RUN'}  user=${USER_ID}  limit=${LIMIT === Infinity ? 'none' : LIMIT}`)

  const trades = await fetchNullSymbolTrades()
  console.log(`\nTrades with symbol = NULL: ${trades.length}`)
  if (trades.length === 0) return

  const resolved: Array<{ id: string; root: string }> = []
  const byRoot = new Map<string, number>()
  const skipped = new Map<string, number>()

  for (const t of trades) {
    if (resolved.length >= LIMIT) break
    const v = inferRoot(t)
    if (!v.ok) {
      skipped.set(v.reason, (skipped.get(v.reason) ?? 0) + 1)
      continue
    }
    resolved.push({ id: t.id, root: v.root })
    byRoot.set(v.root, (byRoot.get(v.root) ?? 0) + 1)
  }

  console.log('\nInferred:')
  for (const [root, n] of [...byRoot].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${root.padEnd(5)} ${String(n).padStart(6)}  (×${MULTIPLIERS[root]})`)
  }
  if (skipped.size > 0) {
    console.log('\nSkipped (left NULL — a wrong symbol is worse than none):')
    for (const [reason, n] of [...skipped].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(6)}  ${reason}`)
    }
  }

  if (!WRITE) {
    console.log(`\nDry run — no writes. Would set symbol on ${resolved.length} trade(s).`)
    console.log('Re-run with --write to apply, then npx tsx scripts/backfill-excursion-from-bars.ts')
    return
  }

  let written = 0
  for (let i = 0; i < resolved.length; i += 50) {
    const chunk = resolved.slice(i, i + 50)
    await Promise.all(chunk.map(async r => {
      const { error } = await sb
        .from('trades')
        .update({ symbol: r.root })
        .eq('id', r.id)
        .eq('user_id', USER_ID)        // belt and braces: scoped on the write too
      if (error) console.error(`  update ${r.id}: ${error.message}`)
      else written++
    }))
    process.stdout.write(`\r  wrote ${written}/${resolved.length}`)
  }
  console.log(`\n\nDone — set symbol on ${written} trade(s).`)
  console.log('Next: npx tsx scripts/backfill-excursion-from-bars.ts --dry-run')
}

main().catch(e => { console.error(e); process.exit(1) })
