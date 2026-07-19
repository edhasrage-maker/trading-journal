/**
 * AI output eval harness — the runnable half of the trust layer (Pt 21 ticket 7).
 * See docs/ai-output-constraints-eval-plan.md and src/lib/ai-constraints.ts.
 *
 *   npm run eval                 # offline: drift guard + Tier-A on recorded goldens
 *   npx tsx scripts/eval-ai-output.ts
 *   npx tsx scripts/eval-ai-output.ts --live   # also call the model per fixture (phase 4)
 *
 * OFFLINE (default, CI-safe, zero API calls):
 *   1. Prompt-drift guard — assert every behavioral constraint still appears in
 *      the REAL built owner + generic prompts.
 *   2. Per fixture in evals/cases/*.json: run the pipeline the app runs — raw
 *      text → checkRawOutput (A1) → parseEodResponse → checkStructural — plus A7
 *      (deterministic-override agreement) when the fixture supplies trades. Then
 *      compare the SET of violation ids to the fixture's expectViolations.
 *
 * Exits non-zero on any mismatch so it can gate a pre-push hook / CI.
 *
 * --live is a stub here; phase 4 adds the Haiku judge for the Tier-B rules.
 */
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  checkRawOutput, checkStructural, checkPromptDrift, PROMPT_ANCHORS, type Violation,
} from '../src/lib/ai-constraints.ts'
import { buildEodPrompt, parseEodResponse, applyDeterministicOverrides } from '../src/lib/eod-prompt.ts'
import type { EodAiAnalysis, RuleId } from '../src/lib/supabase/types.ts'

const LIVE = process.argv.includes('--live')
const CASES_DIR = join('evals', 'cases')

interface Fixture {
  name: string
  tier: 'A' | 'B'
  /** Raw model output text (as the model would emit it — may include fences). */
  golden: string
  /** Optional trade inputs; presence enables the A7 override-agreement check. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input?: { trades?: any[] }
  /** The SET of Tier-A violation ids this golden should produce ([] = clean). */
  expectViolations: string[]
}

/** A7 — the golden's claimed safety rails must equal what the deterministic
 *  engine computes for the same trades. A disagreement means the model's process
 *  verdict would have been silently overridden — a trust break we want to catch. */
function checkOverrideAgreement(parsed: EodAiAnalysis, trades: unknown[]): Violation[] {
  if (!parsed.process || !Array.isArray(trades) || trades.length === 0) return []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const overridden = applyDeterministicOverrides({ ...parsed } as EodAiAnalysis, trades as any)
  const out: Violation[] = []
  for (const k of ['P1', 'P2', 'P3', 'P4', 'P5'] as RuleId[]) {
    const ai = parsed.process.per_rule?.[k]
    const det = overridden.process?.per_rule?.[k]
    if (!ai || !det) continue
    if (ai.status !== det.status || (ai.breach_count ?? 0) !== (det.breach_count ?? 0)) {
      out.push({ id: 'A7', tier: 'A', message: `${k} disagrees with the deterministic engine`, evidence: `golden ${ai.status}/${ai.breach_count} vs computed ${det.status}/${det.breach_count}` })
    }
  }
  return out
}

function uniqueIds(vs: Violation[]): string[] {
  return [...new Set(vs.map(v => v.id))].sort()
}
const setsEqual = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

let failures = 0
const fail = (msg: string) => { failures++; console.error(`  ✗ ${msg}`) }
const pass = (msg: string) => console.log(`  ✓ ${msg}`)

// ── 1. Prompt-drift guard ────────────────────────────────────────────────────
console.log('prompt-drift guard')
const ownerPrompt = buildEodPrompt({ trades: [], scoringProfile: {}, isLocalOwner: true })
const genericPrompt = buildEodPrompt({ trades: [], scoringProfile: { setups: ['A'] } as never, isLocalOwner: false })
const ownerMiss = checkPromptDrift(ownerPrompt, PROMPT_ANCHORS.filter(a => a.variant !== 'generic'))
const genericMiss = checkPromptDrift(genericPrompt, PROMPT_ANCHORS.filter(a => a.variant === 'both'))
if (ownerMiss.length) fail(`owner prompt missing: ${ownerMiss.map(v => v.id).join(', ')}`); else pass('owner prompt has all constraints')
if (genericMiss.length) fail(`generic prompt missing: ${genericMiss.map(v => v.id).join(', ')}`); else pass('generic prompt has all shared constraints')

// ── 2. Fixtures ──────────────────────────────────────────────────────────────
let files: string[] = []
try { files = readdirSync(CASES_DIR).filter(f => f.endsWith('.json')).sort() }
catch { console.error(`  (no fixtures dir at ${CASES_DIR})`) }

console.log(`\nfixtures (${files.length})`)
for (const f of files) {
  const fx = JSON.parse(readFileSync(join(CASES_DIR, f), 'utf8')) as Fixture
  const raw = fx.golden
  const violations = [
    ...checkRawOutput(raw),
    ...checkStructural(parseEodResponse(raw)),
    ...checkOverrideAgreement(parseEodResponse(raw), fx.input?.trades ?? []),
  ]
  const got = uniqueIds(violations)
  const want = [...fx.expectViolations].sort()
  if (setsEqual(got, want)) {
    pass(`${fx.name} — violations [${got.join(', ') || 'none'}]`)
  } else {
    fail(`${fx.name} — expected [${want.join(', ') || 'none'}], got [${got.join(', ') || 'none'}]`)
    for (const v of violations) console.error(`      ${v.id}: ${v.message}${v.evidence ? ` — ${v.evidence}` : ''}`)
  }
}

if (LIVE) {
  console.log('\n--live: Tier-B model judge not implemented until phase 4 (skipped).')
}

console.log(failures === 0 ? '\nEval passed.' : `\n${failures} eval failure(s).`)
process.exit(failures === 0 ? 0 : 1)
