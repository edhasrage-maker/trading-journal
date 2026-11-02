/**
 * Stacking one direction reads where the market went (src/lib/behavioral-proxies.ts):
 * a losing run of same-direction trades is "pressing a losing bias" only when
 * price went 1 ATR or more against it over the run (first entry → last exit,
 * the run's own fills); 1 ATR or more its way = "right direction, the entries
 * cost you"; in between = "price went nowhere". Founder-approved mockup
 * (Option 3), 2026-11-02. First entries, last exits and run totals below are
 * the founder's real days (Oct 29's middle legs are filled in). Pure.
 *
 *   npx tsx scripts/test-stack-market.ts
 */
import { computeBehavioralProxies, behavioralProxiesPromptBlock, type ProxyTrade } from '../src/lib/behavioral-proxies.ts'

let failed = 0
const check = (name: string, ok: boolean, got?: unknown) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || got === undefined ? '' : `\n       got: ${JSON.stringify(got)}`}`); if (!ok) failed++ }
const at = (date: string, hms: string) => new Date(`${date}T${hms}-08:00`).toISOString()

type Leg = [inAt: string, outAt: string, dir: 'long' | 'short', entry: number, exit: number, pnl: number, atr?: number | null, symbol?: string]
const day = (date: string, legs: Leg[]): ProxyTrade[] => legs.map(([inAt, outAt, dir, entry, exit, pnl, atr, symbol], i) => ({
  id: `${date}-${i + 1}`, direction: dir, entry_time: at(date, inAt), exit_time: at(date, outAt), pnl, quantity: 3,
  entry_price: entry, exit_price: exit, symbol: symbol ?? 'MNQZ6.CME', entry_atr_1m: atr ?? null,
}))
const stack = (trades: ProxyTrade[], opts = {}) => computeBehavioralProxies(trades, null, opts).proxies.find(p => p.key === 'stacking')!

console.log('Nov 2: four longs into the drop — losing bias')
{
  const nov2 = day('2026-11-02', [
    ['07:56:32', '07:56:40', 'long', 28762, 28745.5, -99, 20.3],
    ['07:59:09', '08:07:03', 'long', 28728, 28730, 12, 19.95],
    ['08:12:20', '08:14:15', 'long', 28704, 28692.33, -70, 21.4],
    ['08:15:51', '08:17:09', 'long', 28699, 28680, -114, 19.87],
    ['09:52:09', '09:53:10', 'short', 28558, 28520.33, 753.5, 28.23],
  ])
  const s = stack(nov2)
  check('reading is against', s.market?.reading === 'against', s.market)
  check('evidence is trades 1-4', s.evidence.join(',') === '1,2,3,4', s.evidence)
  check('detail as in the mockup',
    s.detail === '4 consecutive longs for −$271 — pressing a losing bias. NQ went 82 pts against you from your first entry (28,762) to your last exit (28,680).',
    s.detail)
  check('still a flag', s.severity === 'flag')
  check('coach block carries the same sentence',
    behavioralProxiesPromptBlock(nov2).includes('⚠ Stacking one direction: 4 consecutive longs for −$271 — pressing a losing bias. NQ went 82 pts against you'),
    behavioralProxiesPromptBlock(nov2))
}

console.log('Jun 30: seven longs while NQ rose 2.1 ATR — right direction')
{
  const jun30 = day('2026-06-30', [
    ['10:17:56', '10:27:18', 'long', 30538, 30526.75, -225, 8.79],
    ['10:28:55', '10:30:20', 'long', 30531, 30522.5, -170],
    ['10:34:12', '10:34:14', 'long', 30526, 30525.55, -9],
    ['10:50:32', '11:05:53', 'long', 30518, 30517, -20],
    ['12:36:56', '12:50:30', 'long', 30562, 30547.5, -290],
    ['12:52:32', '12:52:33', 'long', 30555, 30554.63, -7.5],
    ['12:52:46', '12:52:48', 'long', 30554, 30556.6, 52],
  ].map(l => [...l.slice(0, 6), l[6], 'MNQU6.CME'] as Leg))
  const s = stack(jun30)
  check('reading is with', s.market?.reading === 'with', s.market)
  check('detail as in the mockup',
    s.detail === '7 consecutive longs for −$669 — right direction, the entries cost you. NQ went 19 pts your way (2.1 ATR) from your first entry (30,538) to your last exit (30,556.6).',
    s.detail)
}

console.log('Oct 29: five shorts, NQ under 1 ATR against — went nowhere')
{
  const oct29 = day('2026-10-29', [
    ['08:12:00', '08:13:00', 'short', 29604, 29610, -150, 26.85],
    ['08:15:00', '08:16:00', 'short', 29597, 29605, -120],
    ['08:18:00', '08:19:00', 'short', 29599, 29606, -105],
    ['08:21:00', '08:22:00', 'short', 29600, 29612, -180],
    ['08:26:00', '08:27:00', 'short', 29604.05, 29618.75, -108],
  ])
  const s = stack(oct29)
  check('reading is flat', s.market?.reading === 'flat', s.market)
  check('detail as in the mockup',
    s.detail === '5 consecutive shorts for −$663 — price went nowhere, the entries cost you. NQ went 15 pts against you (under 1 ATR) from your first entry (29,604) to your last exit (29,618.75).',
    s.detail)
  check('page live ATR wins over the stored one', stack(oct29, { atrByTradeId: { '2026-10-29-1': 10 } }).market?.reading === 'against')
}

console.log('edges')
{
  const noAtr = day('2026-11-02', [
    ['07:56:32', '07:56:40', 'long', 28762, 28745.5, -99, null],
    ['07:59:09', '08:07:03', 'long', 28728, 28730, 12],
    ['08:12:20', '08:14:15', 'long', 28704, 28692.33, -70],
  ])
  const s = stack(noAtr)
  check('no ATR at the first entry: P&L-only wording, no market claim',
    s.market === undefined && s.detail === '3 consecutive longs for −$157 — pressing a losing bias', s)

  const winning = day('2026-11-02', [
    ['07:56:32', '07:56:40', 'long', 100, 110, 50, 5],
    ['07:59:09', '08:07:03', 'long', 110, 120, 50],
    ['08:12:20', '08:14:15', 'long', 120, 115, -20],
  ])
  const w = stack(winning)
  check('a winning run is untouched', w.market === undefined && w.detail === '3 consecutive longs (+$80)', w)

  // Aug 26 ES: small points keep their ticks.
  const es = day('2026-08-26', [
    ['08:27:09', '08:29:24', 'short', 7691.25, 7692.75, -75, 1.86, 'MESU6.CME'],
    ['08:46:00', '08:47:55', 'short', 7692.5, 7694, -75, null, 'MESU6.CME'],
    ['10:05:00', '10:08:16', 'short', 7680, 7682.5, -125, null, 'MESU6.CME'],
  ])
  const e = stack(es)
  check('ES run reads in ES points to the tick', e.market?.reading === 'with' && e.market.text.startsWith('ES went 8.75 pts your way (4.7 ATR)'), e.market)

  // A run that switches NQ → ES is measured in the instrument it starts in.
  const mixed = day('2026-10-08', [
    ['08:10:00', '08:12:00', 'long', 7827.25, 7825, -100, 2.58, 'MESZ6.CME'],
    ['08:20:00', '08:22:00', 'long', 7823.5, 7821.75, -90, null, 'MESZ6.CME'],
    ['09:00:00', '09:05:00', 'long', 31230, 31220, -200, null, 'MNQZ6.CME'],
  ])
  const m = stack(mixed)
  check('mixed run measured in its first instrument', m.market?.text.startsWith('ES went 5.5 pts against you') === true, m.market)
}

if (failed) { console.log(`\n${failed} failed`); process.exit(1) }
console.log('\nall passed')
