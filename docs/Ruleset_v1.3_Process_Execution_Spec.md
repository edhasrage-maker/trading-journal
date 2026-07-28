# TRADING RULESET — v1.3
**Effective 2026-06-07 · NQ/MNQ + ES/MES · RTH 06:30–13:00 PST**
**Amendment 8 (2026-07-28): size caps are PER INSTRUMENT — see §Size.**
**Amended 2026-06-08 (3 times same day):**
  1. Verdict threshold relaxed from "all 7 pass" → "5 of 7 pass" — see §VERDICT (now superseded by amendment 3).
  2. Execution gains Prep adherence sub-metric — see §EXECUTION QUALITY (now superseded by amendment 3).
  3. **Major restructure:** P4 (Stop valid) and P7 (Setup valid) moved out of Process into a new Execution sub-metric "Execution Parameters" (35% weight, 9-criterion checklist). Process drops to 5 hard safety-rail rules with renumbered IDs; verdict threshold becomes "4 of 5 pass." Duration-to-thesis sub-metric removed; weights rebalanced across the remaining 5 Execution sub-metrics. See §VERDICT and §EXECUTION QUALITY.

**Amended 2026-06-20 (amendment 4):**
  4. **MAE / heat control removed from the Execution composite.** Getting stopped — especially when price runs past the stop — is correct execution validating an invalidated idea; scoring it as "heat → 0" penalizes a good decision. The four remaining Execution sub-metrics renormalize: Execution Parameters 41%, MFE capture 24%, Prep adherence 24%, Realized-vs-planned RR (Profit Factor) 11%. MAE/heat survives elsewhere only as a descriptive, **non-graded** entry-timing stat in analytics. See §EXECUTION QUALITY.

**Amended 2026-07-12 (amendment 5 — "One TapeScore"):**
  5. **A single 0–100 headline score per session, derived (never AI-scored) from the three existing layers.** Process and Execution remain separately computed exactly as specified below — nothing in how they are graded changes. The TapeScore is a presentation-layer blend computed deterministically in application code (`src/lib/tapescore.ts`), so it applies retroactively to every historical row without re-analysis. See §ONE TAPESCORE. The "never combined" clause is amended to: never combined *for grading*; the headline blend always exposes its components ("Rules kept n/5", "Execution", "Prep") one click away. The word "Compliance" is retired from all user-facing copy; the session verdict surfaces as "Rules kept n/5".

## INSTRUCTION TO THE JOURNAL ASSISTANT
Replace in full any prior ruleset, sizing model, or scoring logic. Adopt the below verbatim. Do not infer, soften, merge, or average rules. Evaluate each rule only against the data field named.

**Two layers, never combined:**
- **Process** = per-rule, scored independently. Each rule is binary (pass / fail). Under v1.4 there is no "incomplete" tier on any P-rule — missing data on a safety rail counts as a fail. The session-level verdict is a threshold over the per-rule results — see §VERDICT.
- **Execution** = continuous, diagnostic, weekly, computed **per-trade** across trades that individually passed every per-trade rule. A "compliant trade" = passed P2 (size cap), P3 (no size-up after loss), and P4 (cooldown ≥90s). Session-level rules P1 (daily loss) and P5 (trade cap) do NOT disqualify individual trades — they affect the Process verdict, but compliant trades within a Breach session STILL get scored for Execution. The execution composite is null only when zero trades passed all per-trade rules.

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
- Base = **5 MNQ / 10 MES**, every trade.
- Only increase = **10 MNQ / 20 MES**, only on Qualifying S&D. Nothing else exceeds base.
- **Why ES is double the lots and it is NOT an escalation:** caps normalize DOLLAR
  RISK, not lot counts. NQ carries ~2.9x the dollar volatility of ES per contract
  (1m ATR 19.4 x $2 = $38.70 vs 2.6 x $5 = $13.10, measured 2026-07-28) because NQ
  runs ~1.9x hotter than ES in percent terms on top of a 3.75x price ratio. So
  10 MES ~ $131 of ATR-risk against 5 MNQ ~ $194, and 20 MES ~ $262 against
  10 MNQ ~ $387. **Both ES caps sit BELOW their NQ equivalent.** The lot count is
  the legible form of the rule; the $200 campaign-risk cap below is the binding one,
  and it re-tightens automatically if ES volatility rises.
- Two paths to 10: **(A)** full 10 on entry, or **(B)** 5 then add 5.
- **Post-loss: hard BASE cap for that instrument (5 MNQ / 10 MES).** No path reaches the A+ tier after any loss.

**Path B add (kept):** add the second 5 only if — original is Qualifying S&D, add is driven by *new confirming information* (fresh delta flip, absorption holding, higher-low/lower-high, reclaim/rejection), not by price moving against you. Any add that averages a losing position, follows a loss, or chases extension = breach.

**Stop distance (ATR points, independent of size):**
- Standard 1.0 ATR; band **0.5–1.5 ATR** (ATR-10 Wilder, 1m, at entry).
- < 0.5 ATR only with logged `tight_stop_reason`. > 1.5 ATR = breach.
- **Sized-up (A+) trades, either instrument:** stop ≤ 1.25 ATR AND total campaign risk ≤ $200 (= 40% of $500 DLL). The add does not get a fresh budget. This gate binds BEFORE the lot cap — if $200 is not enough room for the full A+ size at the current ATR, the trade is smaller, on either instrument.

## PROCESS RULES (binary, hard safety rails only)
Missing-data handling differs by tier (see §Unscorable). All 5 rules are mechanical / quantitative — no judgment involved. Stop validity (was P4) and setup validity (was P7) moved into Execution Parameters per the 2026-06-08 (amendment 3) restructure since they're quality concerns, not safety rails.

| ID | Rule | Pass | Data field(s) | Enforce |
|----|------|------|---------------|---------|
| P1 | Daily loss limit | Session Net P&L not past −$500 | Net P&L by session | ENFORCED |
| P2 | Size within cap | Per instrument: ≤5 MNQ / ≤10 MES; ≤10 MNQ / ≤20 MES only on valid Qualifying S&D (Path A/B) | Quantity, Symbol, Setups, Orderflow, Net P&L | SELF |
| P3 | No size-up after loss | Post-loss → that instrument's base cap (≤5 MNQ / ≤10 MES), no scale to the A+ tier | Quantity, Symbol, Net P&L, sequence | SELF |
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
| Execution Parameters | 9-criterion checklist (see below) | 41% |
| MFE capture / exit efficiency | exit efficiency, position MFE, best exit | 24% |
| Prep adherence | prep notes (bias, trade plans, expected day character) vs taken trades | 24% |
| Realized vs planned RR | realized RR vs planned reward ratio (Profit Factor in $) | 11% |
Composite is diagnostic only. Never combined with process.

**Prep adherence — scope (amended 2026-06-26):** Grade adherence ONLY against what was actually planned for the RTH session. (a) EXEMPT GBX / overnight trades (`tags_json.day_type` "GBX", or entered outside 06:30–13:00 PT) — the morning prep describes the RTH session and does not apply to them; exclude them from the comparison (null the sub-metric if every trade was GBX). (b) A BLANK prep field is not an adherence miss — there's nothing to adhere to; that's a prep-quality gap the Prep score already covers. Never dock prep_adherence for prep incompleteness.

**Amended 2026-06-08 (amendment 3):** Duration-to-thesis sub-metric DROPPED entirely — too coarse a signal that wasn't producing actionable feedback. New "Execution Parameters" sub-metric absorbs what used to be P4 (stop validity) and P7 (setup validity) plus 7 additional quality criteria, weighted 35%. Other weights rebalanced.

**Amended 2026-06-20 (amendment 4):** MAE / heat control (was 15%) DROPPED from the composite — getting stopped, especially when price runs past the stop, is correct execution validating an invalidated idea, so scoring it heat→0 penalizes a good decision. The four remaining sub-metrics renormalize to 41 / 24 / 24 / 11. MAE/heat is retained in analytics only as a descriptive, non-graded entry-timing statistic; it no longer touches the Execution score.

### Execution Parameters — 9-criterion checklist
Each criterion is binary per trade (pass = 1, fail = 0, N/A = skipped). Per-trade score = passes ÷ (passes + fails). Sub-metric score = mean across compliant trades.

1. **Setup in playbook.** The setup tag on the trade exists in the trader's curated `setups` tag library. Discretionary one-off setups not in the library fail.
2. **Stop in 0.5–1.5 ATR band** (formerly P4). Stop ÷ ATR-10 mult between 0.5 and 1.5 inclusive, using the **trade's own entry ATR** — never the day/RTH session ATR. If the trade has no per-trade entry ATR (e.g. a GBX/overnight trade with no bars), mark **N/A and skip** — the RTH ATR regime does not apply outside RTH. Sub-0.5 needs `tight_stop_reason` logged. Sized-up (A+) trades, either instrument: ≤1.25 ATR AND total campaign risk ≤$200.
3. **TP1 ≥ 2R, or reason logged.** Planned TP1 is at least 2× the planned risk distance. If TP1 < 2R, the EOD recap must explain why (one-off structural target, day-character, etc.). Missing reason = fail.
4. **Clear area of interest noted.** The trade is anchored to a specific structural level (PDH/PDL, IBH/IBL, ONH/ONL, HTF zone, LVN, demand/supply cluster). "Random mid-range entry" or "felt right" = fail.
5. **2/3 orderflow reads = A+.** Trade has at least 2 of 3 strong orderflow signals: delta flip, absorption (delta bubble failure), delta fade. Trades with 0 or 1 OF signals fail this criterion.
6. **Entry was Break of Cluster or Break of Bubble.** The trigger was a structural break (price breaking through a cluster of orders, or breaking above/below a delta bubble), NOT a discretionary price-based entry ("looked like a good price"). **PASS automatically when the trade's `entry_model` tag includes "Break of Clusters/Bubbles" — that tag IS the trader declaring the trigger; trust it over a prose read. Never re-judge a tagged break-of-bubble entry as "location-based/discretionary" and fail it.** Only an untagged, purely discretionary price entry fails.
7. **Management based on chart, not emotion.** Exits driven by clear technical / structural triggers pass. Exit examples:
   • PASS: "Exited long because a HUGE buyer came in above me but did NOT get rewarded" — that's a structural read that the level isn't holding.
   • FAIL: "Exited early because I was scared to give back profits before my target" — PnL-anchored emotional decision, not structural.
8. **No mistakes tagged.** `tags_json.mistakes` is empty on the trade. Any mistake tag = fail.
9. **Emotion: Stable.** `tags_json.emotions` includes Stable (pass). Compromised = fail (not ideal, but trade-execution counts). MAXRAGE = fail AND a meta-signal that the trader shouldn't have been trading at all.

## ONE TAPESCORE (amendment 5 — derived headline, 0–100)
Computed in application code, never by the AI. The AI's only new responsibility is the day `headline` sentence (see below).

**Components (each scaled 0–100):**
- **Rules** = `pass_count / 5 × 100` over the five safety rails (P1–P5).
- **Execution** = `execution.composite × 100`. If the analysis ran but zero trades were scoreable, Execution = 0 (existing convention).
- **Prep** = prep quality score (`ai_analysis_json.score`, 1–10) × 10.

**Formula:** `TapeScore = round(0.50 × Rules + 0.35 × Execution + 0.15 × Prep)`
- A missing component (e.g. prep never analyzed) renormalizes the remaining weights; no components → no TapeScore.
- **Breach cap:** session verdict Breach (≤3/5 rails) ⇒ `min(TapeScore, 49)`. A session that broke two or more safety rails can never render green or amber.

**Banding:** 70–100 = high (green), 50–69 = mid (amber), 0–49 = low (red). All Breach sessions land in the red band via the cap.

**Legacy rows:** pre-amendment-3 rows (P1–P7 keys, detected by the presence of P6/P7) remap old→new rails (P1–P3 unchanged, old P5 cooldown → P4, old P6 trade cap → P5; old P4/P7 are ignored — they moved into Execution Parameters). Pre-v1.3 rows with only the single 0–10 `score` field use `score × 10`, flagged as legacy-rubric.

**Day headline:** new analyses emit a top-level `headline` — one sentence, ≤14 words, stating the day's verdict in plain language (decision quality, not P&L). It must never contain the word "Compliance". Legacy rows fall back to a deterministic template.

## TREND METRICS
- Compliant-session rate, rolling 10 and 20 sessions.
- Per-rule breach count; days-between-breach per rule.
- Breach **count vector** (never averaged), e.g. `P1:0 P2:1 P3:0 P4:2 P5:1`.
- A+ size-up usage count and breach count, per instrument (tracks whether the size exception is being abused).
- Execution Parameters per-criterion pass rate (which of the 9 criteria are dragging the composite — surfaced in `execution_parameter_breakdown`).

## REMOVED FROM SCORING (ritual/qualitative, not process rules)
Pre-trade read-aloud, post-loss screen-off, observation-only journaling, emotion notes, bank-the-day, hard time stop, T1-red two-trade cap, **post-9am entry gate.**

## STANDING FLAGS
- ACSIL kill-switch **not compiled.** P4 (cooldown) and P5 (trade cap) are SELF-POLICED until confirmed live; only P1 (daily loss limit) is externally enforced.
- Contract size is fixed by rule (base / A+ per instrument), not ATR-derived. Stop floats with ATR, so dollar risk rises with volatility — bounded only by P1, the Execution-Parameters #2 stop-band, the $200 campaign cap, and the post-loss size cap. The 10-MNQ S&D on a wide-ATR day is your largest single-trade risk; on days where ATR > 8 points the $200 cap makes a full 10-MNQ entry mathematically impossible. That is intended.
