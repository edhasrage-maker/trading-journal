# TRADING RULESET — v1.3
**Effective 2026-06-07 · NQ/MNQ · RTH 06:30–13:00 PST**
**Amended 2026-06-08 (3 times same day):**
  1. Verdict threshold relaxed from "all 7 pass" → "5 of 7 pass" — see §VERDICT (now superseded by amendment 3).
  2. Execution gains Prep adherence sub-metric — see §EXECUTION QUALITY (now superseded by amendment 3).
  3. **Major restructure:** P4 (Stop valid) and P7 (Setup valid) moved out of Process into a new Execution sub-metric "Execution Parameters" (35% weight, 9-criterion checklist). Process drops to 5 hard safety-rail rules with renumbered IDs; verdict threshold becomes "4 of 5 pass." Duration-to-thesis sub-metric removed; weights rebalanced across the remaining 5 Execution sub-metrics. See §VERDICT and §EXECUTION QUALITY.

## INSTRUCTION TO THE JOURNAL ASSISTANT
Replace in full any prior ruleset, sizing model, or scoring logic. Adopt the below verbatim. Do not infer, soften, merge, or average rules. Evaluate each rule only against the data field named.

**Two layers, never combined:**
- **Process** = per-rule, scored independently. Each rule is binary (pass / fail / incomplete). The session-level verdict is a threshold over the per-rule results — see §VERDICT.
- **Execution** = continuous, diagnostic, weekly, computed only on compliant sessions. Never touches the verdict, never blends with process.

## WHAT IS TRACKED LIVE vs AFTER
This is a **post-session scoring rubric.** The bot grades it after the session, not you at the desk. The only things you hold in your head live: **don't exceed size, don't size up after a loss, respect the 90s cooldown.** Everything else is audited at 9:31, not enforced by willpower at 8:31.

## DEFINITIONS
- **Session** = trade open date. **Sequence** = trades sorted by open time; first = T1.
- **Loss** = Net P&L < 0. Magnitude never matters.
- **Post-loss state** = the immediately prior same-session trade had Net P&L < 0.
- **Cooldown gap** = next open time − prior close time, seconds.
- **Qualifying S&D** = setup is supply/demand AND orderflow contains **≥2 of 3 strong signals: delta flip, absorption (= delta bubble failure), delta fade.** This is the only gate to 10 MNQ.
- **Valid setup** = an orderflow read is logged AND trade side aligns with a real market state (accepted break, failed auction, trend pullback, balance-edge response, HTF zone response, LVN rejection). A touch of a level alone is not valid context.

## SIZING — two independent dimensions
**Contract size (fixed lots):**
- Base = **5 MNQ**, every trade.
- Only increase = **10 MNQ**, only on Qualifying S&D. Nothing else exceeds 5.
- Two paths to 10: **(A)** full 10 on entry, or **(B)** 5 then add 5.
- **Post-loss: hard 5 MNQ cap.** No path reaches 10 after any loss.

**Path B add (kept):** add the second 5 only if — original is Qualifying S&D, add is driven by *new confirming information* (fresh delta flip, absorption holding, higher-low/lower-high, reclaim/rejection), not by price moving against you. Any add that averages a losing position, follows a loss, or chases extension = breach.

**Stop distance (ATR points, independent of size):**
- Standard 1.0 ATR; band **0.5–1.5 ATR** (ATR-10 Wilder, 1m, at entry).
- < 0.5 ATR only with logged `tight_stop_reason`. > 1.5 ATR = breach.
- **10-MNQ trades:** stop ≤ 1.25 ATR AND total campaign risk ≤ $200 (= 40% of $500 DLL). At $20/pt, $200 caps combined stop at 10 points; the add does not get a fresh budget.

## PROCESS RULES (binary, hard safety rails only)
Missing-data handling differs by tier (see §Unscorable). All 5 rules are mechanical / quantitative — no judgment involved. Stop validity (was P4) and setup validity (was P7) moved into Execution Parameters per the 2026-06-08 (amendment 3) restructure since they're quality concerns, not safety rails.

| ID | Rule | Pass | Data field(s) | Enforce |
|----|------|------|---------------|---------|
| P1 | Daily loss limit | Session Net P&L not past −$500 | Net P&L by session | ENFORCED |
| P2 | Size within cap | ≤5 MNQ; ≤10 only on valid Qualifying S&D (Path A/B) | Quantity, Setups, Orderflow, Net P&L | SELF |
| P3 | No size-up after loss | Post-loss → ≤5 MNQ, no scale to 10 | Quantity, Net P&L, sequence | SELF |
| P4 | Cooldown | ≥90s after any loss | close time → open time | SELF until ACSIL |
| P5 | Trade cap | ≤7 trades/session | trade count by session | SELF until ACSIL |

No time-of-day gate. (Post-9:30 holds your expectancy; an early-entry rule is excluded by design.)

## VERDICT
`pass_count = count(P1..P5 where status = 'pass')`
`compliant = pass_count >= 4`

Verdict ∈ {Compliant, Breach}. All 5 rules are hard quantitative safety rails — there is no "incomplete" tier for any of them; missing data on a safety rail counts as a fail (you can't verify a session is clean if the data isn't there). P&L does not define discipline: green P&L with ≤3 passes is **Breach**, red P&L with ≥4 passes is **Compliant**.

**Why ≥4/5 and not "all 5":** preserves the spirit of the earlier 5/7 amendment — a single isolated lapse (e.g. one cooldown short of 90s) doesn't blanket-classify an otherwise disciplined session as Breach. Two simultaneous safety-rail breaches still drop you to Breach. The breach-count vector + per-rule chips on the dashboard still surface every individual failure regardless of the session verdict.

## UNSCORABLE
- **All 5 P-rules are enforcement-critical:** required data missing → **Breach.** These safety rails must be verifiable. Stop-validity and setup-validity, which previously had an "incomplete" tier (P4/P7 pre-restructure), are now scored continuously in Execution Parameters where the "incomplete" framing doesn't apply — a missing orderflow log just lowers the Exec Params sub-metric score without forcing a session-level Breach.

## EXECUTION QUALITY (weekly, compliant trades only, diagnostic)
| Metric | Source | Weight |
|--------|--------|--------|
| Execution Parameters | 9-criterion checklist (see below) | 35% |
| MFE capture / exit efficiency | exit efficiency, position MFE, best exit | 20% |
| Prep adherence | prep notes (bias, trade plans, expected day character) vs taken trades | 20% |
| MAE / heat control | position MAE, price MAE | 15% |
| Realized vs planned RR | realized RR vs planned reward ratio | 10% |
Composite is diagnostic only. Never combined with process.

**Amended 2026-06-08 (amendment 3):** Duration-to-thesis sub-metric DROPPED entirely — too coarse a signal that wasn't producing actionable feedback. New "Execution Parameters" sub-metric absorbs what used to be P4 (stop validity) and P7 (setup validity) plus 7 additional quality criteria, weighted 35%. Other weights rebalanced.

### Execution Parameters — 9-criterion checklist
Each criterion is binary per trade (pass = 1, fail = 0, N/A = skipped). Per-trade score = passes ÷ (passes + fails). Sub-metric score = mean across compliant trades.

1. **Setup in playbook.** The setup tag on the trade exists in the trader's curated `setups` tag library. Discretionary one-off setups not in the library fail.
2. **Stop in 0.5–1.5 ATR band** (formerly P4). Stop ÷ ATR-10 mult between 0.5 and 1.5 inclusive. Sub-0.5 needs `tight_stop_reason` logged. 10-MNQ trades: ≤1.25 ATR AND total campaign risk ≤$200.
3. **TP1 ≥ 2R, or reason logged.** Planned TP1 is at least 2× the planned risk distance. If TP1 < 2R, the EOD recap must explain why (one-off structural target, day-character, etc.). Missing reason = fail.
4. **Clear area of interest noted.** The trade is anchored to a specific structural level (PDH/PDL, IBH/IBL, ONH/ONL, HTF zone, LVN, demand/supply cluster). "Random mid-range entry" or "felt right" = fail.
5. **2/3 orderflow reads = A+.** Trade has at least 2 of 3 strong orderflow signals: delta flip, absorption (delta bubble failure), delta fade. Trades with 0 or 1 OF signals fail this criterion.
6. **Entry was Break of Cluster or Break of Bubble.** The trigger was a structural break (price breaking through a cluster of orders or breaking a bubble), NOT a discretionary price-based entry ("looked like a good price"). Discretionary entries fail.
7. **Management based on chart, not emotion.** Exits driven by clear technical / structural triggers pass. Exit examples:
   • PASS: "Exited long because a HUGE buyer came in above me but did NOT get rewarded" — that's a structural read that the level isn't holding.
   • FAIL: "Exited early because I was scared to give back profits before my target" — PnL-anchored emotional decision, not structural.
8. **No mistakes tagged.** `tags_json.mistakes` is empty on the trade. Any mistake tag = fail.
9. **Emotion: Stable.** `tags_json.emotions` includes Stable (pass). Compromised = fail (not ideal, but trade-execution counts). MAXRAGE = fail AND a meta-signal that the trader shouldn't have been trading at all.

## TREND METRICS
- Compliant-session rate, rolling 10 and 20 sessions.
- Per-rule breach count; days-between-breach per rule.
- Breach **count vector** (never averaged), e.g. `P2:1 P3:0 P4:2 P5:1 P6:0 P7:3`.
- 10-MNQ usage count and 10-MNQ breach count (tracks whether the size exception is being abused).
- Data-completeness % (from P7 Incompletes).

## REMOVED FROM SCORING (ritual/qualitative, not process rules)
Pre-trade read-aloud, post-loss screen-off, observation-only journaling, emotion notes, bank-the-day, hard time stop, T1-red two-trade cap, **post-9am entry gate.**

## STANDING FLAGS
- ACSIL kill-switch **not compiled.** P5/P6 are SELF-POLICED until confirmed live; only P1 is externally enforced.
- Contract size is fixed by rule (5 / 10), not ATR-derived. Stop floats with ATR, so dollar risk rises with volatility — bounded only by P1, P4, the $200 campaign cap, and the post-loss size cap. The 10-MNQ S&D on a wide-ATR day is your largest single-trade risk; on days where ATR > 8 points the $200 cap makes a full 10-MNQ entry mathematically impossible. That is intended.
