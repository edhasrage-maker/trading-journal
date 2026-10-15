/**
 * Sierra (and NinjaTrader) fill times read in the uploader's timezone
 * (naiveToUtc in src/lib/sc-importer.ts). Until 2026-10-15 the milliseconds
 * were counted twice whenever a timezone was given — every hosted import stored
 * fills late by their own ms (09:45:07.625 → 09:45:08.250), which could even
 * swap the order of two fills a few ms either side of a second.
 *
 *   npx tsx scripts/test-sierra-times.ts
 */
import { naiveToUtc, parseSierraChartLog } from '../src/lib/sc-importer.ts'
import { legacyCombinedId } from '../src/lib/sc-combine.ts'

let failed = 0
const check = (name: string, ok: boolean, got?: unknown) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || got === undefined ? '' : `\n       got: ${JSON.stringify(got)}`}`); if (!ok) failed++ }
const LA = 'America/Los_Angeles'
const iso = (...a: Parameters<typeof naiveToUtc>) => naiveToUtc(...a).toISOString()

console.log('naiveToUtc')
check('summer (PDT): ms kept once', iso(2026, 7, 1, 9, 45, 7, 625, LA) === '2026-07-01T16:45:07.625Z', iso(2026, 7, 1, 9, 45, 7, 625, LA))
check('.999 stays in its own second', iso(2026, 10, 14, 8, 29, 22, 999, LA) === '2026-10-14T15:29:22.999Z', iso(2026, 10, 14, 8, 29, 22, 999, LA))
check('whole seconds unchanged', iso(2026, 10, 14, 8, 29, 22, 0, LA) === '2026-10-14T15:29:22.000Z')
check('winter (PST)', iso(2026, 1, 15, 9, 30, 0, 500, LA) === '2026-01-15T17:30:00.500Z', iso(2026, 1, 15, 9, 30, 0, 500, LA))
check('spring-forward day, after the switch', iso(2026, 3, 8, 9, 0, 0, 250, LA) === '2026-03-08T16:00:00.250Z', iso(2026, 3, 8, 9, 0, 0, 250, LA))
check('fall-back day, after the switch', iso(2026, 11, 1, 9, 0, 0, 750, LA) === '2026-11-01T17:00:00.750Z', iso(2026, 11, 1, 9, 0, 0, 750, LA))
check('fall-back day, early morning', iso(2026, 11, 1, 3, 0, 0, 750, LA) === '2026-11-01T11:00:00.750Z', iso(2026, 11, 1, 3, 0, 0, 750, LA))
check('Globex open on the spring-forward Sunday', iso(2026, 3, 8, 15, 0, 0, 0, LA) === '2026-03-08T22:00:00.000Z', iso(2026, 3, 8, 15, 0, 0, 0, LA))
check('another zone (New York)', iso(2026, 7, 1, 12, 45, 7, 625, 'America/New_York') === '2026-07-01T16:45:07.625Z')
check('order kept across a second boundary', naiveToUtc(2026, 7, 1, 9, 45, 7, 999, LA).getTime() < naiveToUtc(2026, 7, 1, 9, 45, 8, 1, LA).getTime())
check('an unknown zone falls back instead of throwing', Number.isFinite(naiveToUtc(2026, 7, 1, 9, 45, 7, 625, 'Not/AZone').getTime()))

console.log('through the Sierra parser')
{
  const HEAD = ['ActivityType', 'DateTime', 'Symbol', 'InternalOrderID', 'Quantity', 'BuySell', 'FillPrice', 'TradeAccount', 'OpenClose']
  const f = (dt: string, id: string, side: string, px: string, oc: string) => ['Fills', dt, 'MNQU6.CME', id, '1', side, px, 'ACCT-PRO1', oc].join('\t')
  const text = [HEAD.join('\t'), f('2026-08-31  09:28:15.053000', '1', 'Buy', '7678.75', 'Open'), f('2026-08-31  09:36:23.966000', '2', 'Sell', '7684.75', 'Close')].join('\n')
  const r = parseSierraChartLog(text, LA).rows[0]
  check('entry and exit times are Sierra\'s, to the millisecond', r.entry_time_iso === '2026-08-31T16:28:15.053Z' && r.exit_time_iso === '2026-08-31T16:36:23.966Z' && r.exits[0].time === '2026-08-31T16:36:23.966Z', r)
}

console.log('combined ids imported before the fix')
{
  const id = 'combined:MNQM6.CME|short|30374|2026-05-29T15:00:24'
  check('a fill at .600 had the next second in its id', legacyCombinedId(id, '2026-05-29T15:00:24.600Z') === 'combined:MNQM6.CME|short|30374|2026-05-29T15:00:25')
  check('a fill at .400 kept its second: nothing to look up', legacyCombinedId(id, '2026-05-29T15:00:24.400Z') === null)
  check('.999 → next second', legacyCombinedId(id, '2026-05-29T15:00:24.999Z')?.endsWith('|2026-05-29T15:00:25') === true)
  check('not a combined id', legacyCombinedId('ACCT-PRO1:123', '2026-05-29T15:00:24.600Z') === null)
}

console.log(failed ? `\n${failed} FAILED` : '\nall sierra-times checks passed')
if (failed) process.exit(1)
