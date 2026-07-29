/**
 * Backfill trades.post_exit_favorable_pts / post_exit_against_pts.
 *
 * Run AFTER applying migration 20260705_trades_post_exit.sql:
 *   node --experimental-strip-types scripts/backfill-post-exit.ts
 *
 * Self-contained (no '@/...' imports) so raw Node resolves it. Replicates
 * postExitExtension (src/lib/atr.ts) + fetchAllBars EXACTLY — POST_EXIT_WINDOW_MIN (15-min) window,
 * direction-relative favorable/against points, micro→mini bar fallback.
 * Reads bars from ohlcv_bars, so only days with imported bars get populated.
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

for (const l of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const WINDOW_MIN = 15 // keep in sync with POST_EXIT_WINDOW_MIN in src/lib/atr.ts (script stays self-contained)
const MICRO_TO_MINI: Record<string, string> = { MNQ: 'NQ', MES: 'ES', MYM: 'YM', M2K: 'RTY' }
const rootOf = (s: string) => s.replace(/\.[A-Z]+$/, '').replace(/[HMUZ]\d+$/, '')
const miniSymbol = (s: string) => { const r = rootOf(s); const mini = MICRO_TO_MINI[r]; return mini ? s.replace(r, mini) : null }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchBars(symbol: string, start: string, end: string): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = []
  for (let p = 0; p < 10; p++) {
    const { data } = await sb.from('ohlcv_bars').select('ts, high, low, close').eq('symbol', symbol).gte('ts', start).lte('ts', end).order('ts', { ascending: true }).range(p * 1000, p * 1000 + 999)
    if (!data || !data.length) break
    out.push(...data)
    if (data.length < 1000) break
  }
  return out
}
async function fetchAllBars(symbol: string, date: string) {
  const start = `${date}T00:00:00Z`
  const e = new Date(start); e.setUTCDate(e.getUTCDate() + 1)
  const end = e.toISOString().slice(0, 10) + 'T23:59:59Z'
  let bars = await fetchBars(symbol, start, end)
  if (bars.length === 0) { const mini = miniSymbol(symbol); if (mini && mini !== symbol) bars = await fetchBars(mini, start, end) }
  return bars
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function postExit(bars: any[], dir: string | null, exitPrice: number | null, exitTime: string | null) {
  if (!dir || exitPrice == null || !exitTime) return null
  const exitMs = new Date(exitTime).getTime(); const endMs = exitMs + WINDOW_MIN * 60_000
  const w = bars.filter(b => { const t = new Date(b.ts).getTime(); return t > exitMs && t <= endMs })
  if (w.length === 0) return null
  let maxHigh = -Infinity, minLow = Infinity
  for (const b of w) { if (b.high > maxHigh) maxHigh = b.high; if (b.low < minLow) minLow = b.low }
  const isLong = dir === 'long'
  const fav = isLong ? Math.max(0, maxHigh - exitPrice) : Math.max(0, exitPrice - minLow)
  const against = isLong ? Math.max(0, exitPrice - minLow) : Math.max(0, maxHigh - exitPrice)
  return { fav, against }
}

;(async () => {
  const { data: days } = await sb.from('trading_days').select('id, date').order('date', { ascending: true })
  let updated = 0, skipped = 0, daysDone = 0
  for (const d of days ?? []) {
    const { data: trades } = await sb.from('trades').select('id, symbol, direction, exit_price, exit_time').eq('trading_day_id', d.id)
    if (!trades || !trades.length) continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const barsCache = new Map<string, any[]>()
    for (const t of trades) {
      if (!t.symbol || !t.exit_time || t.exit_price == null || !t.direction) { skipped++; continue }
      let bars = barsCache.get(t.symbol)
      if (!bars) { bars = await fetchAllBars(t.symbol, d.date); barsCache.set(t.symbol, bars) }
      const pe = postExit(bars, t.direction, t.exit_price, t.exit_time)
      if (!pe) { skipped++; continue }
      const { error } = await sb.from('trades').update({ post_exit_favorable_pts: pe.fav, post_exit_against_pts: pe.against }).eq('id', t.id)
      if (error) { console.log('update err', t.id, error.message) } else updated++
    }
    daysDone++
    if (daysDone % 20 === 0) console.log(`...${daysDone} days · ${updated} trades updated`)
  }
  console.log(`DONE. ${updated} trades updated · ${skipped} skipped (no exit data or no bars).`)
})()
