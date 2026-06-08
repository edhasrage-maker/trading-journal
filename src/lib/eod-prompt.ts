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
        const mistakes = t.tags_json?.mistakes?.join(', ') || '—'
        const emotions = t.tags_json?.emotions?.join(', ') || '—'
        const mgmt = t.tags_json?.trade_management?.join(', ') || '—'
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
        return `  ${i + 1}. open ${time} → close ${exitTime} | ${dir} @ ${t.entry_price ?? '?'} stop ${t.stop_price ?? '?'} TP1 ${tp1} exit ${exit} qty ${t.quantity ?? '?'} | PnL ${pnl}
       intra-trade extremes: high=${hdp} low=${ldp}
       setups: ${setups} | confluences: ${confluences}
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
  • P1 = Daily loss limit (Session Net P&L not past −$500)
  • P2 = Size within cap (≤5 MNQ; ≤10 only on Qualifying S&D)
  • P3 = No size-up after loss (post-loss → ≤5 MNQ, no scale to 10)
  • P4 = Cooldown ≥90s after any loss
  • P5 = Trade cap ≤7 trades/session

**Execution layer (continuous, diagnostic, per-trade aggregation):**
Per v1.4 amendment 3 (2026-06-08): Duration-to-thesis REMOVED; a 9-criterion
Execution Parameters sub-metric REPLACES it at 35%. All weights rebalanced.

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

Compute each sub-metric on 0..1 (higher = better):

    - execution_parameters (weight 35%): a 9-criterion per-trade checklist
      averaged across compliant trades. See breakdown below.
    - mfe_capture (weight 20%): realized PnL ÷ peak favorable move. Use
      high_during_position / low_during_position if provided per trade.
    - prep_adherence (weight 20%): did the trades taken match what was
      planned? Compare prep.bias to trade direction; prep.trade_plans[] to
      actual entries (was each entry a documented plan, or improvised?);
      prep.ib_behaviour / volume_profile_shape predictions to what played
      out; prep.day_types to realized day character. 1.0 = bias-aligned and
      every entry mapped to a documented plan on a correctly-read day. 0.0
      = trades off-bias, no plan match, day character misread. Null only
      when prep notes are entirely blank.
    - mae_heat (weight 15%): 1 - (peak adverse / planned risk). Lower heat
      taken = higher score.
    - planned_vs_realized_rr (weight 10%): realized_rr ÷ reward_ratio
      (when both available). Compute from per-trade TP1/exit/stop in the
      trade block above.

- Composite = 0.35*exec_params + 0.20*mfe + 0.20*prep + 0.15*mae + 0.10*rr.
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
  2. stop_in_atr_band — stop ÷ ATR-10 mult is in [0.5, 1.5]. Sub-0.5
     needs tight_stop_reason logged. 10-MNQ trades: ≤1.25 ATR AND ≤$200
     campaign risk. Mechanical — formerly P4, no "marginal" soft zone.
  3. tp1_at_2r_or_reasoned — planned TP1 distance ÷ planned stop distance
     ≥ 2.0. If TP1 < 2R, the EOD recap or trade notes must explicitly
     explain why (one-off structural target etc.). Missing reason = fail.
  4. clear_area_of_interest — the trade is anchored to a specific
     structural level (PDH/PDL, IBH/IBL, ONH/ONL, HTF zone, LVN,
     demand/supply cluster). Generic mid-range entries fail.
  5. two_thirds_orderflow — trade has ≥2 of 3 strong orderflow signals:
     delta flip, absorption (delta bubble failure), delta fade. 0 or 1
     OF signals = fail.
  6. break_of_cluster_or_bubble_entry — the trigger was a structural break
     (price breaking through a cluster of orders or breaking a bubble),
     NOT a discretionary price entry. Discretionary entries fail.
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
note it.` : ''

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

Session Summary (all timestamps America/Los_Angeles; cite them in PT in your reasoning):
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
    "notes": "<1-2 sentences on the verdict reasoning>"
  },
  "execution": {
    "execution_parameters": <0..1 or null>,
    "mfe_capture": <0..1 or null>,
    "prep_adherence": <0..1 or null>,
    "mae_heat": <0..1 or null>,
    "planned_vs_realized_rr": <0..1 or null>,
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
    "notes": "<1-2 sentences diagnostic; never blends with process verdict>"
  }
}

Be direct. If the day was a Breach, say so plainly — don't soften it with "but the PnL was good." If the day was Compliant with poor execution, name that too — process compliance doesn't excuse sloppy execution. Magnitude doesn't matter for process; even a +$50 breach is still a breach.

LENGTH DISCIPLINE — the response must be valid JSON, so keep prose tight:
  • Per-rule reasons: 1 short sentence max (under 25 words). Cite specifics, don't argue.
  • process.notes + execution.notes: 1-2 sentences each.
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
