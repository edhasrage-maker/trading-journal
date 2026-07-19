/**
 * Unit tests for the AI trust-layer structural checks (src/lib/ai-constraints).
 *
 *   npx tsx scripts/test-ai-constraints.ts
 *
 * No test framework — plain tsx asserts, exits non-zero on the first failure (so
 * a regression fails loudly), same style as scripts/test-derived-metrics.ts.
 * Covers the Tier-A structural checks + the prompt-drift guard against the REAL
 * built prompts, so a constraint deleted from eod-prompt.ts fails here.
 */
import {
  checkRawOutput, checkStructural, checkPromptDrift,
  CALC_TRACE_PATTERNS, PROMPT_ANCHORS, BEHAVIORAL_RULES,
} from '../src/lib/ai-constraints.ts'
import { buildEodPrompt } from '../src/lib/eod-prompt.ts'
import type { EodAiAnalysis } from '../src/lib/supabase/types.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const hasId = (vs: { id: string }[], id: string) => vs.some(v => v.id === id)

console.log('checkRawOutput (A1)')
check('clean bare JSON passes', checkRawOutput('{"a":1}').length === 0)
check('code fence flagged', hasId(checkRawOutput('```json\n{"a":1}\n```'), 'A1'))
check('prose wrapper flagged', hasId(checkRawOutput('Here is the analysis: {"a":1}'), 'A1'))

console.log('checkStructural (A3 verdict)')
check('valid verdict passes', !hasId(checkStructural({ process: { verdict: 'Breach' } } as EodAiAnalysis), 'A3'))
check('bad verdict flagged', hasId(checkStructural({ process: { verdict: 'Mostly Fine' } } as unknown as EodAiAnalysis), 'A3'))

console.log('checkStructural (A4 ranges)')
check('score 8 ok', !hasId(checkStructural({ score: 8 } as EodAiAnalysis), 'A4'))
check('score 11 flagged', hasId(checkStructural({ score: 11 } as EodAiAnalysis), 'A4'))
check('axis 1.4 flagged', hasId(checkStructural({ execution: { mfe_capture: 1.4 } } as unknown as EodAiAnalysis), 'A4'))
check('axis null ok', !hasId(checkStructural({ execution: { mfe_capture: null } } as unknown as EodAiAnalysis), 'A4'))
check('negative PF flagged', hasId(checkStructural({ execution: { profit_factor: -1 } } as unknown as EodAiAnalysis), 'A4'))

console.log('checkStructural (A5 headline)')
check('clean headline ok', !hasId(checkStructural({ headline: 'Clean process, weak exits dragged the day' } as EodAiAnalysis), 'A5'))
check('P&L number flagged', hasId(checkStructural({ headline: 'Solid +$479 day, held targets well' } as EodAiAnalysis), 'A5'))
check('word "Compliance" flagged', hasId(checkStructural({ headline: 'Compliance intact but execution slipped today' } as EodAiAnalysis), 'A5'))
check('16-word top headline flagged', hasId(checkStructural({ headline: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen' } as EodAiAnalysis), 'A5'))
check('"10 MNQ" does NOT trip P&L', !hasId(checkStructural({ headline: 'Sized to 10 MNQ on a clean read and held' } as EodAiAnalysis), 'A5'))

console.log('checkStructural (A6 notes calc-trace)')
check('narrative notes ok', !hasId(checkStructural({ execution: { notes: 'Exits left money on the table; entries were clean.' } } as unknown as EodAiAnalysis), 'A6'))
check('per-trade arithmetic flagged', hasId(checkStructural({ execution: { notes: 'T1 MAE = 19.25 vs the 19 band.' } } as unknown as EodAiAnalysis), 'A6'))
check('composite formula flagged', hasId(checkStructural({ execution: { notes: 'Composite 0.35*0.41+0.20 gives the drop.' } } as unknown as EodAiAnalysis), 'A6'))

console.log('checkStructural (A8 bullet caps)')
check('5 mistakes ok', !hasId(checkStructural({ mistakes: ['a', 'b', 'c', 'd', 'e'] } as EodAiAnalysis), 'A8'))
check('6 mistakes flagged', hasId(checkStructural({ mistakes: ['a', 'b', 'c', 'd', 'e', 'f'] } as EodAiAnalysis), 'A8'))
check('4 next_session_focus flagged', hasId(checkStructural({ next_session_focus: ['a', 'b', 'c', 'd'] } as EodAiAnalysis), 'A8'))

console.log('CALC_TRACE_PATTERNS sanity')
check('at least 4 patterns', CALC_TRACE_PATTERNS.length >= 4)

console.log('prompt-drift guard against the REAL built prompts')
// Owner v1.3 path: local owner + empty profile. Generic path: public + a profile.
const ownerPrompt = buildEodPrompt({ trades: [], scoringProfile: {}, isLocalOwner: true })
const genericPrompt = buildEodPrompt({ trades: [], scoringProfile: { setups: ['A'] } as never, isLocalOwner: false })
const ownerAnchors = PROMPT_ANCHORS.filter(a => a.variant === 'owner' || a.variant === 'both')
const genericAnchors = PROMPT_ANCHORS.filter(a => a.variant === 'both')
const ownerMiss = checkPromptDrift(ownerPrompt, ownerAnchors)
const genericMiss = checkPromptDrift(genericPrompt, genericAnchors)
check('all owner-variant anchors present in owner prompt', ownerMiss.length === 0, ownerMiss.map(v => v.evidence).join('; '))
check('all both-variant anchors present in generic prompt', genericMiss.length === 0, genericMiss.map(v => v.evidence).join('; '))
check('every behavioral rule has a prompt anchor', BEHAVIORAL_RULES.every(r => PROMPT_ANCHORS.some(a => a.id === r.id)))

console.log(failures === 0 ? '\nAll AI-constraint tests passed.' : `\n${failures} failure(s).`)
process.exit(failures === 0 ? 0 : 1)
