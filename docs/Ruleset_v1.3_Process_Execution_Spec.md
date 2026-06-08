# TRADING RULESET — v1.3
**Effective 2026-06-07 · NQ/MNQ · RTH 06:30–13:00 PST**

## INSTRUCTION TO THE JOURNAL ASSISTANT
Replace in full any prior ruleset, sizing model, or scoring logic. Adopt the below verbatim. Do not infer, soften, merge, or average rules. Evaluate each rule only against the data field named.

**Two layers, never combined:**
- **Process** = binary, per-rule, scored independently. Any one breach = Breach session. No averaging, no percentage, no P&L override.
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

## PROCESS RULES (binary)
Missing-data handling differs by tier (see §Unscorable).

| ID | Rule | Pass | Data field(s) | Enforce |
|----|------|------|---------------|---------|
| P1 | Daily loss limit | Session Net P&L not past −$500 | Net P&L by session | ENFORCED |
| P2 | Size within cap | ≤5 MNQ; ≤10 only on valid Qualifying S&D (Path A/B) | Quantity, Setups, Orderflow, Net P&L | SELF |
| P3 | No size-up after loss | Post-loss → ≤5 MNQ, no scale to 10 | Quantity, Net P&L, sequence | SELF |
| P4 | Stop valid | ATR mult 0.5–1.5; 10-MNQ ≤1.25 ATR & ≤$200 campaign | planned stop points, ATR | SELF |
| P5 | Cooldown | ≥90s after any loss | close time → open time | SELF until ACSIL |
| P6 | Trade cap | ≤7 trades/session | trade count by session | SELF until ACSIL |
| P7 | Setup valid | OF confirmation present AND directionally aligned | orderflow + manual context | SELF |

No time-of-day gate. (Post-9:30 holds your expectancy; an early-entry rule is excluded by design.)

## VERDICT
`compliant = P1 AND P2 AND P3 AND P4 AND P5 AND P6 AND P7`
Verdict ∈ {Compliant, Breach}. Green P&L + any breach = **Breach.** Red P&L + zero breaches = **Compliant.** P&L does not define discipline.

## UNSCORABLE (scoped — this is the de-fusing fix)
- **P1–P6 (enforcement-critical):** required data missing → **Breach.** These safety rails must be verifiable.
- **P7 (judgment):** missing orderflow/context log → **Incomplete**, counted in the data-completeness metric, **not** an auto-breach. A run of blanks is itself a flag, but it does not zero your compliant-rate on paperwork.

## EXECUTION QUALITY (weekly, compliant trades only, diagnostic)
| Metric | Source | Weight |
|--------|--------|--------|
| Duration-to-thesis | trade duration | 35% |
| MFE capture / exit efficiency | exit efficiency, position MFE, best exit | 30% |
| MAE / heat control | position MAE, price MAE | 20% |
| Realized vs planned RR | realized RR vs planned reward ratio | 15% |
Composite is diagnostic only. Never combined with process.

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
