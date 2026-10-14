/**
 * Recompute trades.mfe_dollars_per_leg — MFE on the AVAILABLE position
 * (src/lib/available-mfe.ts) — for ONE trader's scaled-out trades on the hosted
 * DB, from the shared 1-minute bars. Replaces values written by the old per-leg
 * walk (later legs measured from the previous exit, the whole exit minute
 * counted, nothing at all when two exits shared a minute).
 *
 * Dry run by default; pass --commit to write. Every read and write is scoped to
 * --user (default: the founder). Trades with one exit are skipped — readers use
 * the position's best price for those, whatever is stored.
 *
 *   npx tsx scripts/backfill-available-mfe.ts [--user=<uuid>] [--commit]
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { mfeMaePoints } from '../src/lib/analytics.ts'
import { availableMfeDollars, exitEvents, type MinuteBar } from '../src/lib/available-mfe.ts'
import { chartSeriesRoot } from '../src/lib/futures-symbols.ts'

const arg = (name: string, dflt: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt
const UID = arg('user', 'fa3fb352-9538-44cc-8ce1-1c76f307044c')
const COMMIT = process.argv.includes('--commit')

for (const l of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/)
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const URL = process.env.PUBLIC_SUPABASE_URL, KEY = process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) { console.error('Missing PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_SERVICE_ROLE_KEY in .env.public-feed'); process.exit(1) }
const sb = createClient(URL, KEY)

async function bars(symbol: string, from: string, to: string): Promise<MinuteBar[]> {
  for (const s of [symbol, chartSeriesRoot(symbol)].filter((x, i, a) => x && a.indexOf(x) === i)) {
    const { data } = await sb.from('ohlcv_bars').select('ts, high, low').eq('symbol', s).gte('ts', from).lte('ts', to).order('ts')
    if (data && data.length > 0) return data.map(b => ({ ts: b.ts as string, high: Number(b.high), low: Number(b.low) }))
  }
  return []
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trades: any[] = []
  for (let p = 0; p < 50; p++) {
    const { data, error } = await sb.from('trades')
      .select('id, entry_time, exit_time, entry_price, exit_price, direction, quantity, symbol, pnl, exits_json, high_during_position, low_during_position, mfe_dollars_per_leg')
      .eq('user_id', UID).order('id').range(p * 1000, p * 1000 + 999)
    if (error) throw new Error(error.message)
    trades.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
  }
  const scaled = trades.filter(t => exitEvents(t.exits_json).length >= 2)
  console.log(`${trades.length} trades for ${UID}; ${scaled.length} scaled out (2+ exits). ${COMMIT ? 'WRITING' : 'dry run'}`)

  let changed = 0, same = 0, skipped = 0, noBars = 0
  for (const t of scaled) {
    const xc = mfeMaePoints(t)
    if (!xc || !t.entry_time || !t.symbol) { skipped++; continue }
    const lastExit = exitEvents(t.exits_json).at(-1)!.time
    const b = await bars(t.symbol, new Date(Date.parse(t.entry_time) - 60_000).toISOString(), lastExit)
    if (b.length === 0) noBars++
    const raw = availableMfeDollars(t, xc.mfe, b)
    if (raw == null) { skipped++; continue }
    // You cannot bank more than you were offered (founder invariant).
    const value = Math.round((t.pnl > 0 ? Math.max(raw, t.pnl) : raw) * 100) / 100
    const before = t.mfe_dollars_per_leg
    if (before != null && Math.abs(before - value) < 0.01) { same++; continue }
    changed++
    console.log(`  ${t.entry_time.slice(0, 16)} ${t.symbol} ${t.direction} pnl ${t.pnl}: ${before ?? 'null'} → ${value}${b.length ? '' : ' (no bars: fills only)'}`)
    if (COMMIT) {
      const { error } = await sb.from('trades').update({ mfe_dollars_per_leg: value }).eq('id', t.id).eq('user_id', UID)
      if (error) throw new Error(`${t.id}: ${error.message}`)
    }
  }
  console.log(`\n${changed} ${COMMIT ? 'updated' : 'would change'}, ${same} already right, ${skipped} skipped, ${noBars} without bars (fills only).`)
}
main().catch(e => { console.error(e); process.exit(1) })
