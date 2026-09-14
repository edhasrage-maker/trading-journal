/**
 * Fill tags_json.day_type on trades that have none, in order of how little each
 * fill has to guess:
 *
 *   1. session    Entered outside RTH -> ["GBX"]. The same isOutsideRth rule the
 *                 Sierra importer uses; not a judgement.
 *   2. inherited  The day already carries the trader's own labels — day-level
 *                 day_types[], or failing that the labels on OTHER trades that
 *                 day — so the untagged trade takes those. Still the trader's call.
 *   3. auto-eod   Nothing to inherit. Structure + regime are derived from how the
 *                 RTH session CLOSED, using the locked v1 spec's thresholds:
 *                   Trend Day   close > max(PDH, ONH) or close < min(PDL, ONL); else Range Day
 *                   High Action RVOL >= 130% or day range >= 1.2x ADR
 *                   Low Particip. RVOL < 80% and day range < 0.8x ADR; else Medium Mush
 *
 * Why auto-eod is marked and limited. Measured against the 57 days the trader
 * had already labelled, the end-of-day structure read agrees 67% of the time and
 * the regime read 72%. The trader's labels are not end-of-day definitions (Trend
 * Day + Double Inside co-occurs, which cannot both hold at the close). Double
 * Inside and GBX Reversal could not be recovered from data at all — the best GBX
 * Reversal rule caught 3 of 11 with 18 false alarms — so auto-eod never writes
 * either. Every fill records tags_json.day_type_source so an auto label can be
 * filtered out or replaced; editing a trade's tags in the app may drop that key,
 * which is correct once a person has touched the label.
 *
 * Day-level trading_days.day_types[] is NOT written: it is a plain string array
 * with nowhere to mark provenance, and the choice was to keep auto labels marked.
 *
 *   npx tsx scripts/backfill-trade-day-types.ts            # dry run
 *   npx tsx scripts/backfill-trade-day-types.ts --apply    # write, after backing up
 *
 * Prod (.env.public-feed). Original tags_json of every touched trade is written
 * to scripts/.repair-backups/ before the first update.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'
import { isOutsideRth } from '../src/lib/rth'
import { chartSeriesRoot, symbolRoot } from '../src/lib/futures-symbols'
import { ptDateSodToUtcMs } from '../src/lib/pt-time'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const USER_ID = argv.find(a => a.startsWith('--user='))?.split('=')[1] ?? 'fa3fb352-9538-44cc-8ce1-1c76f307044c'

const env: Record<string, string> = {}
for (const l of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(env.PUBLIC_SUPABASE_URL, env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const RTH_START = 6 * 3600 + 30 * 60
const RTH_END = 13 * 3600
type Source = 'session' | 'inherited' | 'auto-eod'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any

const labelsOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v ? [v] : []).filter((x): x is string => typeof x === 'string' && x.trim() !== '')

async function rthBars(symbol: string, date: string) {
  const out: Array<{ high: number; low: number; close: number }> = []
  for (let p = 0; p < 5; p++) {
    const { data } = await sb.from('ohlcv_bars').select('high, low, close')
      .eq('symbol', symbol)
      .gte('ts', new Date(ptDateSodToUtcMs(date, RTH_START)).toISOString())
      .lt('ts', new Date(ptDateSodToUtcMs(date, RTH_END)).toISOString())
      .order('ts').range(p * 1000, p * 1000 + 999)
    if (!data?.length) break
    out.push(...data)
    if (data.length < 1000) break
  }
  return out
}

/** Structure + regime from the close. Returns only the lenses it can compute. */
async function autoEod(date: string, mc: Row | null, tradeSymbol: string | null): Promise<{ labels: string[]; why: string }> {
  if (!mc) return { labels: [], why: 'no market context' }
  const sym = mc.symbol ? chartSeriesRoot(mc.symbol) : tradeSymbol ? chartSeriesRoot(symbolRoot(tradeSymbol)) : null
  if (!sym) return { labels: [], why: 'no symbol' }
  const bars = await rthBars(sym, date)
  if (bars.length < 60) return { labels: [], why: `only ${bars.length} RTH bars` }
  const H = Math.max(...bars.map(b => b.high))
  const L = Math.min(...bars.map(b => b.low))
  const C = bars[bars.length - 1].close
  const labels: string[] = []
  const reasons: string[] = []
  if ([mc.pdh, mc.pdl, mc.onh, mc.onl].every(v => v != null)) {
    const trend = C > Math.max(mc.pdh, mc.onh) || C < Math.min(mc.pdl, mc.onl)
    labels.push(trend ? 'Trend Day' : 'Range Day')
    reasons.push(`close ${C} vs PD/ON ${Math.min(mc.pdl, mc.onl)}–${Math.max(mc.pdh, mc.onh)}`)
  }
  const range = mc.day_range ?? H - L
  if (mc.rvol != null && mc.adr) {
    const ratio = range / mc.adr
    labels.push(mc.rvol >= 130 || ratio >= 1.2 ? 'High Action Market'
      : mc.rvol < 80 && ratio < 0.8 ? 'Low Participation/Compressed'
        : 'Medium Mush Market (Indecisive)')
    reasons.push(`RVOL ${Math.round(mc.rvol)}%, range ${ratio.toFixed(2)}x ADR`)
  }
  return { labels, why: reasons.join(' · ') || 'no PD/ON levels and no RVOL/ADR' }
}

/** Most common non-overnight label set among the day's already-tagged trades. */
function siblingLabels(dayTrades: Row[]): string[] {
  const counts = new Map<string, { labels: string[]; n: number }>()
  for (const t of dayTrades) {
    const labels = labelsOf(t.tags_json?.day_type).filter(l => l.trim().toUpperCase() !== 'GBX')
    if (labels.length === 0) continue
    const key = [...labels].sort().join('|')
    const e = counts.get(key) ?? { labels, n: 0 }
    e.n++
    counts.set(key, e)
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.labels ?? []
}

async function main() {
  // The trader's own day-type vocabulary. Inherited labels are filtered to it:
  // stray day-level values ("Range", "Reversal") exist on a couple of days, and
  // copying them onto trades would spread labels no filter or baseline knows.
  const { data: vocab } = await sb.from('trade_tags').select('label').eq('user_id', USER_ID).eq('category', 'day_type')
  const canonical = new Set<string>((vocab ?? []).map((v: Row) => v.label))
  if (canonical.size === 0) throw new Error('no day_type labels in trade_tags — refusing to guess the vocabulary')
  const dropped = new Map<string, Set<string>>()
  const keepCanonical = (date: string, labels: string[]) => labels.filter(l => {
    if (canonical.has(l)) return true
    const set = dropped.get(date) ?? new Set<string>()
    set.add(l)
    dropped.set(date, set)
    return false
  })

  const { data: days } = await sb.from('trading_days').select('id, date, day_types, day_type').eq('user_id', USER_ID)
  const dayById = new Map<string, Row>((days ?? []).map((d: Row) => [d.id, d]))

  let trades: Row[] = []
  for (let p = 0; p < 20; p++) {
    const { data } = await sb.from('trades').select('id, trading_day_id, entry_time, symbol, tags_json')
      .eq('user_id', USER_ID).order('id').range(p * 1000, p * 1000 + 999)
    if (!data?.length) break
    trades = trades.concat(data)
    if (data.length < 1000) break
  }
  const byDay = new Map<string, Row[]>()
  for (const t of trades) {
    const arr = byDay.get(t.trading_day_id) ?? []
    arr.push(t)
    byDay.set(t.trading_day_id, arr)
  }

  const untagged = trades.filter(t => labelsOf(t.tags_json?.day_type).length === 0)
  const planned: Array<{ trade: Row; date: string; labels: string[]; source: Source }> = []
  const skipped: Array<{ date: string; n: number; why: string }> = []
  const autoCache = new Map<string, { labels: string[]; why: string }>()

  // Group the RTH work by day so each day is classified once.
  const rthByDay = new Map<string, Row[]>()
  for (const t of untagged) {
    const day = dayById.get(t.trading_day_id)
    const date = day?.date ?? '?'
    if (t.entry_time && isOutsideRth(t.entry_time)) {
      planned.push({ trade: t, date, labels: ['GBX'], source: 'session' })
      continue
    }
    const arr = rthByDay.get(t.trading_day_id) ?? []
    arr.push(t)
    rthByDay.set(t.trading_day_id, arr)
  }

  const ids = [...rthByDay.keys()]
  const { data: mcs } = ids.length
    ? await sb.from('market_context').select('trading_day_id, symbol, pdh, pdl, onh, onl, adr, rvol, day_range').eq('user_id', USER_ID).in('trading_day_id', ids)
    : { data: [] }
  const mcByDay = new Map<string, Row>((mcs ?? []).map((m: Row) => [m.trading_day_id, m]))

  for (const [dayId, dayUntagged] of rthByDay) {
    const day = dayById.get(dayId)
    const date = day?.date ?? '?'
    const dayLevel = [...labelsOf(day?.day_types), ...labelsOf(day?.day_type)]
      .filter((l, i, a) => a.indexOf(l) === i && l.trim().toUpperCase() !== 'GBX')
    const siblings = siblingLabels(byDay.get(dayId) ?? [])

    let labels: string[] = []
    let source: Source = 'inherited'
    const dayLevelOk = keepCanonical(date, dayLevel)
    const siblingsOk = keepCanonical(date, siblings)
    if (dayLevelOk.length) labels = dayLevelOk
    else if (siblingsOk.length) labels = siblingsOk
    else {
      if (!autoCache.has(dayId)) autoCache.set(dayId, await autoEod(date, mcByDay.get(dayId) ?? null, dayUntagged[0]?.symbol ?? null))
      const auto = autoCache.get(dayId)!
      labels = auto.labels
      source = 'auto-eod'
      if (labels.length === 0) { skipped.push({ date, n: dayUntagged.length, why: auto.why }); continue }
    }
    for (const t of dayUntagged) planned.push({ trade: t, date, labels, source })
  }

  // ── report ──────────────────────────────────────────────────────────────
  const bySource = (s: Source) => planned.filter(p => p.source === s)
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} · ${untagged.length} trades with no day type\n`)
  for (const s of ['session', 'inherited', 'auto-eod'] as Source[]) {
    const rows = bySource(s)
    console.log(`${s.padEnd(10)} ${rows.length} trade(s)`)
    const days = new Map<string, { labels: string[]; n: number }>()
    for (const r of rows) { const e = days.get(r.date) ?? { labels: r.labels, n: 0 }; e.n++; days.set(r.date, e) }
    for (const [d, e] of [...days].sort()) {
      const why = s === 'auto-eod' ? `   (${[...autoCache.entries()].find(([id]) => dayById.get(id)?.date === d)?.[1].why ?? ''})` : ''
      console.log(`   ${d}  ×${String(e.n).padEnd(3)} ${e.labels.join(' + ')}${why}`)
    }
  }
  if (dropped.size) {
    console.log(`
not copied — not one of your day-type labels:`)
    for (const [d, set] of [...dropped].sort()) console.log(`   ${d}  ${[...set].map(x => `"${x}"`).join(', ')}`)
  }
  if (skipped.length) {
    console.log(`\nleft untagged — could not classify:`)
    for (const s of skipped) console.log(`   ${s.date}  ×${s.n}  ${s.why}`)
  }

  if (!APPLY) { console.log('\nDry run only. Re-run with --apply to write.'); return }
  if (planned.length === 0) return

  const dir = path.join('scripts', '.repair-backups')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `trade-day-types-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, JSON.stringify(planned.map(p => ({ id: p.trade.id, date: p.date, tags_json: p.trade.tags_json })), null, 2))
  console.log(`\nOriginal tags backed up to ${file}`)

  let written = 0
  for (const p of planned) {
    const tj = p.trade.tags_json && typeof p.trade.tags_json === 'object' ? p.trade.tags_json : {}
    const { error } = await sb.from('trades')
      .update({ tags_json: { ...tj, day_type: p.labels, day_type_source: p.source } })
      .eq('id', p.trade.id).eq('user_id', USER_ID)
    if (error) console.log(`   ${p.date} ${p.trade.id}: ${error.message}`)
    else written++
  }
  console.log(`${written} of ${planned.length} trades written.`)
}

main().catch(e => { console.error(e); process.exit(1) })
