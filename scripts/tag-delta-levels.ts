/**
 * Attach delta-by-price levels to real trades, and report the tags they imply.
 *
 * Usage:
 *   npx tsx scripts/tag-delta-levels.ts --from=2026-07-01 --to=2026-07-28
 *   npx tsx scripts/tag-delta-levels.ts --from=2026-07-28 --detail
 *   npx tsx scripts/tag-delta-levels.ts --from=2026-07-01 --to=2026-07-28 --write
 *
 *   --from/--to  Trading-day range (PT dates). --to defaults to --from.
 *   --row        Row height in price units. Default 5 (NQ). ES would be 1.
 *   --ticks      Entry must be within this many ticks of the level. Default 8.
 *   --minutes    Level must have started within this many minutes. Default 30.
 *   --pct        Session percentile defining significance. Default 0.99.
 *   --detail     Print every match, not just the summary.
 *   --write      Actually apply the tags. DRY RUN unless this is passed.
 *
 * DRY RUN BY DEFAULT, and that is deliberate. The prod DB is multi-tenant and
 * the service-role key bypasses RLS, so every read and write here is scoped to
 * the owner's user_id explicitly rather than trusting the query to be scoped.
 *
 * Local-only: it needs .scid tick files, which tapescore.app does not have.
 * This is the "local enrichment" half of the auto-tagging design — the owner's
 * tags come from ticks and are FACT; everyone else's come from the LLM path and
 * need confirmation before they count toward a score.
 */

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { readDeltaByPrice } from '../src/lib/scid-delta.ts'
import { detectDeltaLevels, type DetectedDeltaLevel } from '../src/lib/delta-by-price.ts'
import { matchTradesToLevels, type TradeAnchor, type LevelMatch } from '../src/lib/delta-level-match.ts'
import { contractFor, isNQ, SC_DATA_DIR } from './nq-tick-series.ts'

for (const line of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

/** edhasrage. Every query below is filtered on this — see the header note. */
const OWNER_PREFIX = 'fa3fb352'
/** NQ tick size. MNQ trades are matched against NQ ticks (basis cancels). */
const TICK_SIZE = 0.25
/** App convention (src/lib/session-levels.ts): RTH is 06:30–13:00 Pacific. */
const RTH_START_SEC = 6 * 3600 + 30 * 60
const RTH_END_SEC = 13 * 3600

/**
 * DETECTOR → TAG BINDINGS. This is CONFIGURATION, not logic: it says which of
 * the trader's OWN existing tags a detector result corresponds to. It never
 * invents a label — every string here must already exist in trade_tags, and
 * the script verifies that before writing.
 */
const BINDINGS: {
  category: string
  label: string
  when: (m: LevelMatch) => boolean
  why: string
}[] = [
  {
    category: 'confluences', label: 'Large Delta on DBP',
    when: () => true,
    why: 'entry sat on a row whose |delta| cleared this session\'s own p99',
  },
  {
    category: 'order_flow', label: 'Absorption/Exhaustion (Countermov)',
    when: m => m.level.kind === 'absorption' && m.againstAggressor === true,
    why: 'traded AGAINST aggression that got no follow-through',
  },
  {
    category: 'order_flow', label: 'Following Buying/Selling Strength',
    when: m => m.level.kind === 'continuation' && m.againstAggressor === false,
    why: 'traded WITH aggression that did follow through',
  },
]

const argv = process.argv.slice(2)
const arg = (n: string): string | undefined =>
  argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3)
const flag = (n: string): boolean => argv.includes(`--${n}`)

const PT_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})

/**
 * A Pacific wall-clock instant (date + seconds-since-midnight) as UTC ms.
 * Probes the offset at an approximate UTC guess and corrects, which gets DST
 * right on both sides of a transition without hardcoding -7 / -8.
 */
function ptToUtcMs(dateISO: string, sod: number): number {
  const [y, mo, d] = dateISO.split('-').map(Number)
  const guess = Date.UTC(y, mo - 1, d, 0, 0, 0) + sod * 1000
  for (let i = 0; i < 2; i++) {
    const parts = PT_FMT.formatToParts(new Date(guess))
    const get = (t: string) => Number(parts.find(p => p.type === t)?.value)
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
    const wanted = Date.UTC(y, mo - 1, d, 0, 0, 0) + sod * 1000
    const drift = wanted - asUtc
    if (drift === 0) break
    return guess + drift
  }
  return guess
}

interface DayRow { id: string; date: string; user_id: string }
interface TradeRow {
  id: string; trading_day_id: string; symbol: string | null
  entry_time: string | null; entry_price: number | null
  direction: 'long' | 'short' | null
  tags_json: Record<string, string[] | string> | null
}
interface TagRow { user_id: string; category: string; label: string }

const PAGE = 1000
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAll<T>(sb: any, table: string, cols: string): Promise<T[]> {
  const out: T[] = []
  for (let p = 0; ; p++) {
    const { data, error } = await sb.from(table).select(cols)
      .order('id', { ascending: true }).range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    const rows = data as T[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

const asArray = (v: string[] | string | undefined): string[] =>
  Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []

async function main(): Promise<void> {
  const from = arg('from')
  if (!from) {
    console.error('Usage: npx tsx scripts/tag-delta-levels.ts --from=YYYY-MM-DD [--to=YYYY-MM-DD] [--detail] [--write]')
    process.exit(1)
  }
  const to = arg('to') ?? from
  const rowHeight = Number(arg('row') ?? 5)
  const maxTicks = Number(arg('ticks') ?? 8)
  const maxMinutes = Number(arg('minutes') ?? 30)
  const pct = Number(arg('pct') ?? 0.99)
  const detail = flag('detail')
  const write = flag('write')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = createClient(
    process.env.PUBLIC_SUPABASE_URL!,
    process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY!,
  )

  const allDays = await fetchAll<DayRow>(sb, 'trading_days', 'id, date, user_id')
  const days = allDays
    .filter(d => d.user_id?.startsWith(OWNER_PREFIX) && d.date >= from && d.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date))
  if (days.length === 0) {
    console.error(`No owner trading days in ${from} → ${to}.`)
    process.exit(2)
  }
  const dayById = new Map(days.map(d => [d.id, d]))

  const allTrades = await fetchAll<TradeRow>(sb, 'trades',
    'id, trading_day_id, symbol, entry_time, entry_price, direction, tags_json')
  const trades = allTrades.filter(t => dayById.has(t.trading_day_id))

  // Verify every bound label actually exists in the OWNER's library. The
  // detector selects from the trader's vocabulary; it must never create it.
  const allTags = await fetchAll<TagRow>(sb, 'trade_tags', 'user_id, category, label')
  const ownerTags = new Set(
    allTags.filter(t => t.user_id?.startsWith(OWNER_PREFIX))
      .map(t => `${t.category}::${t.label}`))
  const missing = BINDINGS.filter(b => !ownerTags.has(`${b.category}::${b.label}`))
  if (missing.length > 0) {
    console.error('These bound tags do not exist in the owner library — refusing to run:')
    for (const b of missing) console.error(`  ${b.category} / ${b.label}`)
    process.exit(3)
  }

  console.log(`\n${write ? 'WRITE' : 'DRY RUN'} · ${from} → ${to} · ${days.length} days · ${trades.length} trades`)
  console.log(`rows ${rowHeight}pt · within ${maxTicks} ticks · within ${maxMinutes} min · p${(pct * 100).toFixed(0)} threshold`)
  console.log('='.repeat(78))

  let daysWithTicks = 0
  let matchedTrades = 0
  let skippedNonNQ = 0
  const proposed = new Map<string, Map<string, Set<string>>>()  // tradeId → category → labels
  const tally = new Map<string, number>()

  for (const day of days) {
    const dayTrades = trades.filter(t => t.trading_day_id === day.id)
    const nq = dayTrades.filter(t => isNQ(t.symbol) && t.entry_time && t.entry_price != null)
    skippedNonNQ += dayTrades.length - nq.length
    if (nq.length === 0) continue

    const file = contractFor(day.date)
    if (!file) continue
    const startMs = ptToUtcMs(day.date, RTH_START_SEC)
    const endMs = ptToUtcMs(day.date, RTH_END_SEC)

    // Probe the session once just to confirm the file covers this day.
    try {
      if (readDeltaByPrice(`${SC_DATA_DIR}/${file}`, startMs, endMs, { rowHeight }).rows.length === 0) continue
    } catch {
      continue
    }
    daysWithTicks++
    if (detail) console.log(`\n${day.date}  ${file}`)

    // AS OF THE ENTRY, per trade. A session-wide profile would credit a trader
    // with delta that printed after they were already in — see the note in
    // delta-level-match.ts. Reading [sessionStart, entryMs) instead means every
    // number is what the DBP actually showed when the trade was taken.
    for (const t of nq) {
      const entryMs = Date.parse(t.entry_time!)
      if (!Number.isFinite(entryMs) || entryMs <= startMs || entryMs > endMs) continue

      let asOf
      try {
        asOf = readDeltaByPrice(`${SC_DATA_DIR}/${file}`, startMs, entryMs, { rowHeight })
      } catch {
        continue
      }
      if (asOf.rows.length === 0) continue

      const det = detectDeltaLevels(asOf.rows, asOf.bars, {
        rowHeight, breakDistance: rowHeight, thresholdPercentile: pct,
      })
      if (det.levels.length === 0) continue

      const anchor: TradeAnchor = {
        id: t.id, entryMs, entryPrice: t.entry_price!, direction: t.direction,
      }
      const matches = matchTradesToLevels([anchor], det.levels,
        { tickSize: TICK_SIZE, rowHeight, maxTicks, maxMinutes })
      const ms = matches.get(t.id)
      if (!ms || ms.length === 0) continue

      matchedTrades++
      const best = ms[0]
      const tradeId = t.id
      const trade = t
      const forTrade = proposed.get(tradeId) ?? new Map<string, Set<string>>()
      for (const b of BINDINGS) {
        if (!b.when(best)) continue
        const set = forTrade.get(b.category) ?? new Set<string>()
        set.add(b.label)
        forTrade.set(b.category, set)
        tally.set(`${b.category}/${b.label}`, (tally.get(`${b.category}/${b.label}`) ?? 0) + 1)
      }
      proposed.set(tradeId, forTrade)

      if (detail) {
        const L: DetectedDeltaLevel = best.level
        const labels = [...forTrade].flatMap(([c, s]) => [...s].map(l => `${c}/${l}`))
        console.log(
          `  ${new Date(Date.parse(trade.entry_time!)).toISOString().slice(11, 19)} ` +
          `${(trade.direction ?? '?').padEnd(5)} @${trade.entry_price} → ` +
          `${L.price} ${L.delta > 0 ? '+' : ''}${L.delta} ${L.side}/${L.kind} ` +
          `(${best.distanceTicks.toFixed(1)}t, ${best.ageMinutes.toFixed(0)}m) ` +
          `${best.againstAggressor ? 'FADE' : 'FOLLOW'} → ${labels.join(', ') || '—'}`)
      }
    }
  }

  console.log(`\nDays with tick data      ${daysWithTicks} / ${days.length}`)
  console.log(`Trades matched to a level ${matchedTrades}`)
  if (skippedNonNQ > 0) console.log(`Skipped (non-NQ or no entry) ${skippedNonNQ}`)
  console.log('\nTags this would apply:')
  if (tally.size === 0) console.log('  none')
  for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${k}`)
  }

  if (!write) {
    console.log('\nDRY RUN — nothing written. Re-run with --write to apply.\n')
    return
  }

  let updated = 0
  for (const [tradeId, cats] of proposed) {
    const trade = trades.find(t => t.id === tradeId)!
    const next: Record<string, string[] | string> = { ...(trade.tags_json ?? {}) }
    let changed = false
    for (const [cat, labels] of cats) {
      const existing = asArray(next[cat])
      const merged = [...existing]
      for (const l of labels) if (!merged.includes(l)) { merged.push(l); changed = true }
      if (merged.length !== existing.length) next[cat] = merged
    }
    if (!changed) continue
    const { error } = await sb.from('trades').update({ tags_json: next }).eq('id', tradeId)
    if (error) { console.error(`  ! ${tradeId}: ${error.message}`); continue }
    updated++
  }
  console.log(`\nUpdated ${updated} trades.\n`)
}

main().catch(err => { console.error(err); process.exit(1) })
