/**
 * Tests for the batch day-rollup engine (src/lib/day-stats-batch.ts) against a
 * stand-in Supabase client.
 *   npx tsx scripts/test-day-stats-batch.ts
 *
 * The real case: after a deploy that changed the rollup, Recap → Dashboard took
 * 30+ seconds while the page rebuilt all 699 days and fired 699 UPDATEs at once
 * before rendering. The engine keeps the same numbers, writes a bounded number
 * at a time, and lets a background warm rebuild only what is actually stale.
 */
import { computeDayRollups, writeDayRollups, warmDayStats } from '../src/lib/day-stats-batch.ts'
import { computeDayStats, toStoredStats, STATS_VERSION, type TradeForStats } from '../src/lib/day-stats.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

type Row = Record<string, unknown>
/** A tiny PostgREST look-alike: select/in/eq/order/range/limit over in-memory
 *  tables, plus update().eq() that records writes. */
function fakeDb(tables: Record<string, Row[]>, opts: { failUpdates?: boolean; errorOn?: string } = {}) {
  const writes: Row[] = []
  let inFlight = 0, maxInFlight = 0, selects = 0
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])]
    let error: { message: string } | null = null
    let pickCols: string | null = null
    let patch: Row | null = null
    const q = {
      select(cols: string) {
        selects++
        pickCols = cols
        if (opts.errorOn && cols.includes(opts.errorOn)) error = { message: `column ${opts.errorOn} does not exist` }
        return q
      },
      in(col: string, vals: unknown[]) { rows = rows.filter(r => vals.includes(r[col])); return q },
      eq(col: string, val: unknown) { rows = rows.filter(r => r[col] === val); return q },
      order(col: string, o?: { ascending?: boolean }) {
        const dir = o?.ascending === false ? -1 : 1
        rows.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * dir); return q
      },
      range(a: number, b: number) { rows = rows.slice(a, b + 1); return q },
      limit(n: number) { rows = rows.slice(0, n); return q },
      maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }) },
      update(p: Row) { patch = p; return q },
      then(resolve: (v: unknown) => void) {
        if (patch) {
          inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
          const p = patch
          setTimeout(() => {
            inFlight--
            if (opts.failUpdates) resolve({ error: { message: 'permission denied' } })
            else { for (const r of rows) writes.push({ id: r.id, ...p }); resolve({ error: null }) }
          }, 1)
          return
        }
        const shaped = rows.map(r => {
          if (!pickCols || pickCols.includes('stats_json->')) {
            return { ...r, atr_stop: (r.stats_json as { exit?: { atr_stop?: number } } | null)?.exit?.atr_stop ?? null }
          }
          return r
        })
        resolve({ data: error ? null : shaped, error })
      },
    }
    return q
  }
  return { client: { from }, writes, stats: () => ({ maxInFlight, selects }) }
}

const trade = (id: string, day: string, symbol: string, pnl: number): TradeForStats & Row => ({
  id, trading_day_id: day, symbol, pnl, direction: 'long',
  entry_price: 100, exit_price: 101, stop_price: 99, tp1_price: 102, high_during_position: 102,
  low_during_position: 99.5, quantity: 1, tags_json: { setups: ['Break & Retest'] },
  entry_atr_1m: null, structure_5m_alignment: null, exits_json: null, mfe_dollars_per_leg: null,
} as unknown as TradeForStats & Row)

const day = (id: string, date: string, extra: Row = {}) => ({
  id, date, eod_pnl: null, day_type: null, day_types: null, ai_analysis_json: null, eod_ai_analysis_json: null, ...extra,
})

;(async () => {
  console.log('THE BATCH COMPUTES EXACTLY WHAT computeDayStats DOES, DAY BY DAY')
  {
    const days = [day('d1', '2026-10-13'), day('d2', '2026-10-12')]
    const trades = [trade('t1', 'd1', 'MESZ6.CME', 50), trade('t2', 'd1', 'MESZ6.CME', -25), trade('t3', 'd2', 'MNQZ6.CME', 80)]
    const contexts = [
      { trading_day_id: 'd1', symbol: 'NQ', atr_1m: 12 }, { trading_day_id: 'd1', symbol: 'ES', atr_1m: 3 },
      { trading_day_id: 'd2', symbol: 'NQ', atr_1m: 11 },
    ]
    const { client } = fakeDb({ trading_days: days, trades, market_context: contexts })
    const out = await computeDayRollups(client, days.map(({ id, date, eod_pnl, day_type, day_types }) => ({ id, date, eod_pnl, day_type, day_types })), 1)
    const direct = computeDayStats(days[0], trades.filter(t => t.trading_day_id === 'd1'), 3, { atrStopTarget: 1 })
    check('one rollup per day, in the order given', out.length === 2 && out[0].id === 'd1' && out[1].id === 'd2')
    check('day 1 matches computeDayStats on the same inputs', JSON.stringify(toStoredStats(out[0])) === JSON.stringify(toStoredStats(direct)))
    check('each day only counts its own trades', out[0].trade_count === 2 && out[1].trade_count === 1)
    check('the ATR comes from the instrument traded (an MES day reads ES, not NQ)', out[0].atr_1m === 3, String(out[0].atr_1m))
    check('a day with a single context row uses it', out[1].atr_1m === 11, String(out[1].atr_1m))
    check('no days, no queries', (await computeDayRollups(fakeDb({}).client, [], 1)).length === 0)
  }

  console.log('\nTRADES THAT CAN\'T BE READ FAIL LOUDLY (a day without its trades would be wrong)')
  {
    const { client } = fakeDb({ trading_days: [day('d1', '2026-10-13')], trades: [] }, { errorOn: 'trading_day_id, id' })
    let threw = false
    try { await computeDayRollups(client, [{ id: 'd1', date: '2026-10-13', eod_pnl: null, day_type: null, day_types: null }], 1) } catch { threw = true }
    check('computeDayRollups throws', threw)
  }

  console.log('\nWRITES ARE BOUNDED AND STOP AT THE FIRST REFUSAL')
  {
    const days = Array.from({ length: 120 }, (_, i) => day(`d${i}`, `2026-01-${String(i % 28 + 1).padStart(2, '0')}`))
    const rollups = days.map(d => computeDayStats(d, [], null, { atrStopTarget: 1 }))
    const ok = fakeDb({ trading_days: days })
    const written = await writeDayRollups(ok.client, rollups)
    check('all 120 written', written === 120 && ok.writes.length === 120, String(written))
    check('never more than 16 in flight (was: all at once)', ok.stats().maxInFlight <= 16, String(ok.stats().maxInFlight))
    check('each write is stats-only at the current version',
      ok.writes.every(w => Object.keys(w).sort().join() === 'id,stats_json,stats_version' && w.stats_version === STATS_VERSION))
    const refused = fakeDb({ trading_days: days }, { failUpdates: true })
    const n = await writeDayRollups(refused.client, rollups)
    check('a refused write (read-only demo, pre-migration DB) stops the run early', n === 0 && refused.stats().maxInFlight <= 16)
  }

  console.log('\nTHE BACKGROUND WARM REBUILDS ONLY WHAT IS STALE')
  {
    const fresh = { stats_json: { exit: { atr_stop: 1 } }, stats_version: STATS_VERSION }
    const days = [
      day('fresh', '2026-10-13', fresh),
      day('old-version', '2026-10-12', { stats_json: { exit: { atr_stop: 1 } }, stats_version: STATS_VERSION - 1 }),
      day('no-cache', '2026-10-11', { stats_json: null, stats_version: STATS_VERSION }),
      day('other-atr', '2026-10-10', { stats_json: { exit: { atr_stop: 1.5 } }, stats_version: STATS_VERSION }),
    ]
    const db = fakeDb({ trading_days: days, trades: [], market_context: [], trader_profile: [] })
    const n = await warmDayStats(db.client, 'trader-a')
    check('three stale days rebuilt, the fresh one left alone', n === 3 && !db.writes.some(w => w.id === 'fresh'),
      `${n}: ${db.writes.map(w => w.id).join(',')}`)

    const allFresh = fakeDb({ trading_days: [day('fresh', '2026-10-13', fresh)], trader_profile: [] })
    check('a warm cache costs one read and writes nothing', (await warmDayStats(allFresh.client, 'trader-b')) === 0 && allFresh.writes.length === 0)

    const preMigration = fakeDb({ trading_days: days, trader_profile: [] }, { errorOn: 'stats_version' })
    check('a DB without the stats columns is a quiet no-op', (await warmDayStats(preMigration.client, 'trader-c')) === 0)

    const twice = fakeDb({ trading_days: days, trades: [], market_context: [], trader_profile: [] })
    const [a, b] = await Promise.all([warmDayStats(twice.client, 'trader-d'), warmDayStats(twice.client, 'trader-d')])
    check('two warms for the same trader at once share one run', a === 3 && b === 3 && twice.writes.length === 3, `${a},${b},${twice.writes.length}`)
  }

  console.log(failures === 0 ? '\nAll day-stats-batch tests pass.' : `\n${failures} failure(s).`)
  process.exit(failures === 0 ? 0 : 1)
})()
