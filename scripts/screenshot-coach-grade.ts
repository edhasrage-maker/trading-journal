/**
 * Screenshot-coach GRADER — step 3 (the prompt) + the first half of step 4
 * (over-claim check, which needs no labels).
 *
 *   npx tsx scripts/screenshot-coach-grade.ts --limit=3          # smoke test
 *   npx tsx scripts/screenshot-coach-grade.ts --limit=40
 *   npx tsx scripts/screenshot-coach-grade.ts --in=<jsonl> --model=claude-sonnet-5
 *   npx tsx scripts/screenshot-coach-grade.ts --dry               # print the prompt, no calls
 *
 * One model call per trade. In: the screenshot, the trader's CLAIM (tags +
 * notes), and the TRUTH the harness computed from bars. Out: a frame-gate
 * read plus four axes, each `agree | diverge | n_a` with ONE factual sentence.
 *
 * The contract the prompt enforces, in priority order:
 *   1. The screenshot is the trader's perception. The bars are what happened.
 *      The image is never asked for a price, level, or time.
 *   2. Every number in the output must exist in `truth`. This is CHECKED, not
 *      trusted — `overclaims()` extracts every number from every sentence and
 *      looks it up in a flattened set of the truth values. A number that isn't
 *      there is a fabrication and the record is flagged.
 *   3. If the frame gate fails, every axis is n_a. Also checked.
 *   4. `n_a` is a correct answer when the data isn't there (no matching
 *      context row → entry axis n_a; null 5m alignment → structure axis n_a).
 *   5. No causal stories, no inferred emotions, no invented lessons. One
 *      optional line prefixed "TapeScore suggested:", or null.
 *
 * Bands are PRE-COMPUTED here from the rubric thresholds and handed to the
 * model as part of truth, so it quotes a band rather than re-deriving one.
 * The thresholds live in one place (BANDS below) and mirror
 * docs/screenshot-coach-rubric.md.
 *
 * Reads `evals/screenshot-coach/unlabelled-trades.jsonl` (or labelled-) and
 * writes `grades.jsonl` + `grade-report.txt` next to it. Never writes to prod.
 */
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import Anthropic from '@anthropic-ai/sdk'

const argv = process.argv.slice(2)
const has = (n: string) => argv.includes(`--${n}`)
const argVal = (n: string): string | null => argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? null

const IN_PATH = argVal('in') ?? join(process.cwd(), 'evals', 'screenshot-coach', 'unlabelled-trades.jsonl')
const LIMIT = Number(argVal('limit') ?? '3') || 3
const MODEL = argVal('model') ?? 'claude-sonnet-5'
const DRY = has('dry')

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
const anthropic = new Anthropic()

// ── rubric bands (single source; mirrors docs/screenshot-coach-rubric.md) ──
const BANDS = {
  location_adr: { at: 0.05, near: 0.15 },      // ≤at → "at level", ≤near → "near", else "in space"
  chase_atr: { early: 1.0, extended: 3.0 },     // ≤early → "early", ≤extended → "mid", else "extended"
  mfe_noise_atr: 0.5,                           // below this the exit axis has nothing to judge
}
type LocBand = 'at_level' | 'near' | 'in_space' | null
type ChaseBand = 'early' | 'mid' | 'extended' | null
const locBand = (adr: number | null): LocBand =>
  adr == null ? null : adr <= BANDS.location_adr.at ? 'at_level' : adr <= BANDS.location_adr.near ? 'near' : 'in_space'
const chaseBand = (atr: number | null): ChaseBand =>
  atr == null ? null : atr <= BANDS.chase_atr.early ? 'early' : atr <= BANDS.chase_atr.extended ? 'mid' : 'extended'

// ── prompt ─────────────────────────────────────────────────────────────────
const SYSTEM = `You are TapeScore's tape reader. A futures trader gives you one of their own trades: a screenshot they captured, the setup tags and note they attached (their CLAIM), and a TRUTH block computed from 1-minute bars after the fact.

Your job is a "tape vs your read": for each of four axes, say whether the tape AGREES with what the trader claimed, DIVERGES from it, or whether the question can't be answered from what you were given (N_A).

Rules, in priority order:

1. The screenshot is the trader's perception — what was on their screen. The bars are what happened. Never read a price, a level, or a time off the image; every number you state must be copied from the TRUTH block. If you find yourself wanting a number that isn't there, the answer is N_A, not an estimate.

2. First judge the FRAME. If the image shows the trade already finished (an entry AND a separate exit marker, or a flat/closed tag), or you cannot find the entry marker, or the image is not a chart of this trade — return frame.usable=false and set EVERY axis to n_a. A P&L number on the position line is NOT evidence of completion: this platform paints open, unrealised P&L on a live position.

3. Each axis compares one CLAIM element to one TRUTH element:
   - entry_location: did they claim a level trade (a tag or note naming a level, zone, IB, PDH/PDL, VWAP, or "at/off/from" a price area) and where did the tape put the entry? Use truth.location.band and truth.location.nearest. If truth.location.context_matched is false, n_a.
   - direction_vs_structure: did they claim to follow or fade the structure (tags like "Follow LTF structure" / "Fade LTF structure", or "reversal" / "continuation" language), and what does truth.structure.alignment_5m say? Null alignment → n_a. No claim either way → agree only if the tape shows following; otherwise n_a.
   - chase_timing: did they claim a fresh/early entry (a first-touch, break-of-candle, "clean" entry) or a reversal at an extreme, and how far had the leg already run — truth.chase.band and truth.chase.run_before_entry_atr. No claim about timing → n_a.
   - exit_vs_plan: did the exit follow the plan they stated (a management tag, a note about TP1/TP2/trail/scratch, or a logged stop/tp1)? Use truth.exit — capture_pct, r_multiple, whether the exit sat at the stop or TP1, and the 15-minute post-exit excursion. If truth.exit.mfe_atr is below ${BANDS.mfe_noise_atr} the trade never moved and this axis is n_a. If no plan was stated and no stop or TP1 is logged, n_a.

4. AGREE means the tape supports the claim. DIVERGE means the tape contradicts it. Both need a claim to compare against — a trade with no relevant claim is n_a on that axis, not agree.

5. One sentence per axis, factual, with the numbers that decide it, quoted exactly as they appear in TRUTH (same rounding). Name the unit (ATR, ADR, pts, %). No causal stories — never say why the trader did something, never infer an emotion or a state of mind, never say what they "should have" felt. State what the tape did.

6. Optionally, one line starting with exactly "TapeScore suggested:" naming ONE concrete, checkable thing — a threshold, a wait, a level to have used. Only if it follows directly from a DIVERGE. Otherwise null. Never a lesson, never a platitude.

You will be shown the trader's tags and note. You will not be shown their own hindsight verdict on the trade, and you must not guess at it.`

const SCHEMA = {
  type: 'object',
  properties: {
    frame: {
      type: 'object',
      properties: {
        usable: { type: 'boolean' },
        reason: { type: 'string', enum: ['ok', 'shows_completed_trade', 'no_entry_marker', 'not_this_trade', 'unreadable'] },
        entry_marker_confidence: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
        chart_right_of_entry: { type: 'string', enum: ['none', 'some', 'most', 'unknown'] },
      },
      required: ['usable', 'reason', 'entry_marker_confidence', 'chart_right_of_entry'],
      additionalProperties: false,
    },
    axes: {
      type: 'object',
      properties: {
        entry_location: axisSchema(),
        direction_vs_structure: axisSchema(),
        chase_timing: axisSchema(),
        exit_vs_plan: axisSchema(),
      },
      required: ['entry_location', 'direction_vs_structure', 'chase_timing', 'exit_vs_plan'],
      additionalProperties: false,
    },
    suggested: { type: ['string', 'null'] },
  },
  required: ['frame', 'axes', 'suggested'],
  additionalProperties: false,
} as const

function axisSchema() {
  return {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['agree', 'diverge', 'n_a'] },
      claim: { type: ['string', 'null'], description: 'The trader claim element this axis compared, quoted or paraphrased from tags/note. Null if none.' },
      sentence: { type: 'string', description: 'One factual sentence with the deciding numbers, copied from TRUTH.' },
    },
    required: ['verdict', 'claim', 'sentence'],
    additionalProperties: false,
  } as const
}

interface Axis { verdict: 'agree' | 'diverge' | 'n_a'; claim: string | null; sentence: string }
interface Grade {
  frame: { usable: boolean; reason: string; entry_marker_confidence: string; chart_right_of_entry: string }
  axes: { entry_location: Axis; direction_vs_structure: Axis; chase_timing: Axis; exit_vs_plan: Axis }
  suggested: string | null
}

// ── truth packaging ────────────────────────────────────────────────────────
// The model gets the derived fields plus bands. The raw bar strip is withheld:
// it is 60×6 numbers the model could quote as if they were findings, and every
// number it legitimately needs is already derived. Shape lives in the image.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function packageTruth(r: any) {
  const t = r.truth
  return {
    direction: r.direction,
    symbol: r.symbol,
    entry_price: t.entry_price, exit_price: t.exit_price,
    stop_price: t.stop_price, tp1_price: t.tp1_price,
    atr_1m: t.atr_1m, adr: t.adr,
    location: {
      context_matched: t.location.context_matched,
      nearest: t.location.nearest,
      band: locBand(t.location.nearest?.dist_adr ?? null),
      vwap_side: t.location.vwap?.side ?? null,
      touches_before_entry: t.location.touches_before_entry,
    },
    structure: { alignment_5m: t.structure.alignment_5m },
    chase: {
      run_before_entry_pts: t.chase.run_before_entry_pts,
      run_before_entry_atr: t.chase.run_before_entry_atr,
      band: chaseBand(t.chase.run_before_entry_atr),
    },
    exit: {
      realized_pts: t.exit.realized_pts, r_multiple: t.exit.r_multiple, risk_pts: t.exit.risk_pts,
      mfe_pts: t.exit.mfe_pts, mfe_atr: t.exit.mfe_atr, mae_atr: t.exit.mae_atr,
      capture_pct: t.exit.capture_pct,
      post_exit_favorable_atr: t.exit.post_exit_favorable_atr,
      post_exit_against_atr: t.exit.post_exit_against_atr,
      scaled_out: t.exit.scaled_out, legs: t.exit.legs,
    },
  }
}

// ── the over-claim check ───────────────────────────────────────────────────
// Every number the model writes must be findable in the truth it was handed.
// Tolerant to trailing-zero and sign formatting; NOT tolerant to a value that
// isn't there. Small integers (0–3) are ignored — "TP1", "5m", "15-minute",
// "one" all legitimately produce them.
function numbersIn(text: string): number[] {
  return Array.from(text.matchAll(/-?\d+(?:\.\d+)?/g)).map(m => Number(m[0])).filter(Number.isFinite)
}
function flattenNumbers(v: unknown, out: Set<number> = new Set()): Set<number> {
  if (typeof v === 'number' && Number.isFinite(v)) { out.add(v); out.add(Math.abs(v)) }
  else if (Array.isArray(v)) v.forEach(x => flattenNumbers(x, out))
  else if (v && typeof v === 'object') Object.values(v).forEach(x => flattenNumbers(x, out))
  return out
}
// Numbers the model may legitimately state that are NOT trade truth: the
// rubric's own thresholds (it is allowed to say "below the 0.5 ATR floor"),
// and the timeframe tokens it was told about (5m structure, 15-minute window).
// Anything the SYSTEM prompt itself contains is fair game; a first smoke test
// flagged "5m" and "0.5 ATR" as fabrications, which was the checker's error.
const RUBRIC_NUMBERS = new Set<number>([
  ...flattenNumbers(BANDS),
  ...numbersIn(SYSTEM).map(Math.abs),
  5, 15, 100,
])
function overclaims(g: Grade, truthPkg: unknown): string[] {
  const allowed = flattenNumbers(truthPkg)
  const bad: string[] = []
  const check = (label: string, text: string | null) => {
    if (!text) return
    for (const n of numbersIn(text)) {
      const a = Math.abs(n)
      if (Number.isInteger(a) && a <= 3) continue                    // TP1, TP2, "one", "two"
      if (RUBRIC_NUMBERS.has(a)) continue
      const hit = Array.from(allowed).some(x => Math.abs(x - a) < 0.011)
      if (!hit) bad.push(`${label}: ${n}`)
    }
  }
  for (const [k, a] of Object.entries(g.axes)) check(k, a.sentence)
  check('suggested', g.suggested)
  return bad
}

// ── model call ─────────────────────────────────────────────────────────────
type MediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
function mediaTypeOf(path: string): MediaType {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  return ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function userText(r: any, truthPkg: unknown): string {
  return [
    `TRADE: ${r.direction} ${r.symbol}, entered ${r.entry_pt}, exited ${r.exit_pt ?? 'unknown'}.`,
    ``,
    `CLAIM (the trader's tags and note — what they said this trade was):`,
    JSON.stringify(r.claim, null, 1),
    ``,
    `TRUTH (computed from 1-minute bars; the only source of numbers you may state):`,
    JSON.stringify(truthPkg, null, 1),
  ].join('\n')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function grade(r: any): Promise<{ grade: Grade | null; error: string | null }> {
  const res = await fetch(r.frame.signed_url)
  if (!res.ok) return { grade: null, error: `image fetch ${res.status}` }
  const b64 = Buffer.from(await res.arrayBuffer()).toString('base64')
  const truthPkg = packageTruth(r)

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM,
    // Comparison of a small claim block against a small truth block — a
    // reasoning task, but a bounded one. Medium keeps the run cheap while
    // avoiding the descriptive-field jitter the gate showed at low.
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaTypeOf(r.frame.storage_path ?? ''), data: b64 } },
        { type: 'text', text: userText(r, truthPkg) },
      ],
    }],
  })
  if (msg.stop_reason === 'refusal') return { grade: null, error: 'refusal' }
  const text = msg.content.find(b => b.type === 'text')
  if (!text || text.type !== 'text') return { grade: null, error: `no text (stop=${msg.stop_reason})` }
  try { return { grade: JSON.parse(text.text) as Grade, error: null } }
  catch { return { grade: null, error: 'unparseable json' } }
}

async function main() {
  const rows = readFileSync(IN_PATH, 'utf8').trim().split('\n')
    .map(l => JSON.parse(l) as Record<string, any>)   // eslint-disable-line @typescript-eslint/no-explicit-any
    .filter(r => r.frame?.signed_url)

  if (DRY) {
    console.log('── SYSTEM ──\n' + SYSTEM + '\n\n── USER (first record) ──\n' + userText(rows[0], packageTruth(rows[0])))
    return
  }

  // Prefer labelled records when any exist — that's what step 4 scores.
  const labelled = rows.filter(r => r.label?.call)
  const pool = labelled.length ? labelled : rows
  const batch = pool.slice(0, LIMIT)
  console.log(`model=${MODEL}  grading ${batch.length} of ${pool.length} ${labelled.length ? 'LABELLED' : 'unlabelled'} records\n`)

  const out: Record<string, unknown>[] = []
  for (const [i, r] of batch.entries()) {
    const { grade: g, error } = await grade(r)
    const truthPkg = packageTruth(r)
    const oc = g ? overclaims(g, truthPkg) : []
    const gateViolation = g ? (!g.frame.usable && Object.values(g.axes).some(a => a.verdict !== 'n_a')) : false
    out.push({
      trade_id: r.trade_id, date: r.date, entry_pt: r.entry_pt, symbol: r.symbol, direction: r.direction,
      label: r.label?.call ?? null,
      pnl: r.truth.exit.pnl,
      grade: g, error,
      overclaims: oc, gate_violation: gateViolation,
    })
    const v = g ? Object.entries(g.axes).map(([k, a]) => `${k.split('_')[0]}=${a.verdict}`).join(' ') : ''
    console.log(`[${String(i + 1).padStart(2)}/${batch.length}] ${r.date} ${String(r.direction).padEnd(5)} ${String(r.symbol).padEnd(10)} ` +
      (error ? `ERROR ${error}` : `frame=${g!.frame.usable ? 'ok' : g!.frame.reason} ${v}` +
        (oc.length ? `  << OVERCLAIM ${oc.join('; ')}` : '') + (gateViolation ? '  << GATE VIOLATION' : '')))
    if (g && !error) {
      for (const [k, a] of Object.entries(g.axes)) if (a.verdict !== 'n_a') console.log(`        ${k}: ${a.sentence}`)
      if (g.suggested) console.log(`        ${g.suggested}`)
    }
  }

  // ── report ─────────────────────────────────────────────────────────────
  const ok = out.filter(o => o.grade)
  const axisNames = ['entry_location', 'direction_vs_structure', 'chase_timing', 'exit_vs_plan'] as const
  const tally = (ax: typeof axisNames[number]) => {
    const c = { agree: 0, diverge: 0, n_a: 0 }
    for (const o of ok) c[(o.grade as Grade).axes[ax].verdict]++
    return `  ${ax.padEnd(24)} agree ${String(c.agree).padStart(3)}  diverge ${String(c.diverge).padStart(3)}  n_a ${String(c.n_a).padStart(3)}`
  }
  const overclaimed = out.filter(o => (o.overclaims as string[]).length > 0)
  const gateBad = out.filter(o => o.gate_violation)
  const anyDiverge = ok.filter(o => Object.values((o.grade as Grade).axes).some(a => a.verdict === 'diverge'))
  const gated = ok.filter(o => !(o.grade as Grade).frame.usable)

  const lines = [
    `GRADER — ${MODEL} — ${ok.length} graded, ${out.length - ok.length} errors`,
    ``,
    `HONESTY CHECKS (deterministic, no labels needed)`,
    `  over-claims (number not in truth)   ${overclaimed.length} / ${ok.length}   ${overclaimed.length ? '<< FAIL' : 'OK'}`,
    ...overclaimed.map(o => `     ${o.date} ${(o.overclaims as string[]).join('; ')}`),
    `  gate violations (axis on gated img) ${gateBad.length} / ${ok.length}   ${gateBad.length ? '<< FAIL' : 'OK'}`,
    `  frames gated                        ${gated.length} / ${ok.length}`,
    ``,
    `VERDICT MIX`,
    ...axisNames.map(tally),
    `  any axis diverges                   ${anyDiverge.length} / ${ok.length}`,
  ]

  // Step 4 proper — only when labels exist.
  const withLabel = ok.filter(o => o.label)
  if (withLabel.length) {
    const mistakes = withLabel.filter(o => o.label === 'mistake')
    const goods = withLabel.filter(o => o.label === 'good')
    const divergeOn = (arr: typeof ok) => arr.filter(o => Object.values((o.grade as Grade).axes).some(a => a.verdict === 'diverge')).length
    const pnlSignPredicts = withLabel.filter(o => (o.label === 'mistake') === ((o.pnl as number) < 0)).length
    const coachPredicts = withLabel.filter(o => (o.label === 'mistake') === Object.values((o.grade as Grade).axes).some(a => a.verdict === 'diverge')).length
    lines.push(
      ``,
      `AGAINST YOUR VERDICTS  (n=${withLabel.length}: mistake ${mistakes.length}, good ${goods.length}, unsure ${withLabel.length - mistakes.length - goods.length})`,
      `  coach diverges on labelled mistakes  ${divergeOn(mistakes)} / ${mistakes.length}   (recall)`,
      `  coach diverges on labelled good      ${divergeOn(goods)} / ${goods.length}   << the valuable cell if right, the cost if wrong`,
      `  coach agrees w/ mistake-vs-not       ${coachPredicts} / ${withLabel.length}`,
      `  P&L-sign-only baseline               ${pnlSignPredicts} / ${withLabel.length}   << coach must beat this or it learned nothing`,
      `  blind spots (mistake, all agree/n_a) ${mistakes.length - divergeOn(mistakes)}`,
      withLabel.length < 40 ? `  >> UNDER 40 labels — directional only.` : ``,
    )
  } else {
    lines.push(``, `NO LABELS in this file — step 4 agreement/baseline not computed.`)
  }

  const report = lines.join('\n')
  writeFileSync(join(dirname(IN_PATH), 'grades.jsonl'), out.map(o => JSON.stringify(o)).join('\n') + '\n', 'utf8')
  writeFileSync(join(dirname(IN_PATH), 'grade-report.txt'), report + '\n', 'utf8')
  console.log('\n' + report)
}

main().catch(e => { console.error(e); process.exit(1) })
