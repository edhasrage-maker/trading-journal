/**
 * Unit tests for the tag carry-over on import (src/lib/import-tag-columns.ts)
 * and the quote-aware CSV reader it relies on (src/lib/csv-trade-import.ts).
 *   npx tsx scripts/test-import-tag-columns.ts
 */
import { parseTradeCsv, readCsvRecords } from '../src/lib/csv-trade-import.ts'
import { detectTagColumns, readTagMap, splitTagValues, suggestTarget, tagColumnsInFile, tagsForRow, MAX_TAG_LEN } from '../src/lib/import-tag-columns.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`) }
}

const CSV = [
  'Symbol,Side,Entry Price,Exit Price,Entry Time,Exit Time,Qty,P&L,Setups,Mistakes,Emotion,A+ Checklist,Notes,Account,Reviewed,Rating,Fees',
  'MNQ,Long,100,110,2026-10-01T14:00:00Z,2026-10-01T14:05:00Z,1,20,"break and retest, VWAP Reclaim",,Calm,"HTF aligned; liquidity sweep","Waited for the retest.",Apex-01,true,4,0.5',
  'MNQ,Short,110,115,2026-10-01T15:00:00Z,2026-10-01T15:04:00Z,2,-20,Break & Retest,"FOMO entry, moved stop",Frustrated,HTF aligned,"Chased it.',
  'Second line of the note, after a line break.",Apex-01,false,2,0.5',
  '',
  'MNQ,Long,100,104,2026-10-02T14:00:00Z,2026-10-02T14:02:00Z,1,8,ORB,,,,,Apex-01,false,3,0.5',
].join('\r\n')

console.log('quote-aware reader')
{
  const recs = readCsvRecords(CSV)
  check('4 records (header + 3 trades; blank line dropped; quoted line break kept inside its cell)', recs.length === 4, recs.length)
  check('the multi-line note stays one cell', recs[2][12] === 'Chased it.\r\nSecond line of the note, after a line break.', recs[2][12])
  check('doubled quotes unescape', readCsvRecords('a,b\n"say ""hi""",2')[1][0] === 'say "hi"')
}

console.log('parseTradeCsv keeps cells and headers')
{
  const r = parseTradeCsv(CSV)
  check('3 trades parsed', r.trades.length === 3, r.trades.length)
  check('headers as written', r.headers[7] === 'P&L' && r.headers.length === 17)
  check('cells aligned with headers', r.trades[1].cells[r.headers.indexOf('Mistakes')] === 'FOMO entry, moved stop')
}

console.log('detectTagColumns')
{
  const recs = readCsvRecords(CSV)
  const cols = detectTagColumns(recs[0], recs.slice(1))
  const names = cols.map(c => c.header)
  check('offers the word columns', ['Setups', 'Mistakes', 'Emotion', 'A+ Checklist', 'Notes', 'Account'].every(n => names.includes(n)), names)
  check('never offers trade fields', !names.includes('Symbol') && !names.includes('Side') && !names.includes('P&L') && !names.includes('Qty'))
  check('never offers numbers / true-false columns', !names.includes('Reviewed') && !names.includes('Rating') && !names.includes('Fees'))
  const setups = cols.find(c => c.header === 'Setups')!
  check('"Break & Retest" and "break and retest" count as one tag', setups.distinct === 3, setups)
  const by = (h: string) => cols.find(c => c.header === h)!.suggested
  check('Setups → built-in Setups', JSON.stringify(by('Setups')) === JSON.stringify({ kind: 'group', key: 'setups', label: 'Setups', isNew: false }))
  check('Emotion → built-in Emotions', by('Emotion').kind === 'group' && (by('Emotion') as { key: string }).key === 'emotions')
  check('A+ Checklist → a NEW group under its own name', JSON.stringify(by('A+ Checklist')) === JSON.stringify({ kind: 'group', key: 'a_checklist', label: 'A+ Checklist', isNew: true }), by('A+ Checklist'))
  check('Notes → notes', by('Notes').kind === 'notes')
  check('Account → leave out', by('Account').kind === 'skip')
}

console.log('tagColumnsInFile')
{
  const NL = String.fromCharCode(10), TAB = String.fromCharCode(9)
  check('a trade CSV with tag columns offers them', tagColumnsInFile(CSV).length > 0)
  check('a CSV whose only extra column is left out goes straight through', tagColumnsInFile('Symbol,P&L,Date,Account' + NL + 'MNQ,20,2026-10-01,Apex-01').length === 0)
  check('a Sierra Chart log is never offered', tagColumnsInFile(['DateTime', 'ActivityType', 'FillPrice', 'Notes'].join(TAB) + NL + ['2026-10-01', 'Fills', '100', 'hello'].join(TAB)).length === 0)
}

console.log('suggestTarget by name')
{
  check('Playbook → Setups', (suggestTarget('Playbook') as { key?: string }).key === 'setups')
  check('Day Type → day_type', (suggestTarget('Day Type') as { key?: string }).key === 'day_type')
  check('Orderflow → order_flow', (suggestTarget('Orderflow') as { key?: string }).key === 'order_flow')
  check('Comments → notes', suggestTarget('Comments').kind === 'notes')
  check('Status → leave out', suggestTarget('Status').kind === 'skip')
  check('"Day type" typed as a new group lands on the built-in', (suggestTarget('day_type') as { isNew?: boolean }).isNew === false)
}

console.log('splitTagValues')
{
  check('commas, semicolons, pipes', JSON.stringify(splitTagValues('a, b;c | d')) === JSON.stringify(['a', 'b', 'c', 'd']))
  check('empty → none', splitTagValues('  ').length === 0 && splitTagValues(undefined).length === 0)
}

console.log('readTagMap (what the server accepts)')
{
  const headers = ['Setups', 'Notes', 'A+ Checklist']
  const m = readTagMap([
    { header: 'Setups', target: { kind: 'group', key: 'setups', label: 'whatever' } },
    { header: 'Notes', target: { kind: 'notes' } },
    { header: 'A+ Checklist', target: { kind: 'group', key: 'a_checklist', label: 'A+ Checklist' } },
    { header: 'Nope', target: { kind: 'notes' } },
    { header: 'Setups', target: { kind: 'skip' } },
    { header: 'A+ Checklist', target: { kind: 'group', key: 'Bad Key!' } },
  ], headers)
  check('keeps 3 valid entries, drops unknown header / repeat', m.length === 3, m)
  check('a built-in keeps its own label', m[0].target.kind === 'group' && m[0].target.label === 'Setups' && !m[0].target.isNew)
  check('a custom group is new', m[2].target.kind === 'group' && m[2].target.isNew)
  check('garbage → nothing', readTagMap('x', headers).length === 0 && readTagMap(null, headers).length === 0)
}

console.log('tagsForRow')
{
  const r = parseTradeCsv(CSV)
  const map = readTagMap([
    { header: 'Setups', target: { kind: 'group', key: 'setups' } },
    { header: 'Mistakes', target: { kind: 'group', key: 'mistakes' } },
    { header: 'A+ Checklist', target: { kind: 'group', key: 'a_checklist', label: 'A+ Checklist' } },
    { header: 'Notes', target: { kind: 'notes' } },
    { header: 'Account', target: { kind: 'skip' } },
  ], r.headers)
  const a = tagsForRow(r.trades[0].cells, r.headers, map)
  check('lowercase tag gets a capital first letter only', a.tags.setups?.[0] === 'Break and retest', a.tags.setups)
  check('mixed-case tag kept as typed', a.tags.setups?.[1] === 'VWAP Reclaim')
  check('custom group filled', JSON.stringify(a.tags.a_checklist) === JSON.stringify(['HTF aligned', 'Liquidity sweep']), a.tags.a_checklist)
  check('empty column adds no key', !('mistakes' in a.tags))
  check('skip column ignored', !Object.values(a.tags).flat().includes('Apex-01'))
  check('notes carried', a.notes === 'Waited for the retest.')
  const b = tagsForRow(r.trades[1].cells, r.headers, map)
  check('multi-line note carried whole', b.notes?.includes('Second line') === true)
  check('two mistakes split', b.tags.mistakes?.length === 2)
  const dupes = tagsForRow(['A, a , A'], ['Setups'], readTagMap([{ header: 'Setups', target: { kind: 'group', key: 'setups' } }], ['Setups']))
  check('dedupes within a group', dupes.tags.setups?.length === 1, dupes)
  const long = tagsForRow(['x'.repeat(MAX_TAG_LEN + 1) + ', ok'], ['Setups'], readTagMap([{ header: 'Setups', target: { kind: 'group', key: 'setups' } }], ['Setups']))
  check('over-long value dropped and counted', long.dropped === 1 && long.tags.setups?.length === 1, long)
}

if (failures) { console.error(`\n${failures} failing`); process.exit(1) }
console.log('\nall import-tag-columns checks passed')
