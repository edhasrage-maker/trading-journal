import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { consumeAiUsage } from '@/lib/ai-usage'
import { createClient } from '@/lib/supabase/server'
import type { PrepNotes } from '@/lib/supabase/types'
import { normalizeAnthropicMediaType } from '@/lib/anthropic-image'
import { getTraderProfile, profileContextBlock } from '@/lib/trader-profile'
import { clientError } from '@/lib/api-error'

const client = new Anthropic()

export async function POST(req: Request) {
  try {
    return await handle(req)
  } catch (e) {
    const err = e as { message?: string; status?: number; error?: { type?: string; message?: string } }
    const detail =
      err?.error?.message ??
      err?.message ??
      'unknown server error'
    console.error('[analyze-prep] failed:', err)
    return NextResponse.json(
      { error: clientError(detail), type: err?.error?.type, status: err?.status },
      { status: 500 },
    )
  }
}

async function handle(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY is not configured on the server. Add it to .env.local and restart the dev server.' },
      { status: 503 },
    )
  }

  if (!LOCAL_FEATURES_ENABLED) {
    const supabase = await createClient()
    const gate = await consumeAiUsage(supabase, 'analyze_prep')
    if (!gate.allowed) return NextResponse.json({ error: gate.message, ...gate }, { status: 429 })
  }

  const { prepNotes, marketContext, imageBase64, imageMediaType } = await req.json() as {
    prepNotes: PrepNotes
    marketContext: Record<string, number | null>
    imageBase64?: string | null
    imageMediaType?: string | null
  }

  // Normalise the image media type. If it's missing/unsupported, fall back to
  // text-only analysis rather than 400ing — better UX than a hard fail.
  const normalizedMediaType = imageBase64 ? normalizeAnthropicMediaType(imageMediaType) : null
  const hasImage = !!imageBase64 && normalizedMediaType != null
  if (imageBase64 && !hasImage) {
    console.warn('[analyze-prep] dropping image — unsupported media type:', imageMediaType)
  }

  // Derive PT time of analysis so the AI knows what data the trader could observe
  const ptParts: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hourCycle: 'h23',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date())) ptParts[p.type] = p.value
  const ptMinutesNow = Number(ptParts.hour) * 60 + Number(ptParts.minute)
  const ptTimeLabel = `${ptParts.hour}:${ptParts.minute} PT`
  const sessionCtx = ptMinutesNow < 6 * 60 + 30
    ? `PRE-MARKET (before 6:30 AM PT — no session VP data exists)`
    : ptMinutesNow < 7 * 60 + 30
    ? `IB FORMING (6:30–7:30 AM PT — RTH open, IB not yet complete, partial VP only)`
    : `POST-IB (after 7:30 AM PT — IB complete, trader has live chart with ≥1h of RTH VP visible)`

  const plans = prepNotes.trade_plans ?? []
  const plansBlock = plans.length > 0
    ? plans.map((p, i) => `
  Plan ${i + 1}: ${p.direction.toUpperCase()} — ${p.setup_name || 'Unnamed'}
    Trader Quality Rating: ${p.quality}/5
    Reasons: ${p.quality_reasons.filter(Boolean).join('; ') || 'None provided'}
    Invalidation: ${p.invalidation || 'Not provided'}
    Targets: ${p.targets || 'Not provided'}
    Scary Factors: ${p.scary_factors || 'Not provided'}`).join('\n')
    : '  None provided'

  const planIdsBlock = plans.length > 0
    ? `Plan IDs for plan_assessments: ${plans.map((p, i) => `Plan ${i + 1} id="${p.id}"`).join(', ')}`
    : ''

  // Objective, computed market levels — facts, NOT the trader's opinion. Safe
  // to feed the blind chart-read pass so it can cite real prices without being
  // told the trader's bias/plans.
  const marketLevelsBlock = `Market Context (computed levels — objective, not the trader's read):
- Rvol: ${marketContext.rvol ?? 'N/A'}
- IB Size: ${marketContext.ib_size ?? 'N/A'} (vs 10d avg ratio: ${marketContext.ib_vs_10d_avg ?? 'N/A'})
- ADR: ${marketContext.adr ?? 'N/A'} | ATR (1m): ${marketContext.atr_1m ?? 'N/A'}
- PDH/PDL: ${marketContext.pdh ?? 'N/A'} / ${marketContext.pdl ?? 'N/A'}
- IBH/IBL: ${marketContext.ibh ?? 'N/A'} / ${marketContext.ibl ?? 'N/A'}
- ONH/ONL: ${marketContext.onh ?? 'N/A'} / ${marketContext.onl ?? 'N/A'}`

  // ── PASS 1: BLIND CHART READ ───────────────────────────────────────────
  // Run as a SEPARATE API call that sees ONLY the image + objective levels —
  // never the trader's bias, plans, volume-profile read, mood, or notes. This
  // is what makes the chart read truly independent: the model physically does
  // not have the trader's framing in context when it forms the read, so it
  // cannot anchor to or parrot it. Best-effort — on any failure we fall through
  // to the evaluation pass with no chart read rather than 500ing the whole
  // analysis.
  let chartRead: { chart_thesis?: string; chart_structure_notes?: string[] } | null = null
  if (hasImage) {
    const chartReadPrompt = `You are an objective futures chart analyst. You are shown ONLY a trading chart screenshot — NO trader notes, NO stated bias, nothing about what the trader intends to do. Read the chart entirely on its own terms.

Identify independently:
- Overall structure: is price trending (HH/HL or LH/LL), rotating, or choppy?
- Volume profile shape and where the bulk of volume is built
- Key visible levels price is reacting to (label them by price if readable)
- VWAP and EMA positions and slopes relative to price
- Any visible order-flow signals: absorption, rejection, imbalance, failed auction
- What the market appears to be doing and where it likely wants to go next

${marketLevelsBlock}

Respond with ONLY valid JSON (no markdown, no code fences):
{
  "chart_thesis": "<your own 2-3 sentence read of market structure and likely direction, from the chart alone>",
  "chart_structure_notes": ["<specific visual observation — cite prices/patterns you actually see, e.g. 'Price broke IBH at 30968 and immediately reversed (failed auction)'>", "<up to 4 total>"]
}`
    try {
      const m1 = await client.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 700,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: normalizedMediaType!, data: imageBase64! } },
            { type: 'text', text: chartReadPrompt },
          ],
        }],
      })
      const t1 = m1.content[0].type === 'text' ? m1.content[0].text : ''
      const j1 = t1.match(/\{[\s\S]*\}/)
      if (j1) chartRead = JSON.parse(j1[0])
    } catch (e) {
      console.warn('[analyze-prep] blind chart-read pass failed, continuing without it:', e)
    }
  }

  // ── PASS 2 instructions: inject the blind read as a PRE-COMPUTED baseline ──
  // The evaluation pass must NOT regenerate the chart read (that would re-expose
  // it to the trader's notes and reintroduce the bias we just engineered out).
  // It only cross-references the already-formed read against the notes.
  const chartInstructions = hasImage ? `
═══════════════════════════════════════════════
INDEPENDENT CHART READ — completed in a SEPARATE pass with NO access to the trader's notes
═══════════════════════════════════════════════
${chartRead?.chart_thesis ? `Chart thesis: ${chartRead.chart_thesis}` : '(chart read unavailable this run)'}
${(chartRead?.chart_structure_notes ?? []).map(n => `- ${n}`).join('\n')}

Treat the above as your objective baseline read of the chart. Do NOT regenerate or restate it. Cross-reference it against the trader's notes below and state in "summary" whether your independent read ALIGNS or CONFLICTS with the trader's bias. Never present the trader's own view back as if it were the chart's.` : ''

  const traderProfile = await getTraderProfile()
  const prompt = profileContextBlock(traderProfile) + `You are an objective trading coach reviewing a trader's daily prep${hasImage ? ' and chart screenshot' : ''}.

══ TRADER'S FRAMEWORK (read this before judging anything) ══

The trader uses an MGI-based approach (Market Generated Information). Setups use structural levels (PDH, PDL, IBH, IBL, ONH, ONL, HTF supply/demand). Entry triggers are order-flow based in real time — do NOT penalize absent entry prices.

**Price-level shorthand:** In this trader's notes, a short number (optionally followed by "s") is a PRICE LEVEL, not a timeframe. "720s" / "720" = the 29720 price area; "800s" = 29800; "50s" = 29750, etc. The leading "29" (or "30", etc.) is dropped for brevity — standard NQ/ES handle shorthand that every futures trader uses. NEVER interpret "Ns" in an invalidation or target as "N seconds." The handle is UNAMBIGUOUS — read it CONFIDENTLY as the full price and move on. Do NOT append "(29720?)" with a question mark, do NOT say a level "reads ambiguously" because of the shorthand, do NOT ask the trader to "confirm/clarify which structural zone the handle references," and do NOT dock the score for using shorthand. The trader is an experienced operator, not a novice to educate. Relatedly, when the trader names a specific level as an invalidation or target, that IS a complete structural reference — do not ask them to confirm whether it's "support vs resistance" or "which zone it is"; the structural role is their read, made live.

**Multiple targets are exit alternatives, not competing prices.** When a plan lists "2R and VWAP/POC" as targets, these are two independent exit criteria — e.g. take partial at 2R, trail remainder to VWAP/POC — not two levels that must be at the same price. For a LONG plan, targets are ABOVE the entry; for a SHORT plan, targets are BELOW. Do NOT flag "2R might not reach VWAP/POC" — if VWAP/POC is listed as a target on a long, it is by definition above the entry. Never confuse the target level with the entry location.

CRITICAL framing rules — get these wrong and your analysis will be unhelpful:

1. **IBH/IBL are levels, not directions.** When the trader plans LONG from demand at the lows (e.g. ONL bounce, 5m demand zone), IBH is the upside TARGET, not a "lid" or "resistance preventing the trade from working." A clean R/R to IBH is the WHOLE POINT of the setup. Only call IBH a problem when the trader plans to go LONG from JUST BELOW IBH on a continuation — that's the scenario where IBH overhead is structurally meaningful resistance. Do not flag "IBH overhead" when longs are from a level well below it.

2. **Chop is an environment, not a verdict.** "L3 CHOP" or a low-clarity read does NOT contradict laying out trade plans. Plans are CONDITIONAL — they trigger when the level reacts. In chop the trader knows to size down, wait for confluence, scratch faster. Plans laid out + chop environment = mature prep, not contradiction. Only flag chop when the plans show NO awareness of it (e.g. full size, no scaling, no invalidation).

3. **"Scary factors" field on a plan is a STRENGTH.** It's the trader proactively naming the failure scenario before they take the trade — exactly the discipline you should reward. Don't list "scary factor X is a real risk" as a flag — the trader already flagged it themselves.

   **Critically: scary factors are FORWARD-LOOKING / HYPOTHETICAL by definition.** Do NOT compare them against current chart state and conclude "the chart contradicts your scary factor." Saying "Plan 2's scary factor 'EMAs starting to flatten' is contradicted because the EMA is currently sloped" misses the point entirely — the trader is naming a future condition that would *invalidate* the trade, not making a claim about right-now state. The whole purpose of the scary_factors field is to anticipate what the trader needs to watch for as the session unfolds.

   Specific bad pattern to avoid: "scary factor X is partially/fully contradicted by the chart" — never write that. If a scary factor IS valid forward-looking risk language ("EMAs flatten," "if buyers absorb," "if HTF reverses"), score the plan UP for naming it, not down.

   A scary factor only deserves a flag if it's (a) literally non-sequitur (unrelated to the trade), or (b) so vague it's not actionable ("if something bad happens"). Otherwise: silence, or call it out in strengths.

4. **Emotional self-reporting + reduced-size commitment = strength, not flag.** When the trader writes "feeling tilted from yesterday, will trade smaller," that's the self-awareness most traders lack. Don't flag it as "easy to break the rule under pressure" — that's a truism that applies to every trader. Only flag if the mood note describes an emotion AND the plans show no behavioural adjustment.

5. **Day-type context shapes everything.** If GBX is ≥ 80% of ADR with reversal structure, IBH-as-resistance is the WRONG frame — the day's character is rotation/reversal, not trend continuation. Match your analysis to what's actually unfolding.

   **Bias commitment is a strength; counter-bias plans are NOT required.** If the trader's bias is bullish, the prep should have bullish plans. Identifying HTF resistance above as a scary factor is RISK AWARENESS, not an obligation to draft a fade plan. Counter-bias trades need their own setup criteria (failed auction, absorption, multi-TF rejection) that take real-time orderflow to confirm — the trader is not obligated to fabricate a counter-bias plan from structure alone. Forcing a counter-bias plan is exactly the trade-finding-from-thin-air behavior that v1.3 P7 (Setup Valid) is designed to prevent: the trader would be writing a plan with no orderflow read, no aligned market state, just "resistance is above so I should be ready to fade."

   Specific bad pattern to avoid: "no short/fade plan despite identifying HTF resistance" on a bullish-biased prep. NEVER write that. The scary factor IS the discipline — the trader has acknowledged the level and the correct response in prep is *caution / scale-out / scratch criteria*, not a counter-bias trade plan. Same in reverse: don't flag "no long plan despite identifying HTF support" on a bearish-biased prep.

   DO flag (genuine coverage gaps):
   - Bias is marked "neutral" but plans cover only one direction.
   - A documented scary factor with NO acknowledgment of how to react to it ("scary: HTF res above, no notes on caution near it").
   - Plans that ignore an immediately-relevant opposite level (e.g. a long plan that targets above a major resistance without addressing it).

   DO NOT flag:
   - "No short plan for HTF resistance" on a bullish-biased prep.
   - "No long plan for HTF support" on a bearish-biased prep.
   - "Only one direction is covered" — that's the bias commitment paying off, not a gap.

6. **Structural invalidations are VALID AS-IS — do NOT flag them for not being ATR-anchored.** The trader sets invalidation at the level where the idea is wrong: a demand zone break, a key structural level reclaim, a failed auction at a specific price. These are correct by definition. ATR is one framework for sizing stops; structural levels are another. NEVER flag "this stop is not X ATR from current price" as a watch-out unless the invalidation is genuinely absent or literally says "exit on weakness." The location of the invalidation is the trader's edge, not yours to second-guess via a volatility multiple.

7. **Calibrate VP and session-level references to the submission time (provided above as "Analysis submitted: HH:MM PT — [context]").**
   - **POST-IB**: The trader has a live chart with ≥1h of RTH data and the IB fully formed. Any reference to session VP structure (VAL, VAH, POC, distribution shape, "price approaching VAL") is the trader reading their screen in real time. Do NOT question whether they know current price vs. a session level — they can see their chart. Flag only genuinely vague VP notes ("volume is bullish" with no anchor).
   - **IB FORMING (6:30–7:30 AM)**: Session VP is thin. The trader can see live price and partial profile but VAL/VAH are not settled. Volume references are early-read estimates, not settled structure — treat them as forward-looking conditional notes, not factual claims about the profile.
   - **PRE-MARKET (before 6:30 AM)**: No RTH VP data exists. All VP references are prior-session or overnight. Do NOT flag the trader for not knowing intraday session levels that cannot exist yet.

8. **Dynamic levels (EMA, VWAP) and ratio targets (R-multiples) are PROPERTIES OF THE TRIGGER MOMENT, not prep-time prices.** The trader uses order-flow entries: the entry price is whatever the tape gives them when the level reacts, not a number they write down at prep time.
   - **EMA / VWAP invalidations are correct AS-IS.** "5m close above the 20 EMA" is structurally complete — the EMA's job is to be dynamic. Asking "what price is the EMA at?" defeats the purpose. Do NOT flag this. The same applies to VWAP, prior-day VWAP, anchored VWAPs, any moving session-level line.
   - **"2R" or "1R to X" is fully specified.** R is defined by the entry-to-stop distance, which is set at the trigger moment. Asking for "the 2R price level" during prep is a category error — it cannot exist before entry. Do NOT flag this.
   - Static price targets (IBH at 30134, PWL at 29769) are fine to praise for precision, but their absence is NOT a flag when a ratio or dynamic level was given instead.
   - The ONLY time to flag a target/invalidation is when it is genuinely vague — e.g. "exit on weakness", "stop if it goes wrong", "target the highs" without specifying which highs. Those are real omissions. Ratios and dynamic levels are not.

9. **A blank "IB Break Timing" field during IB FORMING context is expected — do NOT flag it.** The IB is still building; the trader cannot know the break direction or timing yet. The field label will say "Not yet — IB still forming" in that case. Even post-IB, a blank ib_behaviour is at most a minor note, never a watch-out — the trader's bias and plans already capture their directional read on the IB.

10. **Price moving away from a zone CONFIRMS the zone's validity — do NOT use it as a flag.** If the blind chart read shows price has moved significantly away from a supply or demand zone the trader identified in their prep, that is chart confirmation the level was real. Do NOT flag "price is currently in this zone creating mid-range entry risk" when the evidence is that price already rejected from the zone. A plan where the chart subsequently validated the zone should be scored UP, not flagged. Only flag zone-location risk when price is genuinely still sitting inside the zone at time of analysis with no directional resolution.

11. **The HTF MGI field is an OBJECTIVE list of price's position in the level stack — not a contradiction to resolve.** Entries like "IBH above, ONH below" mean price is currently ABOVE IBH and BELOW ONH — a factual snapshot of where price sits among the levels. Price being above one level and below another at the same time is completely normal (it sits between them). This is exactly how MGI is recorded. NEVER flag it as "hard to read state vs level," "lists two levels simultaneously," or ask for "directional clarification" / "are these support-reclaimed or resistance-to-respect" — that interpretation is the trader's real-time job, not a prep defect. The raw list format is fine.

12. **Trade plans are CONDITIONAL RE-ENTRY plans by default — a level having ALREADY fired does NOT orphan the plan.** "Long from demand at X" means IF price RETURNS to that zone (a pullback / re-entry). The fact that price already lifted off the level hours ago and is now elsewhere does NOT make the plan stale — waiting for a revisit is the whole point of a level-based plan. NEVER flag "the level already fired, Plan N may be orphaned," "price is now far from the zone," or "needs a retest note before this can trigger" — re-entry on a pullback is the inherent, default reading of any level plan; the trader does not need to spell out "if we revisit." Only flag when the named level has been structurally INVALIDATED (e.g. a demand zone decisively broken to the downside), not merely when price has travelled away from it.

13. **VWAP / EMA slope reads describe the FULL anchored line (overnight + RTH), not just the recent visible leg.** A session-anchored VWAP blends the GBX/overnight portion with the RTH portion. A "flat" or "neutral" VWAP read can be exactly correct even when the recent RTH leg is rising — an overnight down-slope plus an RTH recovery nets to flat. The blind chart read only sees a zoomed-in recent window; the trader's slope read accounts for the whole anchor. NEVER flag "you described VWAP as flat but the chart shows it rising" based on the recent leg alone — that is comparing two different spans. Only flag a slope read if it is clearly wrong across the entire visible VWAP/EMA line.

14. **"price above X" / "price below X" always means PRICE relative to the level X.** In the HTF MGI block, "price above EMA" = price is trading ABOVE the EMA (bullish vs the EMA); "price below ONH" = price is under ONH. The LEVEL is never the subject — never read "EMA above" as "the EMA is above price." These reads are objective and internally consistent; do NOT manufacture a contradiction between the HTF MGI list and the dedicated VWAP/EMA lines (they describe the SAME state). Never tell the trader to "clarify which is accurate" — there is no conflict.

15. **A "balanced / D-shape / neutral" volume-profile read stays valid until a NEW distribution is ACCEPTED — probing the high is not acceptance.** Price building or poking above the prior value area / IBH does NOT mean the profile is "no longer balanced" or that the shape call is stale. Until time + volume actually build a new value area, the balanced read holds, and a push above the range that gets rejected back into value is a FAILED breakout the balanced thesis correctly anticipates (the breakout buyers end up offside). NEVER flag "you called it balanced but price is now building above IBH, the shape should reflect current state" — an in-progress probe above value is not a confirmed new distribution. Only flag the shape read if a new value area has clearly, durably established.

16. **Targets/invalidation are judged against the PLAN'S ENTRY ZONE, never the current price. (Recurring error — read carefully.)** When a plan enters LONG from HTF demand below current price (PWL / PDL / ONL / 5m demand), the ENTRY is BELOW where price is now — so VWAP / POC / IBH sitting near or below the *live* price are still ABOVE the *entry* and are valid UPSIDE targets. NEVER write "VWAP is below current price, so it'd be a short target not a long target" or "this creates directional ambiguity" — current price is irrelevant; the trade fills at the demand zone and targets are measured from there. Mirror for shorts from supply above current price. Before calling any target "below/above the entry," locate the entry at its stated zone, not at the live price.

   **This keeps reappearing in softer disguises — ALL of the following are the SAME banned error and must NEVER be written about a VWAP/POC/level target on a level-based plan:**
   - "VWAP is currently below price" — irrelevant; the entry isn't at current price.
   - "VWAP is below the entry zone" — FALSE for a long from demand: VWAP between the demand zone and current price sits ABOVE the entry. Do not invert this.
   - "confirm which VWAP anchor you mean (session / prior-day / overnight)" — VWAP is a standard dynamic target (see rule 8); do not demand the anchor be specified.
   - "R may compress depending on where price is" / "VWAP as an early waypoint" hedging about how much R the target yields — that's the trader's real-time scale-out call, not a prep defect.
   - "VWAP is an early scale target rather than a final destination" / "be explicit whether VWAP is a partial-out level or a trail-and-hold signal" / "so you don't over-exit a clean move to IBH" — editorializing HOW or WHEN to exit the target is the trader's live scale-management decision, NOT a prep concern. Banned.
   **MECHANICAL FACT you must apply (this is the recurring blind spot):** on a demand-zone RE-TEST long, price has to fall back DOWN THROUGH VWAP to reach the entry zone — so the moment the entry fills, VWAP is NECESSARILY OVERHEAD (above the entry). It is therefore always a legitimate upside target, by construction. There is nothing to "clarify," "be explicit about in real time," or guard against over-exiting. (Mirror for a supply-zone short: price rises through VWAP to reach the entry, so VWAP sits below the entry — a valid downside target.)
   A VWAP/POC/dynamic target on a level-based trade is COMPLETE and VALID. Do not write ANY note about it — not its position vs current price, not its anchor, not its R yield, not partial-vs-trail, not early-vs-final, not "be explicit in real time." If your only point about a target is how/when to exit it, omit it entirely. The single allowed mention is praising precision in strengths.

17. **Order-flow CONFIRMATION for a conditional/reversal entry CANNOT be pre-named — it is a real-time tape read, and demanding it is the single most common unhelpful flag.** A plan like "short ONH on a failed auction" or "long demand on a reclaim" is COMPLETE when it states LEVEL + DIRECTION + the *type* of trigger (failure, reclaim, absorption, deviation, etc.). The trader CANNOT specify in advance the exact order-flow signal that will confirm it — which specific signals appear depends on what the tape does WHEN price gets there, and that hasn't happened yet. Reading confirmation live against known criteria IS the order-flow method. NEVER write "the prep doesn't name what order-flow confirms the entry," "trigger condition underspecified," "name the minimum confluence stack (absorption + 5m supply + delta divergence) before committing," or any variant demanding a pre-written signal list. The reversal hasn't occurred, so its order flow can't be enumerated. (You MAY, once and softly, remind the trader of their own documented confluence discipline — but never as a prep defect, never as a score-capping gap, and never demanding the signals be listed in advance.)

18. **Conditional plans at DIFFERENT levels do not compete in real time — do not demand a "trigger hierarchy" between them.** A long from demand at the lows and a short from supply at ONH fire at different prices; price cannot be at both at once, so there is no "which fires first" decision-load to resolve. NEVER flag "two opposite-direction plans create decision-load / no stated trigger hierarchy / unclear which plan fires" when the plans trigger at separate levels — covering both directions on a neutral bias is correct prep (see rule 5), not a risk to mitigate with a priority ranking. Only a genuine same-level, same-time, opposite-direction conflict warrants a note.

19. **HTF MGI is SELECTIVE by design — the trader tags only the levels in play, not the whole stack.** The MGI grid has a "Reactive?" flag; the trader anchors price against the levels that are NEAR price or that price is reacting to, and leaves distant / inert levels untagged on purpose. NEVER flag "ONH / IBH / VWAP / RTH Open are left unanchored in the level stack" or "explicitly place price relative to each key level." Demanding price be located against EVERY level is over-specification — an untagged level is the trader saying "not relevant right now." Only flag a MISSING level if it is immediately in play (price is AT it or a plan targets/invalidates on it) and yet went untagged.

20. **A named volume-profile SHAPE is a complete shape call — do not ask for one that's already there.** If the trader names the structure — "double distribution", "bimodal", "P-shape", "b-shape", "balanced / D", "single print", "trend / elongated" — that IS the shape call. NEVER write "doesn't commit to a shape call" or "name which distribution holds POC / where the LVN sits." "Double distribution" already conveys two value areas with an LVN between them; the exact POC/LVN prices are real-time reads off the developing profile, not prep-time numbers. Only flag a VP note that gives NO shape and NO structure at all (e.g. "volume looks fine").

${chartInstructions}

Analysis submitted: ${ptTimeLabel} — ${sessionCtx}

Market Context:
- Rvol: ${marketContext.rvol ?? 'N/A'}
- IB Size: ${marketContext.ib_size ?? 'N/A'} (vs 10d avg ratio: ${marketContext.ib_vs_10d_avg ?? 'N/A'})
- ADR: ${marketContext.adr ?? 'N/A'} | ATR (1m): ${marketContext.atr_1m ?? 'N/A'}
- PDH/PDL: ${marketContext.pdh ?? 'N/A'} / ${marketContext.pdl ?? 'N/A'}
- IBH/IBL: ${marketContext.ibh ?? 'N/A'} / ${marketContext.ibl ?? 'N/A'}
- ONH/ONL: ${marketContext.onh ?? 'N/A'} / ${marketContext.onl ?? 'N/A'}

Trader's Prep Notes:
- IB Break Timing: ${prepNotes.ib_behaviour ?? (ptMinutesNow < 7 * 60 + 30 ? 'Not yet — IB still forming at time of analysis' : 'Not provided')}
- Volume Profile: ${prepNotes.volume_profile_shape ?? 'Not provided'} — ${prepNotes.volume_profile_notes ?? ''}
- Bias: ${prepNotes.bias ?? 'Not provided'} — ${prepNotes.bias_notes ?? ''}
- HTF MGI (price's position relative to each level — "price above X" = price is trading ABOVE level X): ${(() => {
    const entries = Object.entries(prepNotes.htf_mgi ?? {}).filter(([k]) => k !== 'VWAP' && k !== 'EMA')
    return entries.length > 0 ? entries.map(([k, v]) => `price ${v} ${k}`).join(', ') : 'None tagged'
  })()}
- VWAP: ${prepNotes.htf_mgi?.['VWAP'] ? `price ${prepNotes.htf_mgi['VWAP']} VWAP` : 'not tagged'}${prepNotes.vwap_slope ? `, ${prepNotes.vwap_slope}` : ''}
- EMA: ${prepNotes.htf_mgi?.['EMA'] ? `price ${prepNotes.htf_mgi['EMA']} EMA` : 'not tagged'}${prepNotes.ema_slope ? `, ${prepNotes.ema_slope}` : ''}
- Mood: ${prepNotes.mood ?? 'Not provided'}
- Market Clarity: ${prepNotes.market_clarity ?? 'Not provided'}

Trade Plans:
${plansBlock}

${planIdsBlock}

Respond with ONLY valid JSON in this exact structure (no markdown, no code fences).
${hasImage ? 'Do NOT include chart_thesis or chart_structure_notes — those are supplied by the separate blind-read pass above and must not be regenerated here.\n' : ''}{
  "summary": "<2-3 sentences on overall prep quality${hasImage ? '; state whether your independent chart read above ALIGNS or CONFLICTS with the trader bias' : ''}>",
  "flags": ["<specific concern 1>", "<up to 5 total>"],
  "strengths": ["<what was done well>", "<up to 3 total>"],
  "score": <integer 1-10>,
  "plan_assessments": [{"plan_id": "<exact id>", "ai_quality": <1-5>, "note": "<1-2 sentences, be direct if you disagree with trader rating>"}],
  "day_stance": "<go|caution|avoid>",
  "day_read": "<ONE plain-language sentence, ~15-20 words>"
}

For plan_assessments: rate on structural clarity, invalidation precision, target reasonableness, risk awareness. Never penalize missing entry price.

══ VIEWER READ (day_stance + day_read) — for a public Discord card ══

These describe the DAY'S TRADEABILITY for a general audience — NOT the prep quality (that's "score"). Base them on the market conditions and your independent chart read: volatility (RVOL, IB size vs avg, ATR/ADR), whether structure is trending vs rotating vs choppy, and how clean the opportunity looks. A great prep on a dead choppy day is still "avoid"; a thin prep on a clean trend day is still "go".
- day_stance: "go" = clean, tradeable, a clear opportunity is setting up. "caution" = mixed/selective/rotational — be picky. "avoid" = choppy, low-energy, or no clear edge — sit on hands.
- day_read: ONE sentence, ~15-20 words, PLAIN LANGUAGE a non-trader understands. No jargon, no abbreviations (no RVOL/IB/ADR/VWAP), no price levels. Say what the market is doing and the stance. Example: "Quiet, choppy open with small ranges — no clear trend yet, so wait for price to pick a side."

══ SCORING RUBRIC FOR "score" ══

This is the overall PREP QUALITY score, not a market-conditions score. Don't penalize the trader for unclear market structure — that's the market's job, not the prep's. Use these anchors:

- **9-10**: All plans have specific invalidation + targets + named scary factors. Bias is justified by structural context (not gut). Mood + clarity addressed honestly. Multiple plans covering both directions when warranted. HTF MGI tagged. Volume profile shape called out. **An order-flow-triggered entry counts as fully "specific" when it names the level + direction + trigger TYPE — it does NOT need to pre-name the confirming tape signal (that's a real-time read). Do not withhold a 9-10 because a reversal/confirmation signal wasn't enumerated in advance.**
- **7-8**: Plans have invalidation + targets. Scary factors named on at least one plan. Bias reasoning present. Mood mentioned. Some structural depth but maybe one plan thinner than another.
- **5-6**: Plans exist but some lack invalidation OR targets OR scary factors. Bias stated without much reasoning. Or thorough plans but no mood/clarity self-check.
- **3-4**: Plans are vague — "watch IBH" without specifics. No invalidation. Bias asserted with no structural anchor.
- **1-2**: Effectively no prep — directional bias with no plan, no levels, no risk awareness.

**CALIBRATION — use the FULL range; do NOT cluster every prep at 7-8.** 7-8 is NOT a default landing zone. Discriminate honestly:
- If the prep meets the 9-10 anchor — every plan has invalidation + a target + a named scary factor, bias is structurally reasoned, mood + clarity addressed, HTF MGI tagged, VP shape named — it IS a 9 or 10. Do NOT shave it to 8 over a stylistic nitpick or a "could be slightly more specific" note. The over-precise observations banned in rules 6-20 are NOT grounds to withhold a 9 — if those are your only reservations, award the 9-10.
- A genuinely thin/sloppy prep (missing invalidation, targets, scary factors; gut-only bias; no mood check) belongs at 5-6 or below. Don't inflate it to 7.
- Hard test before you settle on 7 or 8: name the SUBSTANTIVE gap (a missing invalidation, target, scary factor, mood/clarity check, or bias reasoning). If you can name one, dock to 7-8 and cite it. If you CANNOT — if every box is checked and your only notes are "could tighten" nitpicks — it is a 9-10, full stop. A 7-8 must be earned by a real, nameable omission, never by reflex.

DO NOT downgrade for:
- Un-anchored HTF MGI levels that aren't reactive / near price (rule 19) — the trader tags only what's in play
- A volume-profile shape that's already named, e.g. "double distribution" (rule 20) — that IS the shape call
- Market being choppy / uncertain (that's environment)
- The trader being long below IBH (that's a normal R/R to a level)
- Self-reported tilt + reduced-size commitment (that's self-awareness)
- Named scary factors (those are the trader catching their own risk)
- Plans being "lower probability" — probability is a market call, not a prep grade
- Dynamic-level invalidations like "5m close above the 20 EMA" or "VWAP reclaim" (the level moving is the feature, not a bug)
- Ratio targets like "2R" or "1R to IBL" (R is defined by the trigger-moment entry-to-stop, not by prep)
- Missing entry prices (entries are order-flow-triggered, not predetermined)
- An order-flow entry that names level + direction + trigger TYPE but not the exact confirming signal (that signal is a real-time tape read — the setup is COMPLETE for scoring; do not treat it as "underspecified")
- Covering both directions with conditional plans at DIFFERENT levels (correct neutral-bias prep — not "decision-load" to penalize)

DO downgrade for:
- Missing invalidation (no exit condition at all)
- Missing targets (no exit plan at all)
- Genuinely vague invalidation/targets ("exit on weakness", "target the highs" with no anchor)
- No mood/clarity self-check
- Bias asserted without structural reasoning
- Plans that contradict each other without acknowledgment

Cite the rubric tier in "summary" so the trader can sanity-check the score.`

  const userContent: Anthropic.MessageParam['content'] = hasImage
    ? [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: normalizedMediaType!,
            data: imageBase64!,
          },
        },
        { type: 'text', text: prompt },
      ]
    : prompt

  const message = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 2000,
    messages: [{ role: 'user', content: userContent }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : ''

  // chartRead (from the blind Pass 1) is spread AFTER the Pass-2 analysis so the
  // independent read always wins — even if Pass 2 ignored instructions and
  // emitted its own chart_thesis, the notes-contaminated version is overwritten.
  const chartReadFields = chartRead
    ? { chart_thesis: chartRead.chart_thesis, chart_structure_notes: chartRead.chart_structure_notes }
    : {}
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    const analysis = jsonMatch
      ? JSON.parse(jsonMatch[0])
      : { summary: text, flags: [], strengths: [], score: 0, plan_assessments: [] }
    return NextResponse.json({ ...analysis, ...chartReadFields, analyzed_at: new Date().toISOString() })
  } catch {
    return NextResponse.json({ summary: text, flags: [], strengths: [], score: 0, plan_assessments: [], ...chartReadFields, analyzed_at: new Date().toISOString() })
  }
}
