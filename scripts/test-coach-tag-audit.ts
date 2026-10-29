/**
 * Tests for the coach tag audit (src/lib/coach-tag-audit.ts): what counts as
 * kept / taken off / to check / one the coach missed, what is never counted
 * (rule tags, day types, emotions, the trader's own earlier tags), and the
 * per-tag hit rate. Pure — no database.
 *
 *   npx tsx scripts/test-coach-tag-audit.ts   (also wired into `npm test`)
 */
import { auditTrade, hitRates, hitTotals, type AuditRow } from '../src/lib/coach-tag-audit'

let failures = 0
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${got === undefined ? '' : ` — got ${JSON.stringify(got)}`}`) }
}

let n = 0
const row = (o: Partial<AuditRow> & Pick<AuditRow, 'category' | 'label'>): AuditRow => ({
  id: `r${n++}`, trade_id: 'T1', source: 'assist', applied: true, conf: 'H', reason: null,
  proposed_at: '2026-10-28T06:23:03Z', decision: null, ...o,
})
const outcome = (a: ReturnType<typeof auditTrade>, label: string) => a.tags.find(t => t.label === label)?.outcome

console.log('outcomes against the trade as it is now')
{
  const rows = [
    row({ category: 'setups', label: 'Discretionary Trade', conf: 'M', reason: 'long into the flush' }),
    row({ category: 'confluences', label: 'Scratched', decision: 'kept' }),
    row({ category: 'trade_management', label: 'Early Exit' }),
    row({ category: 'confluences', label: '20 EMA Hold', source: 'screenshot', applied: false }),
    row({ category: 'confluences', label: 'Fade LTF structure', source: 'structure', applied: false }),
  ]
  const tags = {
    setups: ['Discretionary Trade'],
    confluences: ['Scratched', '20 EMA Hold'],
    // Early Exit taken off elsewhere; Fade LTF suggestion never clicked
  }
  const a = auditTrade('T1', rows, tags)
  check('coach tag still on, no ✓ → to check', outcome(a, 'Discretionary Trade') === 'pending', outcome(a, 'Discretionary Trade'))
  check('✓ → kept', outcome(a, 'Scratched') === 'kept')
  check('coach tag gone from the trade → taken off', outcome(a, 'Early Exit') === 'removed')
  check('suggestion the trader clicked → kept', outcome(a, '20 EMA Hold') === 'kept')
  check('suggestion saved without clicking → taken off', outcome(a, 'Fade LTF structure') === 'removed')
  check('the reason and how sure come through', a.tags[0].reason === 'long into the flush' && a.tags[0].conf === 'M')
  check('nothing added by hand', a.added.length === 0, a.added)
}

console.log('a ✓ taken back off still counts as taken off')
{
  const a = auditTrade('T1', [row({ category: 'setups', label: 'X', decision: 'kept' })], { setups: [] })
  check('kept then removed elsewhere → taken off', outcome(a, 'X') === 'removed')
}

console.log('a ✕ put back on by hand counts as kept')
{
  const a = auditTrade('T1', [row({ category: 'setups', label: 'X', decision: 'removed' })], { setups: ['X'] })
  check('removed then re-added → kept', outcome(a, 'X') === 'kept')
}

console.log('tags the coach missed')
{
  const rows = [
    row({ category: 'setups', label: 'Supply And Demand' }),
    row({ category: 'confluences', label: 'VWAP Hold', source: 'before', applied: false }),
  ]
  const tags = {
    setups: ['Supply And Demand'],
    confluences: ['VWAP Hold', 'Stacked Imbalance Target'],
    mistakes: ['Tape outside ±2', 'Chased'],
    day_type: ['Range Day'],
    emotions: ['Stable'],
  }
  const a = auditTrade('T1', rows, tags, ['Tape outside ±2'])
  const added = a.added.map(x => `${x.category}|${x.label}`).sort()
  check('a hand tag the coach didn\'t pick → you added', added.includes('confluences|Stacked Imbalance Target'), added)
  check('a mistake tag added by hand → you added', added.includes('mistakes|Chased'), added)
  check('the trader\'s tags from before the coach → not counted', !added.includes('confluences|VWAP Hold'), added)
  check('rule tags → not counted', !added.includes('mistakes|Tape outside ±2'), added)
  check('day types and emotions → not counted', !added.some(k => k.startsWith('day_type') || k.startsWith('emotions')), added)
  check('exactly two missed', added.length === 2, added)
}

console.log('never audited')
{
  const rows = [
    row({ category: 'day_type', label: 'Trend Day' }),
    row({ category: 'emotions', label: 'Stable' }),
    row({ category: 'mistakes', label: 'Tape outside ±2' }),
  ]
  const a = auditTrade('T1', rows, { day_type: ['Trend Day'], emotions: ['Stable'], mistakes: ['Tape outside ±2', 'Overtrade'] }, ['Tape outside ±2'])
  check('day type, emotion and rule-tag rows are dropped', a.tags.length === 0, a.tags)
  check('a trade with no coach tags never reports misses', a.added.length === 0, a.added)
}

console.log('another trade\'s rows are ignored')
{
  const a = auditTrade('T1', [row({ category: 'setups', label: 'X', trade_id: 'T2' })], { setups: ['X'] })
  check('no tags from T2', a.tags.length === 0)
}

console.log('one tag picked by two sources counts once')
{
  const rows = [
    row({ category: 'setups', label: 'X', source: 'screenshot', applied: false }),
    row({ category: 'setups', label: 'X', source: 'notes', applied: false, reason: null }),
  ]
  const a = auditTrade('T1', rows, { setups: ['X'] })
  check('one tag', a.tags.length === 1 && a.tags[0].outcome === 'kept', a.tags)
}

console.log('hit rates')
{
  const t1 = auditTrade('T1', [
    row({ trade_id: 'T1', category: 'setups', label: 'S&D', decision: 'kept' }),
    row({ trade_id: 'T1', category: 'mistakes', label: 'Overtrade' }),
  ], { setups: ['S&D'], mistakes: ['Overtrade'], confluences: ['VWAP'] })
  const t2 = auditTrade('T2', [
    row({ trade_id: 'T2', category: 'setups', label: 'S&D' }),
  ], { setups: [] })
  const rates = hitRates([t1, t2])
  const sd = rates.find(r => r.label === 'S&D')!
  check('S&D picked 2, kept 1, taken off 1, right 50%', sd.picked === 2 && sd.kept === 1 && sd.removed === 1 && sd.right === 0.5, sd)
  const ot = rates.find(r => r.label === 'Overtrade')!
  check('nothing decided → right is null, 1 to check', ot.right === null && ot.pending === 1, ot)
  const vw = rates.find(r => r.label === 'VWAP')!
  check('a missed tag gets its own row', vw.picked === 0 && vw.added === 1, vw)
  check('most-picked first', rates[0].label === 'S&D', rates.map(r => r.label))
  const tot = hitTotals(rates)
  check('totals', tot.picked === 3 && tot.kept === 1 && tot.removed === 1 && tot.pending === 1 && tot.right === 0.5, tot)
}

if (failures) { console.error(`\n${failures} failed`); process.exit(1) }
console.log('\nall passed')
