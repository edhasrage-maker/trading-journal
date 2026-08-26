/**
 * Unit tests for notes -> tag matching (src/lib/suggest-tags.ts), including
 * the ALIAS layer.
 *   npx tsx scripts/test-suggest-tags.ts
 * Plain tsx asserts; exits non-zero if anything failed.
 *
 * The cases below are REAL notes from the owner's trades, not invented ones.
 * Each was auto-tagging nothing before aliases existed.
 */
import {
  suggestTagsFromText, matchReason, addAlias, mergeTradeTags,
} from '../src/lib/suggest-tags.ts'
import type { TradeTag } from '../src/lib/supabase/types.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

let seq = 0
function tag(category: string, label: string, aliases: string[] | null = null): TradeTag {
  return {
    id: `t${++seq}`, category, label, sort_order: 0,
    description: null, aliases, created_at: '',
  } as TradeTag
}

/** The subset of the owner's real library these notes touch. */
const LIB: TradeTag[] = [
  tag('confluences', 'VWAP Hold/Bounce', ['at vwap', 'vwap reclaim', 'vwap bounce']),
  tag('confluences', 'Large Delta on DBP', ['huge delta', 'huge sellers', 'vps and delta']),
  tag('confluences', '2nd Attempt', ['second attempt', 'tried again']),
  tag('entry_model', 'Break of Candle', ['boc', 'entered boc']),
  tag('mistakes', 'Oversized', ['wrong size', 'too big', 'sized up']),
  tag('mistakes', 'FOMO', ['fomo', 'jumped in']),
  tag('mistakes', 'Chased', ['chased', 'chasing']),
  tag('order_flow', 'Delta Fade', ['delta fade', 'delta unwind']),
  tag('order_flow', 'Absorption/Exhaustion (Countermov)', ['no continuation', 'absorbed']),
  tag('setups', 'Break And Retest', ['break and retest', 'entered on the retest']),
]
const flat = (t: ReturnType<typeof suggestTagsFromText>): string[] =>
  Object.values(t).flatMap(v => (Array.isArray(v) ? v : [v])) as string[]

console.log('label matching still works (no regressions)')

check('an exact label matches', flat(suggestTagsFromText('classic break and retest here', LIB))
  .includes('Break And Retest'))
check('ordinals normalize: "2nd attempt" -> 2nd Attempt',
  flat(suggestTagsFromText('2nd attempt on this trade', LIB)).includes('2nd Attempt'))
check('a bare word still matches a one-word label',
  flat(suggestTagsFromText('total fomo entry', LIB)).includes('FOMO'))
check('unrelated prose matches nothing',
  flat(suggestTagsFromText('the weather was quite nice today', LIB)).length === 0)
check('text under 3 chars is ignored', flat(suggestTagsFromText('ok', LIB)).length === 0)

console.log('THE REAL NOTE that prompted this')

// "2nd attempt on this trade. Really annoying because I had the wrong size on
//  and took 2 bigger losses than I needed to. The increased volatility at VWAP
//  and delta unwind made me FOMO into the trade."
const note1 = '2nd attempt on this trade. Really annoying because I had the wrong size on '
  + 'and took 2 bigger losses than I needed to. The increased volatility at VWAP '
  + 'and delta unwind made me FOMO into the trade.'
const got1 = flat(suggestTagsFromText(note1, LIB))

check('2nd Attempt (worked before)', got1.includes('2nd Attempt'))
check('FOMO (worked before)', got1.includes('FOMO'))
check('VWAP Hold/Bounce — was MISSING, needs "hold"/"bounce" in the label',
  got1.includes('VWAP Hold/Bounce'))
check('Oversized — was MISSING, zero word overlap with "wrong size"',
  got1.includes('Oversized'))
check('Delta Fade — was MISSING, "delta" alone was not enough',
  got1.includes('Delta Fade'))
check('all five, and nothing spurious', got1.length === 5, `got ${got1.length}: ${got1.join(', ')}`)

console.log('other real notes')

const note2 = 'Sellers attempted to get lower 3x HUGE VPS and delta but no continuation so entered BOC'
const got2 = flat(suggestTagsFromText(note2, LIB))
check('"HUGE VPS and delta" -> Large Delta on DBP', got2.includes('Large Delta on DBP'))
check('"no continuation" -> Absorption/Exhaustion', got2.includes('Absorption/Exhaustion (Countermov)'))
check('"entered BOC" -> Break of Candle', got2.includes('Break of Candle'))

check('"Chased the shit out of this" -> Chased',
  flat(suggestTagsFromText('Chased the shit out of this because I did not have confidence', LIB))
    .includes('Chased'))
check('"entered on the retest" -> Break And Retest',
  flat(suggestTagsFromText('VWAP Reclaim at the pre-marked level — entered on the retest', LIB))
    .includes('Break And Retest'))
check('"VWAP Reclaim" -> VWAP Hold/Bounce',
  flat(suggestTagsFromText('VWAP Reclaim at the pre-marked level — entered on the retest', LIB))
    .includes('VWAP Hold/Bounce'))

console.log('aliases stay SPECIFIC — precision, not just recall')

// A multi-word alias needs all its words, so it cannot fire on a stray one.
check('"size" alone does NOT fire Oversized',
  !flat(suggestTagsFromText('reduced my size before the news', LIB)).includes('Oversized'))
check('"delta was flat" does NOT fire Delta Fade',
  !flat(suggestTagsFromText('delta was flat all session', LIB)).includes('Delta Fade'))
// Bare "vwap" is deliberately not an alias — "broke through VWAP" is the
// opposite trade to a hold, and a broad alias would tag it anyway.
check('"broke through VWAP" does NOT fire VWAP Hold/Bounce',
  !flat(suggestTagsFromText('price broke through VWAP and never looked back', LIB))
    .includes('VWAP Hold/Bounce'))
check('a tag with no aliases is unaffected',
  flat(suggestTagsFromText('no interest at all here', [tag('order_flow', 'No Interest')]))
    .includes('No Interest'))
check('a null alias list does not throw',
  flat(suggestTagsFromText('some notes about a trade', [tag('setups', 'IB Fade', null)])).length === 0)
check('empty/blank aliases are skipped',
  flat(suggestTagsFromText('anything at all', [tag('setups', 'IB Fade', ['', '   '])])).length === 0)

console.log('IB notes — and the exclusion that a one-word label needs')

const IB_LIB: TradeTag[] = [
  tag('setups', 'IB Fade', ['ib fade', 'faded the ib']),
  tag('confluences', 'IB Hold'),
  tag('confluences', 'IB Target for TP'),
  tag('confluences', 'IB Reclaim (Break & Fail)'),
  tag('confluences', '3rd Attempt', ['3rd time', 'third time']),
  tag('mistakes', 'Oversized', ['wrong size', 'too big', '!oversized ib']),
  tag('order_flow', 'Absorption/Exhaustion (Countermov)', ['selling fail', 'no continuation']),
]

// Bare "IB" is a LOCATION, not a setup, and four IB tags could claim it.
// Forcing one would be exactly the guess this system must not make.
check('bare "IB" alone tags nothing — four candidates, no basis to pick',
  flat(suggestTagsFromText('price pushed up to the IB and stalled there', IB_LIB)).length === 0)
check('a SPECIFIC IB reference still fires',
  flat(suggestTagsFromText('9 EMA continuation trade near IB to Hold', IB_LIB)).includes('IB Hold'))
check('"faded the IB" fires IB Fade via alias',
  flat(suggestTagsFromText('faded the IB after the failed extension', IB_LIB)).includes('IB Fade'))

// THE false positive. This note is about a WIDE INITIAL BALANCE, not position
// size, and it was tagging the mistake Oversized.
const ibNote = 'Took this bc of oversized IB way above avg and at ADR range. '
  + 'Dont think it was terrible and fit in the playbook.'
check('"oversized IB" no longer tags the Oversized MISTAKE',
  !flat(suggestTagsFromText(ibNote, IB_LIB)).includes('Oversized'))
check('...while plain "oversized" position language still does',
  flat(suggestTagsFromText('I was oversized on this one', IB_LIB)).includes('Oversized'))
check('an exclusion beats an alias too',
  !flat(suggestTagsFromText('wrong size because of oversized IB', IB_LIB)).includes('Oversized'))
check('exclusions do not leak to other tags',
  flat(suggestTagsFromText('oversized IB but I faded the IB anyway', IB_LIB)).includes('IB Fade'))

// The third real IB note, which tagged NOTHING before.
const ibNote3 = 'Kind of dicey but after watching big selling fail for the 3rd time on a >avg IB day I had to try it.'
const got3 = flat(suggestTagsFromText(ibNote3, IB_LIB))
check('"selling fail" -> Absorption/Exhaustion', got3.includes('Absorption/Exhaustion (Countermov)'))
check('"3rd time" -> 3rd Attempt', got3.includes('3rd Attempt'))

check('matchReason ignores a tag suppressed by an exclusion',
  matchReason(IB_LIB.find(t => t.label === 'Oversized')!, ibNote) === null)

console.log('matchReason — what the learning loop writes back')

check('reports the ALIAS that fired',
  matchReason(LIB.find(t => t.label === 'Oversized')!, 'I had the wrong size on') === 'wrong size')
check('reports the LABEL when the label itself matched',
  matchReason(LIB.find(t => t.label === 'FOMO')!, 'pure fomo') === 'FOMO')
check('returns null when nothing matched',
  matchReason(LIB.find(t => t.label === 'Oversized')!, 'a calm and disciplined entry') === null)

console.log('addAlias — the confirm -> alias loop')

const over = LIB.find(t => t.label === 'Oversized')!
check('a new phrase is appended', addAlias(over, 'way too heavy').includes('way too heavy'))
check('existing aliases are preserved', addAlias(over, 'way too heavy').includes('wrong size'))
check('duplicates are not re-added', addAlias(over, 'wrong size').length === (over.aliases ?? []).length)
check('dedup is case-insensitive', addAlias(over, 'WRONG SIZE').length === (over.aliases ?? []).length)
check('blank phrases are ignored', addAlias(over, '   ').length === (over.aliases ?? []).length)
// No point storing an alias the label would have matched anyway.
check('a phrase the LABEL already catches is not stored',
  addAlias(LIB.find(t => t.label === 'FOMO')!, 'total fomo').length
    === (LIB.find(t => t.label === 'FOMO')!.aliases ?? []).length)
check('the learning loop closes: confirm a phrase, it matches next time', (() => {
  const t = tag('mistakes', 'Oversized', [])
  const learned = { ...t, aliases: addAlias(t, 'way too heavy') } as TradeTag
  return flat(suggestTagsFromText('had it way too heavy on that one', [learned])).includes('Oversized')
})())

console.log('verb tense (notes are past tense, labels are infinitives)')

// The note that started this: the trader wrote "stop out before going" and the
// tag reads "Stopped Out Before Going" — one suffix apart, and it matched
// nothing.
{
  const tense = [
    tag('confluences', 'Stopped Out Before Going'),
    tag('setups', 'Break And Retest'),
    tag('confluences', 'VWAP Hold/Bounce'),
    tag('confluences', '9 EMA Hold'),
    tag('confluences', 'Sweep'),
  ]
  const hits = (text: string) => flat(suggestTagsFromText(text, tense))

  check('the real note catches BOTH tags',
    hits('Weekly Open break and retest. Another stop out before going').length === 2,
    JSON.stringify(hits('Weekly Open break and retest. Another stop out before going')))
  check('-ed: "stop out" matches "Stopped Out"',
    hits('stop out before going').includes('Stopped Out Before Going'))
  check('-ing: "stopping out" matches "Stopped Out"',
    hits('stopping out before going').includes('Stopped Out Before Going'))
  check('silent e: "bounced" matches "Bounce"',
    hits('vwap bounced off it').includes('VWAP Hold/Bounce'))
  check('irregular: "held" matches "Hold"',
    hits('held vwap into the close').includes('VWAP Hold/Bounce'))
  check('irregular: "broke" matches "Break"',
    hits('broke and retested the level').includes('Break And Retest'))
  check('irregular: "swept" matches "Sweep"',
    hits('swept the lows').includes('Sweep'))
  check('-ing: "holding" matches "Hold"',
    hits('holding the 9 ema').includes('9 EMA Hold'))

  // Guards — the length floors exist so stripping can't destroy short words.
  check('does NOT over-stem "fed" into "feed"', hits('I fed the position more size').length === 0)
  check('does NOT over-stem "used"', hits('used a wider stop').length === 0)
  check('unrelated prose still matches nothing', hits('nothing relevant here at all').length === 0)
}

console.log('mergeTradeTags')

check('categories union and dedupe',
  (mergeTradeTags({ mistakes: ['FOMO'] }, { mistakes: ['FOMO', 'Chased'] }).mistakes ?? []).length === 2)

console.log(failures === 0 ? '\nAll suggest-tags tests passed.' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
