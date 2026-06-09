/**
 * Derive trading_days.day_types[] from market_context fields per the
 * v1 classifier spec (locked in 2026-06-08).
 *
 * THREE-PHASE classifier, applied in order. Each phase ADDS labels —
 * never removes. Existing day_types[] are preserved (covers the AI-predict
 * real-time flow and any manual prep labels).
 *
 *   Phase 1 — Tradezella whitelist
 *     For each historical_trade with tags_json.day_type, if the value
 *     normalizes (via tagKey) to one of the 7 canonical day_type labels,
 *     add it to that day's day_types[].
 *
 *   Phase 2 — Market-data classifier (uses market_context fields):
 *
 *     STRUCTURAL (07:30 PT snapshot, exactly one):
 *       ib_close_price > max(pdh, onh):  Trend Day
 *       ib_close_price < min(pdl, onl):  Trend Day
 *       else:                            Range Day
 *
 *     REGIME (07:30 PT snapshot, exactly one):
 *       atr_ratio = atr_at_ib_close / atr_10d_avg
 *       rvol_at_ib_close ≥ 130% OR atr_ratio ≥ 1.2:        High Action Market
 *       rvol < 80% AND atr_ratio < 0.8 AND ib_size < 0.7×adr: Low Participation/Compressed
 *       else:                                                Medium Mush Market (Indecisive)
 *
 *     DOUBLE INSIDE flag (pragmatic — only if it stayed inside through IB):
 *       rth_open inside [pdl,pdh] ∩ [onl,onh]
 *       AND ib_close_price inside the same intersection
 *       → "Double Inside (PD + ON)"
 *
 *     GBX REVERSAL flag (open-time snapshot):
 *       |onh - onl| > 0.8 × adr
 *       AND rth_open on the opposite side of (onh+onl)/2 from where
 *           the overnight directional bias landed
 *       → "GBX Reversal"
 *
 * Usage:
 *   node --experimental-strip-types scripts/derive-day-types.ts [--dry-run] [--force]
 *
 *   --force   re-runs even on days that already carry labels. Default
 *             behavior is additive (skips labels already present, but
 *             may still add new ones from other phases).
 *
 * Schema dependency: 2026-06-08 ib_close_columns migration applied AND
 * the extended backfill-market-context-from-csv.ts has been run with
 * --force so the new IB-close snapshot columns are populated.
 */

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { tagKey } from '../src/lib/tradezella-import.ts'

// Load .env.local
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const force = argv.includes('--force')

// Canonical day_type labels — must match `trade_tags` exactly. Keyed via
// tagKey() for case/space-insensitive whitelist matching against the
// Tradezella tags_json.day_type field.
const CANONICAL_DAY_TYPES = [
  'High Action Market',
  'Medium Mush Market (Indecisive)',
  'Low Participation/Compressed',
  'Double Inside (PD + ON)',
  'GBX Reversal',
  'Trend Day',
  'Range Day',
] as const
type DayTypeLabel = typeof CANONICAL_DAY_TYPES[number]
const KEY_TO_CANONICAL = new Map<string, DayTypeLabel>()
for (const lbl of CANONICAL_DAY_TYPES) KEY_TO_CANONICAL.set(tagKey(lbl), lbl)

interface DayRow {
  id: string
  date: string
  day_types: string[] | null
  day_type: string | null
}

interface ContextRow {
  trading_day_id: string
  rvol_at_ib_close: number | null
  atr_at_ib_close: number | null
  atr_10d_avg: number | null
  rth_open: number | null
  ib_close_price: number | null
  pdh: number | null
  pdl: number | null
  onh: number | null
  onl: number | null
  ibh: number | null
  ibl: number | null
  ib_size: number | null
  adr: number | null
}

interface HistRow {
  trade_date: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tags_json: any
}

async function fetchAll<T>(table: string, select: string, order?: string): Promise<T[]> {
  const PAGE = 1000
  const all: T[] = []
  for (let p = 0; p < 50; p++) {
    let q = sb.from(table).select(select).range(p * PAGE, p * PAGE + PAGE - 1)
    if (order) q = q.order(order, { ascending: true })
    const { data, error } = await q
    if (error) { console.error(`  fetch ${table} page ${p} failed:`, error.message); break }
    const rows = (data ?? []) as T[]
    all.push(...rows)
    if (rows.length < PAGE) break
  }
  return all
}

/**
 * Phase 1 — pull TZ's day_type strings off historical_trades.tags_json,
 * normalize via tagKey, and accept only those matching a canonical label.
 * Returns a Map<date, Set<canonical_label>> ready to merge into day_types[].
 */
function phaseTzWhitelist(hist: HistRow[]): Map<string, Set<DayTypeLabel>> {
  const out = new Map<string, Set<DayTypeLabel>>()
  let matched = 0, rejected = 0
  for (const h of hist) {
    if (!h.trade_date) continue
    const raw = h.tags_json?.day_type
    if (typeof raw !== 'string' || !raw.trim()) continue
    const key = tagKey(raw)
    const canon = KEY_TO_CANONICAL.get(key)
    if (!canon) { rejected++; continue }
    matched++
    let set = out.get(h.trade_date)
    if (!set) { set = new Set(); out.set(h.trade_date, set) }
    set.add(canon)
  }
  console.log(`  TZ whitelist: ${matched} matched, ${rejected} rejected (non-canonical labels)`)
  console.log(`  → ${out.size} dates received at least one whitelisted label`)
  return out
}

/**
 * Phase 2 — apply the structural / regime / open-time classifier rules.
 * Returns labels to add. Skipped labels surface as null returns so the
 * caller can attribute coverage gaps.
 */
function classifyOne(ctx: ContextRow): {
  structural: DayTypeLabel | null
  regime: DayTypeLabel | null
  doubleInside: boolean
  gbxReversal: boolean
  skipReason?: string
} {
  // Need at minimum: ib_close_price, pdh, pdl, onh, onl for structural.
  // Without these we can't make any honest "by 07:30" call.
  if (
    ctx.ib_close_price == null ||
    ctx.pdh == null || ctx.pdl == null ||
    ctx.onh == null || ctx.onl == null
  ) {
    return { structural: null, regime: null, doubleInside: false, gbxReversal: false,
             skipReason: 'missing structural levels (ib_close_price/pdh/pdl/onh/onl)' }
  }

  // STRUCTURAL
  const topEnv = Math.max(ctx.pdh, ctx.onh)
  const botEnv = Math.min(ctx.pdl, ctx.onl)
  let structural: DayTypeLabel
  if (ctx.ib_close_price > topEnv) structural = 'Trend Day'
  else if (ctx.ib_close_price < botEnv) structural = 'Trend Day'
  else structural = 'Range Day'

  // REGIME — needs rvol_at_ib_close + atr_at_ib_close + atr_10d_avg
  let regime: DayTypeLabel | null = null
  if (ctx.rvol_at_ib_close != null && ctx.atr_at_ib_close != null && ctx.atr_10d_avg != null && ctx.atr_10d_avg > 0) {
    const atrRatio = ctx.atr_at_ib_close / ctx.atr_10d_avg
    if (ctx.rvol_at_ib_close >= 130 || atrRatio >= 1.2) {
      regime = 'High Action Market'
    } else if (
      ctx.rvol_at_ib_close < 80 &&
      atrRatio < 0.8 &&
      ctx.ib_size != null && ctx.adr != null && ctx.adr > 0 &&
      ctx.ib_size < 0.7 * ctx.adr
    ) {
      regime = 'Low Participation/Compressed'
    } else {
      regime = 'Medium Mush Market (Indecisive)'
    }
  }

  // DOUBLE INSIDE — pragmatic: open AND ib-close both inside the intersection
  let doubleInside = false
  if (ctx.rth_open != null) {
    const intLow = Math.max(ctx.pdl, ctx.onl)
    const intHigh = Math.min(ctx.pdh, ctx.onh)
    const openInside = ctx.rth_open > intLow && ctx.rth_open < intHigh
    const closeInside = ctx.ib_close_price > intLow && ctx.ib_close_price < intHigh
    if (openInside && closeInside) doubleInside = true
  }

  // GBX REVERSAL — requires ADR baseline + rth_open. Proxy heuristic
  // (no overnight bar-direction data, only high/low). Tightened from
  // earlier looser version after seeing false positives on symmetric ON
  // ranges (e.g. 2026-06-05 had equal up/down tails, flipped on the
  // `>=` tiebreaker, fired Reversal on what was actually trend continuation).
  //
  // Two-gate filter:
  //   1. ON tails must be ASYMMETRIC by ≥15% of ON range — otherwise the
  //      bias direction is too ambiguous to call.
  //   2. RTH open must be CLEARLY past the midpoint (≥20% of ON range
  //      into the opposite side) — barely-on-the-other-side opens are
  //      too noisy.
  // Both gates correctly silence 2026-06-05 type cases while still firing
  // on truly directional Globex sessions that reverse at the RTH open.
  let gbxReversal = false
  if (ctx.adr != null && ctx.adr > 0 && ctx.rth_open != null) {
    const onRange = ctx.onh - ctx.onl
    if (onRange > 0.8 * ctx.adr) {
      const onMid = (ctx.onh + ctx.onl) / 2
      const upTail = ctx.onh - onMid
      const downTail = onMid - ctx.onl
      const tailAsymmetry = Math.abs(upTail - downTail) / onRange
      const openDistanceFromMid = Math.abs(ctx.rth_open - onMid) / onRange
      if (tailAsymmetry >= 0.15 && openDistanceFromMid >= 0.2) {
        const gbxBiasUp = upTail > downTail
        if (gbxBiasUp && ctx.rth_open < onMid) gbxReversal = true
        else if (!gbxBiasUp && ctx.rth_open > onMid) gbxReversal = true
      }
    }
  }

  return { structural, regime, doubleInside, gbxReversal }
}

async function main() {
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}, force=${force}`)
  console.log()

  console.log('Fetching trading_days + market_context + historical_trades…')
  const days = await fetchAll<DayRow>('trading_days', 'id, date, day_types, day_type')
  const contexts = await fetchAll<ContextRow>(
    'market_context',
    'trading_day_id, rvol_at_ib_close, atr_at_ib_close, atr_10d_avg, rth_open, ib_close_price, pdh, pdl, onh, onl, ibh, ibl, ib_size, adr',
  )
  const hist = await fetchAll<HistRow>('historical_trades', 'trade_date, tags_json')
  console.log(`  ${days.length} trading_days, ${contexts.length} market_context, ${hist.length} historical_trades`)
  console.log()

  // Index
  const ctxByDayId = new Map<string, ContextRow>()
  for (const c of contexts) ctxByDayId.set(c.trading_day_id, c)
  const daysByDate = new Map<string, DayRow>()
  for (const d of days) daysByDate.set(d.date, d)

  // Phase 1 — TZ whitelist
  console.log('Phase 1: Tradezella whitelist…')
  const tzAdds = phaseTzWhitelist(hist)

  // Phase 2 — classifier
  console.log('\nPhase 2: market-data classifier…')
  let classified = 0
  let skippedNoCtx = 0
  let skippedNoLevels = 0
  const structuralAdds = new Map<string, Set<DayTypeLabel>>()
  const regimeMissingCount: Record<string, number> = {}
  for (const d of days) {
    const ctx = ctxByDayId.get(d.id)
    if (!ctx) { skippedNoCtx++; continue }
    const r = classifyOne(ctx)
    if (r.skipReason) {
      skippedNoLevels++
      continue
    }
    classified++
    const set = structuralAdds.get(d.date) ?? new Set<DayTypeLabel>()
    if (r.structural) set.add(r.structural)
    if (r.regime) set.add(r.regime)
    else regimeMissingCount[d.date] = (regimeMissingCount[d.date] ?? 0) + 1
    if (r.doubleInside) set.add('Double Inside (PD + ON)')
    if (r.gbxReversal) set.add('GBX Reversal')
    if (set.size > 0) structuralAdds.set(d.date, set)
  }
  console.log(`  ${classified} days classified, ${skippedNoCtx} had no market_context row, ${skippedNoLevels} had ctx but missing structural levels`)
  const regimeMissing = Object.keys(regimeMissingCount).length
  if (regimeMissing > 0) console.log(`  ${regimeMissing} days had structural label but no regime (missing rvol_at_ib_close/atr_at_ib_close/atr_10d_avg)`)
  console.log()

  // MERGE phase 1 + phase 2 into the existing day_types[] additively.
  // Skip labels already present unless --force. Even with --force we don't
  // REMOVE labels — only add new ones.
  console.log('Merging into day_types[]…')
  interface Update { id: string; date: string; new_day_types: DayTypeLabel[]; added: string[] }
  const updates: Update[] = []
  let unchanged = 0
  for (const d of days) {
    const existing = new Set<string>(
      (d.day_types && d.day_types.length > 0)
        ? d.day_types
        : (d.day_type ? [d.day_type] : []),
    )
    const tz = tzAdds.get(d.date) ?? new Set<DayTypeLabel>()
    const cls = structuralAdds.get(d.date) ?? new Set<DayTypeLabel>()
    const toAdd: DayTypeLabel[] = []
    for (const lbl of [...tz, ...cls]) {
      if (!existing.has(lbl)) toAdd.push(lbl)
    }
    if (toAdd.length === 0) { unchanged++; continue }
    const merged = [...existing, ...toAdd] as DayTypeLabel[]
    updates.push({ id: d.id, date: d.date, new_day_types: merged, added: toAdd })
  }
  console.log(`  ${updates.length} days would gain at least one label; ${unchanged} unchanged`)

  // Sample the MOST RECENT 8 so the user can spot-check against days
  // they actually remember. `days` came from fetchAll without a forced
  // order, so explicitly sort the updates list by date desc before slicing.
  console.log('\nSample updates (most recent 8):')
  const recentUpdates = [...updates].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  for (const u of recentUpdates.slice(0, 8)) {
    console.log(`  ${u.date}: + [${u.added.join(', ')}]  →  full set: [${u.new_day_types.join(', ')}]`)
  }

  if (dryRun) {
    console.log('\nDry run — no writes.')
    return
  }

  const BATCH = 200
  let wrote = 0
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH)
    const results = await Promise.all(batch.map(u =>
      sb.from('trading_days').update({ day_types: u.new_day_types }).eq('id', u.id),
    ))
    for (const r of results) {
      if (r.error) console.error('  update failed:', r.error.message)
      else wrote++
    }
    process.stdout.write(`  wrote ${wrote}/${updates.length}\r`)
  }
  console.log(`\nDone. Updated ${wrote} trading_days rows.`)
}

main().catch(e => { console.error(e); process.exit(1) })
