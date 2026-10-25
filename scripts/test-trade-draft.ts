/**
 * Tests for unsaved trade-form drafts (src/lib/trade-draft.ts): what counts as
 * an edit, how a draft is laid back over the trade as it is now, and that the
 * storage calls never throw. Pure: no network, no database; localStorage is a
 * stand-in.
 *
 *   npx tsx scripts/test-trade-draft.ts   (also wired into `npm test`)
 */
import {
  clearTradeDraft, draftSignature, editedFields, pickDraftFields, readTradeDraft,
  restoreDraft, tradeDraftKey, writeTradeDraft, type DraftFields,
} from '../src/lib/trade-draft.ts'

let failures = 0
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${got === undefined ? '' : ` — got ${JSON.stringify(got)}`}`) }
}

const saved: DraftFields = {
  direction: 'long', symbol: 'MNQZ6', entry_time: '07:42', entry_price: '21000',
  stop_price: '20990', tp1_price: '21020', quantity: '5', pnl: '150',
  notes: 'Waited for the reclaim.', tags: { setups: ['Break and Retest'], emotions: ['Stable'] },
}

console.log('what counts as an edit')
check('the same fields compare equal', draftSignature(saved) === draftSignature({ ...saved }))
check('tag order does not matter',
  draftSignature({ ...saved, tags: { emotions: ['Stable'], setups: ['Break and Retest'] } }) === draftSignature(saved))
check('an empty tag category is the same as none',
  draftSignature({ ...saved, tags: { ...saved.tags, mistakes: [] } }) === draftSignature(saved))
check('a legacy single-string day_type equals the one-item list',
  draftSignature({ ...saved, tags: { ...saved.tags, day_type: 'Trend' as unknown as string[] } })
    === draftSignature({ ...saved, tags: { ...saved.tags, day_type: ['Trend'] } }))
check('typing in notes is an edit', draftSignature({ ...saved, notes: saved.notes + ' Then' }) !== draftSignature(saved))
check('adding a tag is an edit',
  draftSignature({ ...saved, tags: { ...saved.tags, mistakes: ['Early exit'] } }) !== draftSignature(saved))
check('the wider form state is trimmed to the draft fields',
  JSON.stringify(Object.keys(pickDraftFields({ ...saved, screenshot_url: 'x' } as DraftFields)).sort())
    === JSON.stringify(Object.keys(saved).sort()))

console.log('which fields a draft re-applies')
{
  const edited = { ...saved, notes: 'Waited for the reclaim. Took it early.', tags: { setups: ['Break and Retest'] } }
  const e = editedFields(saved, edited)
  check('only the notes and the tags', JSON.stringify(Object.keys(e).sort()) === '["notes","tags"]', Object.keys(e))
  check('nothing when nothing changed', Object.keys(editedFields(saved, { ...saved })).length === 0)
}

console.log('restoring a draft over the trade as it is now')
{
  const draft = { v: 2 as const, savedAt: '2026-10-24T20:00:00Z', from: saved, fields: { ...saved, notes: 'My typed notes' } }
  // A background job moved the stop since the draft was written.
  const now = { ...saved, stop_price: '20995' }
  const r = restoreDraft(draft, now)
  check('the typed notes come back', r?.notes === 'My typed notes', r?.notes)
  check('the newer stop on the server is kept, not reverted', r?.stop_price === '20995', r?.stop_price)
  check('a draft that changes nothing restores nothing', restoreDraft({ ...draft, fields: saved }, saved) === null)
  check('a draft already saved restores nothing',
    restoreDraft(draft, { ...saved, notes: 'My typed notes' }) === null)
}

console.log('storage')
{
  const store = new Map<string, string>()
  ;(globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    },
  }
  check('one key per trade, one per day for a new trade',
    tradeDraftKey('abc', '2026-10-24') === 'trade-draft:abc' && tradeDraftKey(null, '2026-10-24') === 'trade-draft:new:2026-10-24')
  const key = tradeDraftKey('abc', '2026-10-24')
  writeTradeDraft(key, saved, { ...saved, notes: 'x' })
  check('a written draft reads back', readTradeDraft(key)?.fields.notes === 'x')
  clearTradeDraft(key)
  check('a cleared draft is gone', readTradeDraft(key) === null)
  store.set(key, '{not json')
  check('a corrupt draft reads as none', readTradeDraft(key) === null)
  store.set(key, JSON.stringify({ v: 1, base: null, fields: saved }))
  check('an old-format draft reads as none', readTradeDraft(key) === null)

  const blocked = () => { throw new Error('SecurityError') }
  ;(globalThis as { window?: unknown }).window = { localStorage: { getItem: blocked, setItem: blocked, removeItem: blocked } }
  let threw = false
  try { writeTradeDraft(key, saved, saved); readTradeDraft(key); clearTradeDraft(key) } catch { threw = true }
  check('blocked storage never throws', !threw)
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall trade-draft tests passed')
