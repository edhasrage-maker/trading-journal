/**
 * Proof that a BLIND Deep Dive payload carries nothing from the fill second on.
 *   npx tsx scripts/deep-dive-blind-proof.ts [--json <file>] [--url <route url> --cookie <cookie header>]
 *
 * Builds blind payloads with the same builder /api/deep-dive/trade uses
 * (buildDeepDivePayload), for the trades in the local golden fixtures
 * (ORDERFLOW_FIXTURE_DIR), and checks every time-bearing field against the
 * fill:
 *   - the newest tick read is stamped before the fill second;
 *   - every 1m bar starts at or before the fill's minute, and only the fill's
 *     own minute may be partial;
 *   - the partial bar's volume equals the volume of the ticks before the fill
 *     (re-read independently, straight from the .scid file);
 *   - every 40-trade bubble ends before the fill second;
 *   - volume-at-price only references those bars;
 *   - the payload has no exit / P&L / tags / notes / screenshot fields at all.
 * Then it builds the same trade NON-blind and shows the extra data that the
 * blind payload withheld (bars and bubbles after the fill), so the cut is
 * visibly where the fill is.
 *
 * With --url/--cookie it checks a live route response instead of the builder.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs'
import { gunzipSync } from 'zlib'
import { join } from 'path'
import { buildDeepDivePayload, type DeepDivePayload } from '../src/lib/orderflow/server/deep-dive-payload.ts'
import { ptToUtcMs } from '../src/lib/orderflow/pt-clock.ts'
import { ScidTickFile } from '../src/lib/orderflow/server/scid-ticks.ts'
import { contractFileForRoot } from '../src/lib/futures-contracts.ts'
import { SIERRA_DATA_DIR } from '../src/lib/import-scid-day.ts'
import { utcMsToSierraUs } from '../src/lib/orderflow/ticks.ts'

const FORBIDDEN = /exit|pnl|p_l|profit|tag|note|screenshot|score|mfe|mae|outcome|result/i

function allKeys(x: unknown, prefix = '', out: string[] = []): string[] {
  if (Array.isArray(x)) { if (x.length && typeof x[0] === 'object') allKeys(x[0], `${prefix}[]`, out); return out }
  if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { out.push(prefix + k); allKeys(v, `${prefix}${k}.`, out) }
  return out
}

export function checkBlind(p: DeepDivePayload, partialTicksVolume?: number) {
  const S = p.snapshot, fails: string[] = []
  const entry = S.times.entry                       // PT-clock seconds of the fill
  const entryMin = Math.floor(entry / 60) * 60
  const fill = Date.parse(S.cut.fill_utc)
  if (!p.blind || !S.cut.blind) fails.push('payload is not marked blind')
  if (S.cut.last_tick_utc && Date.parse(S.cut.last_tick_utc) >= Math.floor(fill / 1000) * 1000) fails.push(`last tick ${S.cut.last_tick_utc} is not before the fill second`)
  const bt = S.bars.t, n = bt.length
  const late = bt.filter(t => t > entryMin)
  if (late.length) fails.push(`${late.length} bars start after the fill minute`)
  if (S.has_partial && bt[n - 1] !== entryMin) fails.push('partial bar is not the fill minute')
  if (!S.has_partial && n && bt[n - 1] >= entryMin) fails.push('a bar at the fill minute is not marked partial')
  if (partialTicksVolume != null && S.has_partial && S.bars.v[n - 1] !== partialTicksVolume) fails.push(`partial bar volume ${S.bars.v[n - 1]} != pre-fill tick volume ${partialTicksVolume}`)
  const B = S.bubbles
  if (B && B.t.some(t => t >= entry)) fails.push('a 40-trade bubble ends at/after the fill second')
  if (S.vap.m.some(m => m >= n)) fails.push('volume-at-price references a bar that is not there')
  const keys = allKeys(p).filter(k => FORBIDDEN.test(k.split('.').pop() ?? ''))
  if (keys.length) fails.push(`outcome-like fields present: ${keys.join(', ')}`)
  if ('exits' in p) fails.push('exits present')
  return {
    fails,
    summary: {
      blind: p.blind, row: S.row, fill_utc: S.cut.fill_utc, last_tick_utc: S.cut.last_tick_utc, chart_ends: S.cutoff_label,
      bars: n, last_bar_pt: new Date(bt[n - 1] * 1000).toISOString().slice(11, 16), last_bar_partial: S.has_partial,
      last_bar_volume: S.bars.v[n - 1], bubbles: B?.n ?? 0,
      last_bubble_ends_pt: B ? new Date(B.t[B.t.length - 1] * 1000).toISOString().slice(11, 19) : null,
      live_bubble_trades: B?.live_trades ?? null, levels: S.levels.length, top_level_keys: Object.keys(p),
      build_ms: p.build_ms,
    },
  }
}

async function main() {
  const args = process.argv.slice(2)
  const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null
  const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : null
  if (url) {
    const cookie = args[args.indexOf('--cookie') + 1]
    const t0 = performance.now()
    const r = await fetch(url, { headers: { cookie } })
    const p = await r.json() as DeepDivePayload
    const ms = Math.round(performance.now() - t0)
    const { fails, summary } = checkBlind(p)
    console.log(JSON.stringify({ http: r.status, round_trip_ms: ms, ...summary }, null, 2))
    console.log(fails.length ? `FAIL: ${fails.join(' | ')}` : 'PASS: nothing at or after the fill second')
    process.exit(fails.length ? 1 : 0)
  }

  const FIX = process.env.ORDERFLOW_FIXTURE_DIR ?? 'D:/Documents/NQ_backtest/deepdive_fixtures'
  if (!existsSync(FIX)) { console.log(`no fixtures in ${FIX}`); return }
  const files = readdirSync(FIX).filter(f => /^row-\d+\.json\.gz$/.test(f))
  let bad = 0
  const out: unknown[] = []
  for (const f of files) {
    const r = JSON.parse(gunzipSync(readFileSync(join(FIX, f))).toString()).payload.row
    const entryUtcMs = ptToUtcMs(Date.parse(`${r.date}T${r.time}Z`))
    const row = {
      id: '00000000-0000-0000-0000-000000000000', symbol: `${r.inst}`, entry_time: new Date(entryUtcMs).toISOString(),
      entry_price: r.price, direction: r.direction, stop_price: null, tp1_price: null, entry_atr_1m: null,
      // outcome columns deliberately present on the row: the blind builder must not pass them through
      exit_time: new Date(entryUtcMs + 20 * 60_000).toISOString(), exit_price: r.price, exits_json: null,
    }
    const p = buildDeepDivePayload(row, { blind: true, atrStopTarget: 1, tp1RMultiple: 2 })
    // independent re-read of the fill minute's pre-fill ticks
    const tdate = new Date(Date.parse(`${r.date}T${r.time}Z`) + 9 * 3600_000).toISOString().slice(0, 10)
    const sf = new ScidTickFile(join(SIERRA_DATA_DIR, contractFileForRoot(r.inst, tdate)!))
    const fillSecUs = utcMsToSierraUs(Math.floor(entryUtcMs / 1000) * 1000)
    const minUs = utcMsToSierraUs(Math.floor(entryUtcMs / 60_000) * 60_000)
    const t = sf.read(minUs, fillSecUs); sf.close()
    let vol = 0; for (let i = 0; i < t.n; i++) vol += t.v[i]
    const { fails, summary } = checkBlind(p, vol)
    const full = buildDeepDivePayload(row, { blind: false, atrStopTarget: 1, tp1RMultiple: 2, nowMs: Date.now() })
    const withheld = {
      bars_after_fill: full.snapshot.bars.t.filter(x => x > p.snapshot.times.entry).length,
      bubbles_after_fill: full.snapshot.bubbles ? full.snapshot.bubbles.t.filter(x => x >= p.snapshot.times.entry).length : 0,
    }
    console.log(`${fails.length ? '✗' : '✓'} ${r.inst} ${r.date} ${r.time} — last tick ${summary.last_tick_utc} < fill ${summary.fill_utc}; last bar ${summary.last_bar_pt}${summary.last_bar_partial ? ' (partial, ' + summary.last_bar_volume + ' contracts = pre-fill ticks ' + vol + ')' : ''}; last bubble ends ${summary.last_bubble_ends_pt}; withheld: ${withheld.bars_after_fill} bars, ${withheld.bubbles_after_fill} bubbles${fails.length ? ' — ' + fails.join(' | ') : ''}`)
    if (fails.length) bad++
    out.push({ ...summary, withheld_vs_full_review: withheld })
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 2))
  console.log(bad ? `\n${bad} FAILED` : '\nall blind payloads end before the fill second')
  process.exit(bad ? 1 : 0)
}
main()
