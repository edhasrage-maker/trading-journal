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
 * --live (needs ANTHROPIC_API_KEY) also runs the Tier-B behavioral rules via a
 * cheap Haiku judge over every tier-B fixture, comparing the fired rule ids to
 * the fixture's expectFlag. Tier-B fixtures are SKIPPED (not failed) offline.
 */
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import Anthropic from '@anthropic-ai/sdk'
import {
  checkRawOutput, checkStructural, checkPromptDrift, PROMPT_ANCHORS,
  BEHAVIORAL_RULES, type Violation,
} from '../src/lib/ai-constraints.ts'
import { buildEodPrompt, parseEodResponse, applyDeterministicOverrides } from '../src/lib/eod-prompt.ts'
import type { EodAiAnalysis, RuleId } from '../src/lib/supabase/types.ts'

const LIVE = process.argv.includes('--live')
const CASES_DIR = join('evals', 'cases')
// Cheap, fast judge for the behavioral rules — deliberately NOT the grader tier.
const JUDGE_MODEL = 'claude-haiku-4-5-20251001'

interface Fixture {
  name: string
  tier: 'A' | 'B'
  /** Raw model output text (as the model would emit it — may include fences). */
  golden: string
  /** Optional trade inputs; presence enables the A7 override-agreement check. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input?: { trades?: any[] }
  /** The SET of Tier-A violation ids this golden should produce ([] = clean). */
  expectViolations?: string[]
  /** Tier B only: human-readable trade/notes context the judge sees. */
  context?: string
  /** Tier B only: the SET of behavioral rule ids that SHOULD fire ([] = clean). */
  expectFlag?: string[]
}

// Load ANTHROPIC_API_KEY from .env.local for --live (the script runs outside
// Next, so env isn't auto-loaded). Mirrors the backfill scripts.
if (LIVE) {
  try {
    for (const l of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
      const m = l.match(/^([A-Z_]+)=(.*)$/)
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* no .env.local — rely on ambient env */ }
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

// ── Tier-B judge (--live) ────────────────────────────────────────────────────
let anthropic: Anthropic | null = null
function judgeClient(): Anthropic {
  if (!anthropic) anthropic = new Anthropic()
  return anthropic
}

/** Ask the Haiku judge whether one behavioral rule was violated by `output`
 *  given `context`. Returns true if violated. Fails CLOSED on a judge error
 *  (returns false — a judge outage shouldn't fabricate a violation). */
async function judge(ruleId: string, judgePrompt: string, context: string, output: string): Promise<{ violated: boolean; evidence: string }> {
  const msg = await judgeClient().messages.create({
    model: JUDGE_MODEL,
    max_tokens: 200,
    system: 'You are a strict, literal auditor of a trading coach\'s written analysis. You check ONE rule at a time and never invent violations. Output ONLY the requested JSON.',
    messages: [{
      role: 'user',
      content: `TRADE CONTEXT:\n${context}\n\nCOACH ANALYSIS (the output under audit):\n${output}\n\nRULE TO CHECK (${ruleId}):\n${judgePrompt}`,
    }],
  })
  const text = msg.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim()
  try {
    const m = text.match(/\{[\s\S]*\}/)
    const parsed = m ? JSON.parse(m[0]) as { violated?: boolean; evidence?: string } : {}
    return { violated: parsed.violated === true, evidence: parsed.evidence ?? '' }
  } catch {
    return { violated: false, evidence: '' }
  }
}

let failures = 0
const fail = (msg: string) => { failures++; console.error(`  ✗ ${msg}`) }
const pass = (msg: string) => console.log(`  ✓ ${msg}`)

async function main() {
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

const fixtures = files.map(f => ({ f, fx: JSON.parse(readFileSync(join(CASES_DIR, f), 'utf8')) as Fixture }))

// Tier A — structural, offline.
const tierA = fixtures.filter(({ fx }) => fx.tier === 'A')
console.log(`\nTier A — structural (${tierA.length})`)
for (const { fx } of tierA) {
  const raw = fx.golden
  const violations = [
    ...checkRawOutput(raw),
    ...checkStructural(parseEodResponse(raw)),
    ...checkOverrideAgreement(parseEodResponse(raw), fx.input?.trades ?? []),
  ]
  const got = uniqueIds(violations)
  const want = [...(fx.expectViolations ?? [])].sort()
  if (setsEqual(got, want)) {
    pass(`${fx.name} — violations [${got.join(', ') || 'none'}]`)
  } else {
    fail(`${fx.name} — expected [${want.join(', ') || 'none'}], got [${got.join(', ') || 'none'}]`)
    for (const v of violations) console.error(`      ${v.id}: ${v.message}${v.evidence ? ` — ${v.evidence}` : ''}`)
  }
}

// Tier B — behavioral, needs the --live judge.
const tierB = fixtures.filter(({ fx }) => fx.tier === 'B')
console.log(`\nTier B — behavioral (${tierB.length})`)
if (!LIVE) {
  console.log(`  (skipped ${tierB.length} — run with --live + ANTHROPIC_API_KEY to judge)`)
} else if (!process.env.ANTHROPIC_API_KEY) {
  fail('--live requested but ANTHROPIC_API_KEY is not set')
} else {
  for (const { fx } of tierB) {
    const context = fx.context ?? '(no context provided)'
    const want = [...(fx.expectFlag ?? [])].sort()
    const fired: string[] = []
    const evidence: Record<string, string> = {}
    // Run every behavioral rule so we test precision (clean → none fire) AND
    // recall (bad → the target fires). Sequential to stay gentle on rate limits.
    for (const rule of BEHAVIORAL_RULES) {
      const r = await judge(rule.id, rule.judgePrompt, context, fx.golden)
      if (r.violated) { fired.push(rule.id); evidence[rule.id] = r.evidence }
    }
    fired.sort()
    if (setsEqual(fired, want)) {
      pass(`${fx.name} — flagged [${fired.join(', ') || 'none'}]`)
    } else {
      fail(`${fx.name} — expected [${want.join(', ') || 'none'}], judge flagged [${fired.join(', ') || 'none'}]`)
      for (const id of fired) console.error(`      ${id}: ${evidence[id]}`)
    }
  }
}

console.log(failures === 0 ? '\nEval passed.' : `\n${failures} eval failure(s).`)
process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
