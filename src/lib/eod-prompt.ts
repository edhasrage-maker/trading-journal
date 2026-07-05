/**
 * Shared EOD-prompt construction + response parsing.
 *
 * Extracted from src/app/api/analyze-eod/route.ts so that both the live
 * endpoint AND the batch-rescore script (scripts/rescore-eod-stale.ts) can
 * use the same prompt + parser. Without this lib, the rescore script would
 * have to duplicate ~250 lines of prompt logic, and any future prompt tweak
 * would have to be applied in two places.
 *
 * NOT a React component / hook — pure functions only, safe to import from
 * either a route handler (Node) or a standalone script.
 */

import { readFileSync } from 'fs'
import path from 'path'
// Relative path (not '@/lib/...') so the rescore-eod-stale script can import
// this lib via raw Node (--experimental-strip-types), which doesn't resolve
// TS path aliases from tsconfig. Next.js + Webpack handle both fine.
import type { PrepNotes, AiAnalysis, Trade, MarketContext, EodAiAnalysis } from './supabase/types.ts'
import { symbolToMultiplier } from './futures-symbols.ts'
import { CAPTURE_UNITS_DISCIPLINE } from './coach-methodology.ts'

// ─── Ruleset loader ──────────────────────────────────────────────────────────

let cachedRuleset: string | null = null

/**
 * Reads the v1.4-amended ruleset markdown. Cached per-process — the file is
 * only re-read if the cache is empty (i.e., once at startup). Falls back to
 * an empty string if the file is missing so consumers can still produce a
 * legacy-style analysis.
 */
export function loadRulesetMarkdown(): string {
  if (cachedRuleset !== null) return cachedRuleset
  try {
    cachedRuleset = readFileSync(
      path.join(process.cwd(), 'docs', 'Ruleset_v1.3_Process_Execution_Spec.md'),
      'utf8',
    )
  } catch (e) {
    console.warn('[eod-prompt] could not load ruleset, falling back to legacy scoring:', e)
    cachedRuleset = ''
  }
  return cachedRuleset
}

// ─── Time formatting ─────────────────────────────────────────────────────────

const PT_TIME_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

/** ISO timestamp → "HH:MM:SS" in America/Los_Angeles. Returns "--:--" on bad input. */
export function fmtTimePT(iso: string | null | undefined): string {
  if (!iso) return '--:--'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '--:--'
  const parts = PT_TIME_FMT.formatToParts(new Date(ms))
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
  return `${get('hour')}:${get('minute')}:${get('second')}`
}

// ─── Prompt building ─────────────────────────────────────────────────────────

export interface BuildEodPromptInput {
  trades: Trade[]
  eodNotes?: string
  prepNotes?: PrepNotes
  prepAnalysis?: AiAnalysis
  marketContext?: Partial<MarketContext>
  /** Whether to include chart-image instructions. The image itself is attached
   *  by the caller as a separate content part — this lib only deals with text. */
  hasImage?: boolean
}

/** Returns the full text prompt that gets sent to Claude. */
export function buildEodPrompt({
  trades, eodNotes, prepNotes, prepAnalysis, marketContext, hasImage = false,
}: BuildEodPromptInput): string {
  const ruleset = loadRulesetMarkdown()
  const useV13 = ruleset.length > 0

  const tradesBlock = trades.length === 0
    ? '  No trades taken today.'
    : trades.map((t, i) => {
        const time = fmtTimePT(t.entry_time)
        // Exit time is required for P4 (cooldown) computation. Without it the
        // AI marks "T1 close time not provided → P4 fail" even on clean
        // sessions. SC-imported trades always have exit_time; manual trades
        // might not (open positions, partial logs).
        const exitTime = fmtTimePT(t.exit_time)
        const dir = t.direction?.toUpperCase() ?? '--'
        const pnl = t.pnl != null ? `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}` : '--'
        const setups = t.tags_json?.setups?.join(', ') || '—'
        const confluences = t.tags_json?.confluences?.join(', ') || '—'
        // entry_model carries the trigger tag (e.g. "Break of Clusters/Bubbles")
        // that criterion #6 keys on. Was previously omitted from the block, so
        // the AI scored #6 off prose and missed the explicit tag.
        const entryModel = (t.tags_json as { entry_model?: string[] } | null | undefined)?.entry_model?.join(', ') || '—'
        const mistakes = t.tags_json?.mistakes?.join(', ') || '—'
        const emotions = t.tags_json?.emotions?.join(', ') || '—'
        const mgmt = t.tags_json?.trade_management?.join(', ') || '—'
        // Precomputed planned TP1 R so the AI doesn't have to do the division
        // for criterion #3 (it kept miscounting trades that clearly clear 2R).
        const risk = (t.entry_price != null && t.stop_price != null) ? Math.abs(t.entry_price - t.stop_price) : null
        const reward = (t.entry_price != null && t.tp1_price != null) ? Math.abs(t.tp1_price - t.entry_price) : null
        const plannedR = (risk && reward && risk > 0) ? `${(reward / risk).toFixed(2)}R` : '?'
        const notes = t.notes?.trim()
        const rc = t.recording_commentary
        const commentaryText = typeof rc === 'string'
          ? rc.trim()
          : (rc && typeof rc === 'object' && rc.text) ? rc.text.trim() : ''
        const notesLine = notes ? `\n       notes: ${notes}` : ''
        const commentaryLine = commentaryText ? `\n       AI frame commentary: ${commentaryText}` : ''
        const tp1 = t.tp1_price != null ? t.tp1_price : '?'
        const exit = t.exit_price != null ? t.exit_price : '?'
        // High/low during position — the tick-precise extremes Sierra logged
        // while the position was open. Required for accurate MFE capture +
        // MAE heat computation. Without them, the AI either guesses (old
        // behavior) or — under the tightened v1.4 prompt — correctly returns
        // null for those sub-metrics. Including them lets the AI score MFE/
        // MAE deterministically. Null entries get rendered as "?" so the AI
        // sees the gap explicitly.
        const hdp = t.high_during_position != null ? t.high_during_position : '?'
        const ldp = t.low_during_position != null ? t.low_during_position : '?'
        // Per-trade entry ATR (live ATR-10 at the fill) — the stop-band check
        // must use THIS, not the day/RTH session ATR. GBX/overnight trades have
        // no per-trade ATR (no bars) and the RTH regime doesn't apply to them.
        const atr = (t as { entry_atr_1m?: number | null }).entry_atr_1m
        const dtRaw = (t.tags_json as { day_type?: unknown } | null | undefined)?.day_type
        const dts = Array.isArray(dtRaw) ? dtRaw : (dtRaw ? [dtRaw] : [])
        const isGbx = dts.some(d => typeof d === 'string' && d.toUpperCase().includes('GBX'))
        return `  ${i + 1}. open ${time} → close ${exitTime} | ${dir} @ ${t.entry_price ?? '?'} stop ${t.stop_price ?? '?'} TP1 ${tp1} exit ${exit} qty ${t.quantity ?? '?'} | PnL ${pnl}
       intra-trade extremes: high=${hdp} low=${ldp}
       entry ATR-10(1m): ${atr ?? 'N/A'} | planned TP1: ${plannedR} | session: ${isGbx ? 'GBX/overnight — exempt from prep_adherence + the ATR stop-band check ONLY; STILL execution-scored on every other criterion' : 'RTH'}
       setups: ${setups} | entry_model: ${entryModel} | confluences: ${confluences}
       management: ${mgmt} | mistakes: ${mistakes} | emotions: ${emotions}${notesLine}${commentaryLine}`
      }).join('\n')

  const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const wins = trades.filter(t => (t.pnl ?? 0) > 0).length
  const losses = trades.filter(t => (t.pnl ?? 0) < 0).length

  const chartInstructions = hasImage ? `
═══════════════════════════════════════════════
STEP 1 — INDEPENDENT CHART READ (image only)
═══════════════════════════════════════════════
Look ONLY at the EOD chart image. Do NOT reference the trade list yet.
Identify:
- Did price trend, rotate, or chop overall?
- Where were the key turning points / failed auctions / breakouts?
- Volume profile shape and acceptance / rejection zones

Briefly note this read in "summary" before evaluating the executions.

═══════════════════════════════════════════════
STEP 2 — EXECUTION REVIEW (text + chart)
═══════════════════════════════════════════════
Now read the trade list and trader's notes. Compare:
- Did entries align with structural levels visible on the chart?
- Did the chosen setups fit the day type that actually played out?
- Were there obvious missed trades or chased entries?` : ''

  const v13Block = useV13 ? `
══ TRADER'S RULESET v1.3 (verbatim — this is authoritative; do not soften) ══

${ruleset}

══ HOW TO APPLY THE RULESET ══

You are scoring against the v1.3 spec above. Two orthogonal layers — never combined:

**Process layer (per-rule binary, session verdict by threshold):**
Per v1.3 amendment 3 (2026-06-08), Process is now 5 hard safety-rail rules.
The old P4 (stop validity) and P7 (setup validity) moved OUT of Process and
into Execution Parameters (an Execution sub-metric below). What was P5 and
P6 are renumbered to P4 and P5.

- For each of P1..P5, mark status as "pass" or "fail".
- All 5 rules are enforcement-critical safety rails. Required data missing
  means the session can't be verified clean → FAIL. There is no "incomplete"
  tier on any P-rule under v1.4.
- For per-trade rules (P2/P3/P4), breach_count = number of trades that
  breached. For session-level rules (P1/P5), breach_count = 1 if breached
  else 0.
- pass_count = count of rules with status="pass".
- Verdict = "Compliant" if pass_count >= 4; otherwise "Breach". One safety-
  rail lapse is tolerated; two simultaneous breaches = Breach. P&L does not
  override.

Rule reference (renumbered):
  • P1 = Daily loss limit (Session Net P&L not past −$500, with a $50 slippage buffer — closing between −$500 and −$550 is a stop-fill artifact, not a breach; only −$550 or worse is a true P1 breach)
  • P2 = Size within cap (≤5 MNQ; ≤10 only on Qualifying S&D)
  • P3 = No size-up after loss (post-loss → ≤5 MNQ, no scale to 10)
  • P4 = Cooldown ≥90s after any loss
  • P5 = Trade cap ≤7 trades/session

**Execution layer (continuous, diagnostic, per-trade aggregation):**
Per v1.4 amendment 3 (2026-06-08): Duration-to-thesis REMOVED; a 9-criterion
Execution Parameters sub-metric REPLACES it at 35%. All weights rebalanced.
Per amendment 4 (2026-06-20): MAE heat REMOVED from the composite — getting
stopped (especially when price runs past the stop) is correct execution
validating an invalidated idea, so scoring it as "heat" penalizes a good
decision. The remaining four sub-metrics renormalize to 41 / 24 / 24 / 11.

**Critical:** Execution is computed PER-TRADE and aggregated across trades
that INDIVIDUALLY passed every per-trade rule:
  • P2 (size cap) passed for that trade
  • P3 (no size-up after loss) passed for that trade
  • P4 (cooldown ≥90s) passed for that trade

Session-level rules P1 (daily loss) and P5 (trade cap) do NOT disqualify
individual trades from execution scoring. EVEN IF the session verdict is
Breach (e.g. because the daily loss limit hit), the trades that passed
every per-trade rule above STILL get scored for Execution. Only return
null sub-metrics when ZERO trades passed all the per-trade rules — and
state that explicitly in execution.notes when it happens.

**GBX / overnight trades are NOT excluded from execution scoring.** A GBX
trade that passed the per-trade rules is scored on Execution Parameters like
any other compliant trade — setup, order-flow, AOI, break-of-cluster, chart-
not-emotion management, mistakes, emotion all still apply. The GBX exemption is
NARROW: it removes a GBX trade from ONLY (a) prep_adherence and (b) the
stop-in-ATR-band criterion (RTH ATR regime doesn't apply). Do NOT drop a GBX
trade from the Execution Parameters average wholesale.

Compute each sub-metric on 0..1 (higher = better):

    - execution_parameters (weight 41%): a 9-criterion per-trade checklist
      averaged across compliant trades. See breakdown below.
    - mfe_capture (weight 24%): realized PnL ÷ peak FAVORABLE move WHILE
      THE POSITION WAS OPEN. Use high_during_position /
      low_during_position per trade — these are the extremes during the
      hold ONLY, NOT what price did after exit. This measures execution
      directly: of the unrealized profit you had on screen while
      holding, how much did you take home. For scale-out trades, use
      mfe_dollars_per_leg when present (scaling-aware: each leg can
      only capture up to the peak in its own hold window, not the
      cumulative peak — exited contracts cannot capture moves that
      happened after they were closed). Falls back to peak × full-qty
      otherwise. DO NOT frame "price kept running after exit" as a
      failure here — that's a separate metric (post-exit drift), not
      this one.
    - prep_adherence (weight 24%): did the trades taken match what was
      planned? Compare prep.bias to trade direction; prep.trade_plans[] to
      actual entries (was each entry a documented plan, or improvised?);
      prep.ib_behaviour / volume_profile_shape predictions to what played
      out; prep.day_types to realized day character. 1.0 = bias-aligned and
      every entry mapped to a documented plan on a correctly-read day. 0.0
      = trades off-bias, no plan match, day character misread. Null only
      when prep notes are entirely blank.
      EXEMPT GBX / OVERNIGHT TRADES: the morning prep (bias, IB behaviour,
      volume profile, RTH trade_plans) describes the RTH session — it does NOT
      apply to a trade taken outside RTH. EXCLUDE any trade with
      tags_json.day_type "GBX" (or entered outside 06:30–13:00 PT) from the
      prep_adherence comparison entirely; grade ONLY the RTH trades against the
      prep. If EVERY trade was GBX, prep_adherence is null (no RTH trade to
      score against the RTH prep) — do not penalize the session for it.
      A BLANK prep field is NOT an adherence miss: a field the trader never
      filled (blank ib_behaviour, blank volume_profile_shape) is nothing to
      "adhere" to — that's a prep-quality gap the separate Prep score already
      covers. Grade adherence ONLY against what was actually planned; never dock
      prep_adherence for prep INCOMPLETENESS.
    - profit_factor (weight 11%): industry-standard PF in DOLLARS — gross
      profit ÷ gross loss. Sum the $pnl of winning trades, divide by the
      absolute value of summed losers. 1.0 = break-even; > 1.0 = net
      profitable; < 1.0 = net losing. Computed deterministically server-
      side, but include your read in the schema. Use ALL trades — no
      stop-price requirement — since PF is a $-pnl metric.

- Composite = 0.41*exec_params + 0.24*mfe + 0.24*prep + 0.11*pf_score
  (pf_score maps profit_factor onto a 0..1 score: clamp(pf/2, 0, 1) —
  PF ≥ 2 maxes out the score, PF = 1 is neutral at 0.5, PF = 0 scores 0).
  Null any sub-metric you can't compute; if all are null, composite is null.
- compliant_trade_count = number of trades you included in the calc.
- If there are zero compliant trades, all execution sub-metrics are null.

**Execution Parameters — 9-criterion per-trade checklist:**
For each compliant trade, evaluate each criterion as pass (1), fail (0), or
N/A (skip the criterion in the denominator). Per-trade score = passes /
(passes + fails). Sub-metric = mean across compliant trades.

Also produce execution_parameter_breakdown — per-criterion pass rate
across the session — so the UI can show which criteria are dragging.

  1. setup_in_playbook — the setup tag on the trade exists in the trader's
     curated 'setups' tag library. Improvised one-off setups not in the
     library fail. N/A if no setup tag at all on the trade.
  2. stop_in_atr_band — stop ÷ ATR-10 mult is in [0.5, 1.5], using the TRADE'S
     OWN entry ATR ("entry ATR-10(1m)" on each trade line), NOT the day/session
     ATR in Market Context. If a trade shows entry ATR "N/A" (e.g. a GBX/
     overnight trade with no bars), mark this criterion N/A and SKIP it — do
     NOT fall back to the RTH session ATR; that volatility regime does not apply
     outside RTH. Sub-0.5 needs tight_stop_reason logged. 10-MNQ trades: ≤1.25
     ATR AND ≤$200 campaign risk. Mechanical — formerly P4, no "marginal" soft zone.
  3. tp1_at_2r_or_reasoned — planned TP1 distance ÷ planned stop distance
     ≥ 2.0. If TP1 < 2R, the EOD recap or trade notes must explicitly
     explain why (one-off structural target etc.). Missing reason = fail.
  4. clear_area_of_interest — the trade is anchored to a specific
     structural level (PDH/PDL, IBH/IBL, ONH/ONL, HTF zone, LVN,
     demand/supply cluster). Generic mid-range entries fail.
  5. two_thirds_orderflow — applies ONLY to trades sized UP to 10 MNQ.
     2/3 OF (delta flip, absorption / delta-bubble failure, delta fade)
     is the GATE FOR THE SIZE-UP, not a requirement for a trade to be
     valid. So:
       • quantity > 5 (sized up): needs ≥2 of 3 OF signals → pass; 0-1 = fail.
       • quantity ≤ 5 (standard size): N/A — SKIP this criterion entirely
         (do not count it in the per-trade denominator). A 5-lot trade
         with 1/3 OF is a perfectly valid trade; it was simply ineligible
         for the size-up exception. Never score it as a #5 fail.
  6. break_of_cluster_or_bubble_entry — the trigger was a structural break
     (price breaking through a cluster of orders, or breaking ABOVE/BELOW a
     delta bubble), NOT a discretionary price entry. PASS AUTOMATICALLY when the
     trade's entry_model tag includes "Break of Clusters/Bubbles" — that tag IS
     the trader declaring this trigger; trust it over your read of the prose.
     NEVER re-judge a tagged break-of-bubble entry as "location-based /
     discretionary" and score it 0. Only an UNtagged, purely discretionary price
     entry (no break-of-cluster/bubble in entry_model, order_flow, or notes)
     fails.
  7. chart_not_emotion_management — exits driven by clear technical /
     structural triggers pass. Worked examples:
       PASS: "Exited long because a HUGE buyer came in above me but
              did NOT get rewarded" — structural read on whether the
              level is holding.
       FAIL: "Exited early because I was scared to give back profits
              before my target" — PnL-anchored emotional exit.
  8. no_mistakes_tagged — tags_json.mistakes is empty on the trade.
  9. stable_emotion — tags_json.emotions includes "Stable". Compromised
     = fail. MAXRAGE = fail AND signals the trader shouldn't have been
     trading at all (call this out in notes).

**Be honest about what you can and can't see:** if orderflow context is missing
for a trade, say so — don't infer it. If you can't tell whether an entry was
Qualifying S&D from the tags, mark execution_parameters criterion #5 fail and
note it.

══ NARRATIVE DISCIPLINE — common over-interpretation patterns to avoid ══

These come up repeatedly in EOD analyses. Read this section CAREFULLY and apply
each rule literally — don't soften, don't add hedges, don't tell stories.

**1. Causation vs correlation.** The market causes trade outcomes, not the
trader's reads. A weak orderflow read does NOT "directly cause" a loss; a
strong read does NOT "directly cause" a win. Correlations exist, but DO NOT
write "T1's not-clean orderflow directly caused the loss" or "the missing OF
read led to the stop-out." Trader reads inform DECISIONS (whether to size up,
whether to take the trade); they don't drive market behavior.
  Correct framing: "T1 entered without 2/3 OF — this is a quality leak that
                    fails execution criterion #5. The stop-out itself was the
                    market's outcome, separate from the read."
  Incorrect:       "T1's missing OF caused the loss."
                   "Entering on 1/3 OF, which led to the stop."

  Setup-without-orderflow STILL has positive EV on its own (the trader's
  baseline stats: S&D alone has 48% WR / +0.43R per trade). 1/3 OF means
  "don't size up to 10 MNQ" — it does NOT mean "this trade shouldn't have
  been taken." Don't frame 1/3-OF entries as wrong; frame them as "ineligible
  for the size-up exception."

**2. P4 cooldown is mechanical. Stop after the math.** If gap ≥ 90s → P4 pass.
That's the end of the analysis for P4. Do NOT add:
  • "but the rush back in after a loss on the same zone is a pattern risk"
  • "passes, but only 3 minutes after a loss is fast"
  • "passes per the rule, but the speed of re-entry bears monitoring"

These are SEPARATE behavioral observations. If you want to call them out,
put them in "patterns" (across-trades observations) or "next_session_focus"
(actionable items for tomorrow). Do NOT attach them as caveats to P4's pass —
that functionally re-fails the rule via tone, which is exactly what v1.4's
binary-rule design exists to prevent.

  Correct framing in process.notes: "All 5 safety rails pass. Compliant."
  Correct framing in patterns:     "Re-entry pattern on same zone after a
                                    loss observed across T1→T2."
  Incorrect:                       "P4 passes BUT the rush back bears
                                    monitoring." (caveat-attached pass)

**3. Hybrid exits with BOTH structural and PnL reasoning pass criterion #7.**
A trade exit can have multiple drivers. If the trader's notes show ANY valid
structural read (resistance approaching, level not holding, OF signal failing,
absorption breaking), the exit passes criterion #7 — EVEN IF PnL anxiety was
also present in the notes. Fail criterion #7 ONLY when the notes show ZERO
structural reasoning behind the exit decision.

  Test: "Would the structural read alone have justified the exit, ignoring
        the PnL concern?" If yes → criterion #7 pass.

  Worked example: trader exits long at +0.5R citing both "scared to give back"
  AND "resistance above with sellers active." If the resistance was real and
  the trade would have eventually stopped if held, the structural read was
  RIGHT — exit passes criterion #7. Tag the fear in execution.notes as a
  behavioral pattern, but do not fail the criterion.

  ONLY fail criterion #7 on exits like: "exited because I was up money and
  wanted to lock it in, no structural reason given" — that's purely PnL-
  anchored with no chart backing.

  RISK-OFF SCRATCHES ARE VALID EXECUTION, NOT MISTAKES. Exiting because the
  TAPE WENT TWO-WAY / order flow is no longer in your favor / directional
  conviction has left IS a read-based exit — the trader read the order flow
  deteriorate in real time. That is NOT "pure uncertainty management" and NOT a
  structural-trigger-less exit; two-way tape is itself the order-flow read.
  A disciplined scratch passes criterion #7 and must NOT appear in mistakes[].
  And NEVER judge the exit by what price did AFTER the trader was out:
  "subsequently moved 1.5 ATR in favor", "would have hit target", "scratched a
  winner" is POST-EXIT information the trader did not have at the decision. A
  sound risk-off exit on a deteriorating read is correct process regardless of
  the counterfactual — framing it as an error is outcome bias (see rule #1) and
  is forbidden. Cutting a trade when your edge is gone is good risk management.

**4. Structural terminology — be literal, don't inflate.** Reserve these
specific terms for their specific structural conditions:
  • "Active downtrend" requires BOTH lower highs AND lower lows. A single
    LH alone is NOT an active downtrend.
  • "Fading the trend" requires an established trend. A single LH means
    "fading a structure break attempt" or "fading a failed continuation",
    not "fading an active downtrend."
  • "Breakdown" requires a confirmed lower low past a prior swing low.
  • "Acceptance" requires bars CLOSING beyond a level, not just touching.

If the data shows ONE LH and no LL, write "after a lower-high formed" or
"into a failing-continuation structure", NOT "into an active downtrend."
Inflated terminology makes the trade sound worse than it was; that bleeds
into how the trader internalizes the day.

**7. ${CAPTURE_UNITS_DISCIPLINE}** This is NARRATION guidance for how you
describe MFE capture / "left on the table" in summary, execution.notes,
what_worked, and mistakes — express it in $ AND ×ATR, and never call a
small-×ATR / big-$ trade a poor capture. It does NOT change the deterministic
mfe_capture math above.

**5. Enumerate before counting.** When scoring criterion #5 (two_thirds_orderflow),
LIST each of the 3 signals you find in the trade's tags / notes / commentary
BEFORE giving the pass/fail. Don't summarize — name them.

  Correct: "T3: delta flip ✓, absorption ✓, delta fade ✓ → 3/3 → pass."
  Correct: "T1: delta flip ✓, absorption ✗, delta fade ✗ → 1/3 → fail."
  Incorrect: "T3 had 2/3 OF signals → pass."  (no per-signal accounting →
              easy to miscount and the trader can't audit your reasoning)

This applies inside execution_parameter_breakdown reasoning AND when citing
trades in process.notes or execution.notes. Trader needs to AUDIT your read
against their own — they can only do that if you enumerate.

**6. Time-of-day is NOT a scored rule — and get the IB clock right.** The
ruleset deliberately has NO entry-time gate (no pre-IB rule, no pre-9am rule,
no post-9:30 rule — all explicitly removed by design). NEVER list the time a
trade was taken as a "mistake" or a rule breach.
  • The Initial Balance (IB) is the first hour of RTH: 06:30–07:30 PT. IB CLOSE
    is 07:30 PT. A trade entered after 07:30 PT is POST-IB. Do NOT call a
    post-07:30 entry "pre-IB" — that is a factual error, and pre-IB vs pre-09:00
    are 90 minutes apart; never conflate them.
  • If the trader's profile documents a timing TENDENCY (e.g. "pre-09:00
    bleeds," "edge is 10:00–12:00 PT"), you MAY surface it — but ONLY in
    patterns[] or next_session_focus[], framed explicitly as the trader's own
    edge data ("your data shows pre-09:00 underperforms"), NEVER in mistakes[]
    and never as a rule violation. The trade can still be a mistake for OTHER
    reasons (FOMO, against-structure, cognitive-freeze hold) — judge those on
    their merits; just don't let the clock be the offense.` : ''

  const legacyFrameworkBlock = useV13 ? '' : `
══ TRADER'S FRAMEWORK (read this before judging anything) ══

The trader uses an MGI-based approach (Market Generated Information). Setups use structural levels (PDH, PDL, IBH, IBL, ONH, ONL, HTF supply/demand). Entry triggers are order-flow based.

CRITICAL weighting rules:
1. Realized behavior outweighs opportunity cost. A missed setup is a maybe; a taken FOMO trade is a definite loss.
2. Patience ≠ paralysis.
3. Journal compliance is a major strength — call it out.
4. Near-TP exits aren't meaningful leaks.
5. FOMO entries are real mistakes — name them clearly.`

  return `You are an objective trading coach reviewing a trader's completed session${hasImage ? ' and the day\'s chart' : ''}.
${v13Block}${legacyFrameworkBlock}
${chartInstructions}

Day Prep Summary:
- Bias: ${prepNotes?.bias ?? 'Not set'} ${prepNotes?.bias_notes ?? ''}
- IB Behaviour expected: ${prepNotes?.ib_behaviour ?? 'Not set'}
- Volume Profile expected: ${prepNotes?.volume_profile_shape ?? 'Not set'}
- Mood / Clarity: ${prepNotes?.mood ?? 'Not set'} / ${prepNotes?.market_clarity ?? 'Not set'}
- AI Prep Quality Score (if any): ${prepAnalysis?.score ?? 'N/A'}/10
- Plans planned: ${prepNotes?.trade_plans?.length ?? 0}

Market Context:
- Rvol: ${marketContext?.rvol ?? 'N/A'}
- IB Size: ${marketContext?.ib_size ?? 'N/A'} (vs 10d avg ratio: ${marketContext?.ib_vs_10d_avg ?? 'N/A'})
- ADR: ${marketContext?.adr ?? 'N/A'} | ATR (1m): ${marketContext?.atr_1m ?? 'N/A'}
- PDH/PDL: ${marketContext?.pdh ?? 'N/A'} / ${marketContext?.pdl ?? 'N/A'}
- IBH/IBL: ${marketContext?.ibh ?? 'N/A'} / ${marketContext?.ibl ?? 'N/A'}

Session Summary (all timestamps America/Los_Angeles; cite them in PT in your reasoning).
Session clock for reference: RTH 06:30–13:00 PT; Initial Balance 06:30–07:30 PT (IB CLOSE = 07:30 PT). A trade entered after 07:30 PT is POST-IB. There is NO entry-time rule — timing is never a process breach (see narrative discipline #6).
- Trades: ${trades.length} (W ${wins} / L ${losses})
- Total PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}

Trades Taken (each may include the trader's own notes and a frame-grounded AI commentary written earlier from the OBS recording — treat the commentary as a separate independent observation from the structured tags):
${tradesBlock}

Trader's EOD Reflection:
${eodNotes?.trim() || '(none provided)'}

${useV13 ? `Respond with ONLY valid JSON in this exact structure (no markdown, no code fences):
{
  "summary": "<2-3 sentences on the session — call out the process verdict AND a one-line execution read>",
  "what_worked": ["<concrete behavior/decision that was a win>", "<up to 4 total>"],
  "mistakes": ["<recurring or specific bad decision — cite trades by number/time>", "<up to 5 total>"],
  "patterns": ["<setup/timing/management pattern across trades>", "<up to 4 total>"],
  "next_session_focus": ["<actionable focus item for tomorrow>", "<up to 3 total>"],
  "process": {
    "verdict": "Compliant" | "Breach",
    "per_rule": {
      "P1": { "status": "pass" | "fail", "breach_count": <number>, "reason": "<brief if fail>" },
      "P2": { "status": "...", "breach_count": <number>, "reason": "..." },
      "P3": { "status": "...", "breach_count": <number>, "reason": "..." },
      "P4": { "status": "...", "breach_count": <number>, "reason": "..." },
      "P5": { "status": "...", "breach_count": <number>, "reason": "..." }
    },
    "breach_count_vector": { "P1": <number>, "P2": <number>, "P3": <number>, "P4": <number>, "P5": <number> },
    "headline": "<1 sentence ≤15 words — the WHY of the verdict in one line, always visible above per-rule chips>",
    "notes": "<1-2 sentences ONLY — diagnostic detail behind 'Show details'. Do NOT include per-rule arithmetic, breach math, or 'P4 breach: 77s gap...' — that's already in per_rule[].reason.>"
  },
  "execution": {
    "execution_parameters": <0..1 or null>,
    "mfe_capture": <0..1 or null>,
    "prep_adherence": <0..1 or null>,
    "profit_factor": <0..∞ or null — winning R ÷ losing R; 1.0 = break-even>,
    "composite": <0..1 or null>,
    "compliant_trade_count": <number>,
    "execution_parameter_breakdown": {
      "setup_in_playbook": <0..1 or null>,
      "stop_in_atr_band": <0..1 or null>,
      "tp1_at_2r_or_reasoned": <0..1 or null>,
      "clear_area_of_interest": <0..1 or null>,
      "two_thirds_orderflow": <0..1 or null>,
      "break_of_cluster_or_bubble_entry": <0..1 or null>,
      "chart_not_emotion_management": <0..1 or null>,
      "no_mistakes_tagged": <0..1 or null>,
      "stable_emotion": <0..1 or null>
    },
    "headline": "<1 sentence ≤15 words — WHY this execution score, always visible. Examples: 'Three give-backs and stops blown on T1/T3/T4 collapse capture; only T2 traded clean.' / 'Clean entry quality but exit timing left 60% of MFE on the table.'>",
    "notes": "<2-3 sentences MAX — brief diagnostic narrative behind 'Show details'. ABSOLUTELY DO NOT include: per-trade arithmetic ('T1 MAE = 19.25 vs 19'), criterion-by-criterion lists ('setup_in_playbook=1.0, stop_in_atr_band=0...'), composite-recompute formulas ('0.35*0.41+0.20*0.10...'), or 'Reporting X = Y' lines. Those numbers are already in the per-metric chips above and the execution_parameter_breakdown object — re-narrating them is wasted text. Just describe in plain English what dragged the score and what didn't, like a coach commenting, not a calculator showing work.>"
  }
}

Be direct. If the day was a Breach, say so plainly — don't soften it with "but the PnL was good." If the day was Compliant with poor execution, name that too — process compliance doesn't excuse sloppy execution. Magnitude doesn't matter for process; even a +$50 breach is still a breach.

LENGTH DISCIPLINE — the response must be valid JSON, so keep prose tight:
  • Per-rule reasons: 1 short sentence max (under 25 words). Cite specifics, don't argue.
  • process.headline + execution.headline: 1 sentence, ≤15 words. The "why this score" in plain English. Always visible — make every word count.
  • process.notes + execution.notes: 2-3 sentences MAX, behind a "Show details" toggle. Diagnostic narrative, NOT a calculation trace. Forbidden in notes: per-trade arithmetic ("T1 MAE = 19.25"), criterion lists ("setup_in_playbook=1.0..."), composite formulas ("0.35*0.41+..."), "Reporting X = Y" lines. The numbers are already in the chips and breakdown object — re-narrating them wastes user attention.
  • what_worked / mistakes / patterns / next_session_focus bullets: 1 sentence each.
  • Do NOT wrap the JSON in markdown fences (no \`\`\`json). The whole response should start with { and end with }.` : `Respond with ONLY valid JSON in this exact structure (no markdown, no code fences):
{
  "summary": "<2-3 sentences on overall session quality>",
  "what_worked": ["<specific behaviour/decision that was a win>", "<up to 4 total>"],
  "mistakes": ["<recurring mistake or specific bad decision>", "<up to 5 total>"],
  "patterns": ["<setup/timing/management pattern across trades>", "<up to 4 total>"],
  "next_session_focus": ["<actionable focus item for tomorrow>", "<up to 3 total>"],
  "score": <integer 1-10>
}

Be direct. If the day was poor, say so.`}`
}

// ─── Response parsing ────────────────────────────────────────────────────────

/**
 * Compute Profit Factor deterministically. Industry-standard formula in
 * DOLLARS (NOT R-units) — gross profit ÷ gross loss:
 *
 *   PF > 1.0  → net profitable ("made more than lost")
 *   PF = 1.0  → break-even
 *   PF < 1.0  → net losing
 *   PF = 0    → no winning trades at all
 *
 * Earlier implementation required stop_price (to convert pnl to R), which
 * silently dropped trades that lacked a logged stop — on a day with $479
 * + $219 winners (stops logged) but $181/$120/$103 losers (stops missing),
 * the loss sum collapsed to 0 and PF returned the infinity sentinel (10).
 * Dollars formula needs only pnl, which every trade has.
 *
 * Returns null when no eligible trades. With losers but no winners, returns 0.
 * With winners but no losers, returns the sentinel 10 (displayed as "9.99+").
 */
export function computeProfitFactorDeterministic(
  trades: Pick<Trade, 'pnl'>[],
): { value: number | null; eligibleCount: number } {
  let winSum = 0
  let lossSum = 0
  let n = 0
  for (const t of trades) {
    if (t.pnl == null) continue
    if (t.pnl > 0) winSum += t.pnl
    else if (t.pnl < 0) lossSum += -t.pnl
    n++
  }
  if (n === 0) return { value: null, eligibleCount: 0 }
  if (lossSum === 0) return winSum > 0 ? { value: 10, eligibleCount: n } : { value: null, eligibleCount: 0 }
  return { value: winSum / lossSum, eligibleCount: n }
}

/** Map a Profit Factor value (0..∞, 1.0 = break-even) onto the 0..1
 *  sub-metric scale used by the execution composite. PF ≥ 2.0 maxes out
 *  the score at 1.0 (you doubled what you lost); PF = 1.0 sits in the
 *  middle at 0.5 (break-even is neutral); PF = 0 scores 0. */
export function profitFactorToSubMetric(pf: number | null): number | null {
  if (pf == null) return null
  return Math.max(0, Math.min(1, pf / 2))
}

/**
 * Compute MFE Capture deterministically over compliant-eligible trades.
 *
 *   per_trade_cap   = pnl ÷ mfe_dollars  (clamped to [0, 1])
 *   mfe_dollars     = mfe_dollars_per_leg when populated (scaling-aware), else
 *                     peak_favorable_pts × qty × multiplier
 *   MFE Capture     = mean(per_trade_cap) across eligible trades
 *
 * Eligible:
 *   - has direction, entry_price, quantity, pnl, AND the relevant excursion
 *     extreme (high_during_position for longs, low_during_position for shorts).
 *   - peak_favorable_pts is at least 20% of planned_risk_pts (matches the
 *     dashboard's "MFE < 20% of planned risk" exclusion — denominator too
 *     small to be meaningful capture-ratio noise). Requires stop_price so
 *     planned_risk is defined; trades without a stop are excluded.
 *
 * Clamping [0, 1] is essential — give-back trades have negative pnl/mfe and
 * would otherwise crater the mean if just one of them lands. The sub-metric
 * measures "how well did you capture on average," not "how badly did one
 * give-back drag the day."
 */
type MfeCaptureTrade = Pick<Trade, 'entry_price' | 'stop_price' | 'quantity' | 'direction' | 'pnl' | 'symbol' | 'high_during_position' | 'low_during_position'> & { mfe_dollars_per_leg?: number | null }
export function computeMfeCaptureDeterministic(
  trades: MfeCaptureTrade[],
): { value: number | null; eligibleCount: number } {
  let sum = 0
  let n = 0
  for (const t of trades) {
    if (t.entry_price == null || t.quantity == null || t.pnl == null || t.direction == null) continue
    if (t.stop_price == null) continue
    const isLong = t.direction === 'long'
    const peakPrice = isLong ? t.high_during_position : t.low_during_position
    if (peakPrice == null) continue
    const peakPts = isLong ? peakPrice - t.entry_price : t.entry_price - peakPrice
    const plannedRiskPts = Math.abs(t.entry_price - t.stop_price)
    if (plannedRiskPts === 0) continue
    if (peakPts < 0.2 * plannedRiskPts) continue  // MFE too small — denominator noise
    const mult = symbolToMultiplier(t.symbol ?? '')
    if (mult === 0) continue
    const mfeDollars = (t.mfe_dollars_per_leg != null && t.mfe_dollars_per_leg > 0)
      ? t.mfe_dollars_per_leg
      : peakPts * t.quantity * mult
    if (mfeDollars <= 0) continue
    const raw = t.pnl / mfeDollars
    sum += Math.max(0, Math.min(1, raw))
    n++
  }
  return { value: n > 0 ? sum / n : null, eligibleCount: n }
}

/**
 * Compute the four mechanical P-rule outcomes deterministically. The AI has
 * been observed to hallucinate per-rule status — returning "pass" while its
 * own reason text says "Breach", or returning a non-zero breach_count_vector
 * entry alongside a "pass" status (internal inconsistency). P1/P3/P4/P5 are
 * all pure arithmetic over trade entry/exit times, pnl, and qty — no
 * judgment needed. P2 (size cap) stays AI-driven because the cap is
 * setup-conditional (5 MNQ default, 10 only on Qualifying S&D).
 *
 * Rules per spec (eod-prompt.ts ~line 178):
 *   P1: Session net P&L not past −$500
 *   P3: No size-up after loss (post-loss → ≤5 MNQ, no scale to 10)
 *   P4: Cooldown ≥90s after any loss
 *   P5: Trade cap ≤7 trades/session
 *
 * Each returned status carries a reason string written for the per_rule
 * tooltip — keeps the UI consistent and avoids depending on the AI to
 * narrate the breach correctly.
 */
export interface DeterministicRuleResult {
  status: 'pass' | 'fail'
  breach_count: number
  reason: string
}

export function computeDeterministicRules(
  trades: Pick<Trade, 'id' | 'entry_time' | 'exit_time' | 'quantity' | 'pnl'>[],
): { P1: DeterministicRuleResult; P3: DeterministicRuleResult; P4: DeterministicRuleResult; P5: DeterministicRuleResult } {
  const DAILY_LOSS_LIMIT = -500
  // Slippage buffer on the DLL. Stop fills aren't perfect — a market stop at
  // the DLL price routinely fills $5-40 worse than the trigger in fast tape.
  // Closing at -$507 against a -$500 DLL is a fill artifact, NOT a discipline
  // breach (the trader DID stop where they planned; the market gapped through).
  // Only flag P1 when the overshoot exceeds this buffer, which indicates the
  // trader actually kept trading past the limit rather than just got slipped.
  const DLL_SLIPPAGE_BUFFER = 50
  const DLL_HARD_FLOOR = DAILY_LOSS_LIMIT - DLL_SLIPPAGE_BUFFER  // -550
  const POST_LOSS_QTY_CAP = 5
  const COOLDOWN_SEC = 90
  const TRADE_CAP = 7

  const sorted = [...trades]
    .filter(t => t.entry_time)
    .sort((a, b) => Date.parse(a.entry_time!) - Date.parse(b.entry_time!))

  // ── P1: daily loss limit (with slippage buffer) ────────────────────────
  const netPnl = sorted.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const withinBuffer = netPnl < DAILY_LOSS_LIMIT && netPnl >= DLL_HARD_FLOOR
  const P1: DeterministicRuleResult = netPnl < DLL_HARD_FLOOR
    ? { status: 'fail', breach_count: 1, reason: `Session net P&L $${netPnl.toFixed(2)} blew through the $${DAILY_LOSS_LIMIT} DLL by more than the $${DLL_SLIPPAGE_BUFFER} slippage buffer (hard floor $${DLL_HARD_FLOOR}).` }
    : withinBuffer
      ? { status: 'pass', breach_count: 0, reason: `Session net P&L $${netPnl.toFixed(2)} is past the $${DAILY_LOSS_LIMIT} DLL but within the $${DLL_SLIPPAGE_BUFFER} slippage buffer — counted as a stop-fill artifact, not a breach.` }
      : { status: 'pass', breach_count: 0, reason: `Session net P&L $${netPnl.toFixed(2)} within the $${DAILY_LOSS_LIMIT} daily loss limit.` }

  // ── P3 + P4: post-loss checks (size + cooldown), REALIZED-LOSS aware ────
  // Both rules react to a loss that has actually CLOSED. Earlier versions
  // used entry-time adjacency ("the trade before this one was a loss"),
  // which mis-fired on scale-ins / overlapping positions: if you open the
  // next trade BEFORE the prior one closes, no loss has been realized yet,
  // so there was no post-loss decision to violate. Example that exposed
  // this (2026-06-18): a 10-lot winner opened at 01:29:00 while a separate
  // 10-lot stop-out was still open (it closed at 01:29:10). Entry-adjacency
  // flagged the winner as a "size-up after a loss" and the −11s gap as a
  // "cooldown breach" — both wrong, because the loss hadn't happened when
  // the winner was opened.
  //
  // Fix: for each trade, find the most recent OTHER trade that CLOSED at or
  // before this trade OPENED. Only if THAT trade was a loss do P3/P4 apply.
  const p3Breaches: string[] = []
  const p4Breaches: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    const curr = sorted[i]
    if (!curr.entry_time) continue
    const openMs = Date.parse(curr.entry_time)
    if (!Number.isFinite(openMs)) continue

    // Most recent trade that had already closed when `curr` opened.
    let lastClosed: typeof curr | null = null
    let lastClosedExitMs = -Infinity
    for (let j = 0; j < sorted.length; j++) {
      if (j === i) continue
      const o = sorted[j]
      if (!o.exit_time) continue
      const exitMs = Date.parse(o.exit_time)
      if (!Number.isFinite(exitMs)) continue
      if (exitMs <= openMs && exitMs > lastClosedExitMs) {
        lastClosed = o
        lastClosedExitMs = exitMs
      }
    }
    // P3/P4 only react when the immediately-preceding REALIZED trade was a loss.
    if (!lastClosed || (lastClosed.pnl ?? 0) >= 0) continue

    // P3 — size after a realized loss must be ≤ POST_LOSS_QTY_CAP
    if (curr.quantity != null && curr.quantity > POST_LOSS_QTY_CAP) {
      p3Breaches.push(`T${i + 1} sized ${curr.quantity} after a realized loss`)
    }

    // P4 — gap from the loss closing to this trade opening must be ≥ COOLDOWN_SEC
    const gapSec = (openMs - lastClosedExitMs) / 1000
    if (Number.isFinite(gapSec) && gapSec < COOLDOWN_SEC) {
      p4Breaches.push(`T${i + 1} opened ${gapSec.toFixed(0)}s after the prior loss closed`)
    }
  }
  const P3: DeterministicRuleResult = p3Breaches.length === 0
    ? { status: 'pass', breach_count: 0, reason: `No size-up after a loss; every post-loss trade was ≤${POST_LOSS_QTY_CAP} contracts.` }
    : { status: 'fail', breach_count: p3Breaches.length, reason: `Post-loss size-up: ${p3Breaches.join('; ')}.` }
  const P4: DeterministicRuleResult = p4Breaches.length === 0
    ? { status: 'pass', breach_count: 0, reason: `Every loss was followed by ≥${COOLDOWN_SEC}s pause before re-entry.` }
    : { status: 'fail', breach_count: p4Breaches.length, reason: `${p4Breaches.length} cooldown breach${p4Breaches.length === 1 ? '' : 'es'}: ${p4Breaches.join('; ')}.` }

  // ── P5: trade cap ──────────────────────────────────────────────────────
  const n = sorted.length
  const P5: DeterministicRuleResult = n <= TRADE_CAP
    ? { status: 'pass', breach_count: 0, reason: `${n} trade${n === 1 ? '' : 's'} taken; within the ${TRADE_CAP}-trade cap.` }
    : { status: 'fail', breach_count: n - TRADE_CAP, reason: `${n} trades taken; ${n - TRADE_CAP} past the ${TRADE_CAP}-trade cap.` }

  return { P1, P3, P4, P5 }
}

/** Recompute the execution composite using whatever sub-metrics are non-null.
 *  Mirrors what the AI does: drop null metrics from both numerator AND
 *  denominator so the active weights re-normalize to 1.0. Returns null when
 *  every sub-metric is null. */
export function recomputeExecutionComposite(e: {
  execution_parameters: number | null
  mfe_capture: number | null
  prep_adherence: number | null
  // New post-2026-06-15: profit_factor is the canonical PF-weight metric.
  // planned_vs_realized_rr stays in the type so legacy rows that haven't
  // been re-analyzed still contribute to composite via the fallback below.
  profit_factor?: number | null
  planned_vs_realized_rr?: number | null
}): number | null {
  // Amendment 4 (2026-06-20): mae_heat dropped from the composite. The four
  // remaining sub-metrics renormalize to 41 / 24 / 24 / 11. (Because null
  // sub-metrics already drop out of both numerator and denominator below, a
  // stored mae_heat on a legacy row no longer influences the score — it's
  // simply absent from this weight table.)
  //
  // Prefer profit_factor (mapped to 0..1 via clamp(pf/2, 0, 1)); fall back
  // to legacy RR for un-re-analyzed days. Whichever is present, the weight
  // stays at 11% so the composite is comparable across days.
  const pfScore = profitFactorToSubMetric(e.profit_factor ?? null)
  const rrLegacy = e.planned_vs_realized_rr ?? null
  const pfWeightValue = pfScore != null ? pfScore : rrLegacy
  const weights: Array<[number | null, number]> = [
    [e.execution_parameters, 0.41],
    [e.mfe_capture, 0.24],
    [e.prep_adherence, 0.24],
    [pfWeightValue, 0.11],
  ]
  let num = 0, den = 0
  for (const [v, w] of weights) {
    if (v == null) continue
    num += v * w
    den += w
  }
  return den > 0 ? num / den : null
}

/**
 * Apply all deterministic overrides to a parsed EOD analysis, in place, and
 * return it. This is the SINGLE SOURCE OF TRUTH for the override logic so the
 * live route (/api/analyze-eod) and the batch rescore script
 * (scripts/rescore-eod-stale.ts) can never drift — previously the route had
 * the overrides inline and the script didn't, so batch-rescored days came out
 * with the AI's raw (unreliable) numbers.
 *
 * Overrides:
 *   - P1/P3/P4/P5 mechanical rules (P2 stays AI-driven — setup-conditional cap)
 *   - verdict re-derived from pass_count (≥4/5 = Compliant)
 *   - profit_factor (replaces legacy planned_vs_realized_rr)
 *   - mfe_capture (pure-arithmetic sub-metric; mae_heat dropped in amendment 4)
 *   - execution composite recomputed when any sub-metric changed
 *
 * `onLog` is an optional callback for the route's per-override console logging;
 * pass undefined to stay silent (the script prints its own summary).
 */
export function applyDeterministicOverrides(
  parsed: EodAiAnalysis,
  trades: Pick<Trade, 'id' | 'entry_time' | 'exit_time' | 'quantity' | 'pnl' | 'entry_price' | 'stop_price' | 'direction' | 'symbol' | 'high_during_position' | 'low_during_position'>[],
  onLog?: (msg: string) => void,
): EodAiAnalysis {
  const log = onLog ?? (() => {})

  if (parsed.process) {
    const det = computeDeterministicRules(trades)
    let touchedProcess = false
    const ruleKeys: Array<'P1' | 'P3' | 'P4' | 'P5'> = ['P1', 'P3', 'P4', 'P5']
    for (const k of ruleKeys) {
      const ai = parsed.process.per_rule[k]
      const calc = det[k]
      const aiBc = ai?.breach_count ?? 0
      const changed = !ai || ai.status !== calc.status || aiBc !== calc.breach_count
      if (changed) {
        log(`overriding ${k} ${ai?.status ?? 'undef'}/${aiBc} → ${calc.status}/${calc.breach_count}`)
        touchedProcess = true
      }
      // ALWAYS write the deterministic result — even when the AI's status
      // happened to match, its reason text can be garbled or self-
      // contradictory (e.g. status="pass" with a reason that argues "P3
      // breach"). These rules are fully deterministic, so the clean computed
      // reason is authoritative and always wins.
      parsed.process.per_rule[k] = { status: calc.status, breach_count: calc.breach_count, reason: calc.reason }
      if (parsed.process.breach_count_vector) parsed.process.breach_count_vector[k] = calc.breach_count
    }
    if (touchedProcess) {
      const passCount = Object.values(parsed.process.per_rule).filter(r => r?.status === 'pass').length
      const newVerdict: 'Compliant' | 'Breach' = passCount >= 4 ? 'Compliant' : 'Breach'
      if (parsed.process.verdict !== newVerdict) {
        log(`verdict re-derived ${parsed.process.verdict} → ${newVerdict} (pass_count ${passCount}/5)`)
        parsed.process.verdict = newVerdict
      }
    }
  }

  if (parsed.execution) {
    let touched = false
    const overrideIfDifferent = (label: string, aiVal: number | null, calcVal: number | null, apply: (v: number) => void, eligibleCount: number) => {
      if (calcVal == null) return
      if (aiVal != null && Math.abs(aiVal - calcVal) <= 0.05) return
      log(`overriding ${label} ${aiVal} → ${calcVal.toFixed(3)} (${eligibleCount} eligible)`)
      apply(calcVal)
      touched = true
    }

    const pf = computeProfitFactorDeterministic(trades)
    overrideIfDifferent('profit_factor', parsed.execution.profit_factor ?? null, pf.value,
      v => { parsed.execution!.profit_factor = v; parsed.execution!.planned_vs_realized_rr = null }, pf.eligibleCount)

    const mfe = computeMfeCaptureDeterministic(trades)
    overrideIfDifferent('mfe_capture', parsed.execution.mfe_capture, mfe.value,
      v => { parsed.execution!.mfe_capture = v }, mfe.eligibleCount)

    if (touched) {
      const recomputed = recomputeExecutionComposite(parsed.execution)
      if (recomputed != null) parsed.execution.composite = recomputed
    }
  }

  return parsed
}

/**
 * Parses Claude's raw text response into a typed EodAiAnalysis. Tolerates:
 *   - Leading/trailing ```json fences (stripped)
 *   - Mid-string truncation (falls back to a stub with the raw text in `summary`)
 * Always stamps `analyzed_at` on the returned object.
 */
export function parseEodResponse(text: string): EodAiAnalysis {
  const fallback: EodAiAnalysis = {
    summary: text,
    what_worked: [],
    mistakes: [],
    patterns: [],
    next_session_focus: [],
    score: 0,
    analyzed_at: new Date().toISOString(),
  }
  try {
    const stripped = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
    const jsonMatch = stripped.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.warn('[eod-prompt] no JSON braces found in response (likely truncated). length=', text.length)
      return fallback
    }
    const parsed = JSON.parse(jsonMatch[0]) as EodAiAnalysis
    return { ...parsed, analyzed_at: new Date().toISOString() }
  } catch (e) {
    console.warn('[eod-prompt] JSON parse failed (likely mid-string truncation). length=', text.length, 'err=', e instanceof Error ? e.message : e)
    return fallback
  }
}
