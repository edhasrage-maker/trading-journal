# 9 EMA Holds on NQ — Research Findings

**Study:** Does the 9 EMA's slope, plus a pullback-to-the-line entry, produce a tradeable edge on NQ?
**Engine:** `research/ema-slope/replay.ts` (bar-replay over Sierra Chart `.scid` tick files)
**Data:** 18 NQ quarterly contracts, tick → 1m → 5m, RTH only (06:30–13:00 PT), ~Dec 2021 → Jun 2026 (~4.5 yrs, ~1,130 trading days)
**Cost model:** none. No commissions, no slippage. PnL math = 5 MNQ × \$2/point unless noted.
**Last updated:** 2026-06-09

> ⚠️ This file documents a research thread that produced its core code as an *untracked* file (`replay.ts`), which got deleted once by a mid-session `git merge` resolving a delete/update conflict. It was recovered from `HEAD^2` + re-applied edits and verified by exact reproduction. **To keep this from happening again, commit `research/ema-slope/` to git.**

---

## ⭐ Master Chart — champion config (1R)

**Pullback · 1R target · min-slope 2.0 · 07:00–11:00 PT · both sides · 5 MNQ × \$2/pt · 4.5 yrs · no costs**

| KPI | Value |
|---|---|
| 1. Trades / day | **4.99**  (5,673 trades / 1,136 trading days) |
| 2. Win rate | **63.4%** |
| 3. Median MFE captured vs MAE taken (ATR) | **1.11** captured  vs  **0.57** taken |
| 4. EV / trade | **\$36.13** |
| 5. Profit factor | **1.71** |
| 6. Total PnL (5 MNQ) | **\$204,948** |

Reproduce:
```
unset ANTHROPIC_API_KEY && npx tsx research/ema-slope/replay.ts \
  --entry pullback --min-slope 2.0 --time-start 07:00 --time-end 11:00 --target 1
```
Read 3 as: the median trade banks **1.11 ATR** in your favor while only giving back **0.57 ATR** — you capture roughly **2× what you risk** on a typical trade. (1.00 ATR = the stop distance.)

---

## 1. Plain-English summary

Pick a 5-minute NQ chart with one smoothed line on it (a 9-period EMA). Only consider trading when price is on the right side of the line *and* the line is tilted that way (above + rising = longs; below + falling = shorts). Wait for price to be meaningfully separated from the line (≥ 0.5× a typical 1-minute range), then place a limit order back *at* the line. If price pulls back and touches it, you're in. Stop = 1× ATR(10) on the 1-minute chart; target = a fixed R-multiple. Trade closes at stop or target; anything open at the 1pm cash close is discarded. Do this thousands of times across years of data and ask: what slope, what time of day, and what target actually make money.

---

## 2. The strategy (as implemented)

**State machine (updated every 5m close):**
- **Bias** = LONG when close > EMA AND slope > 0; SHORT when close < EMA AND slope < 0; else NONE. Slope = (EMA[i] − EMA[i−3]) / 3, pts per 5m bar.
- On bias change → DISARM.
- **ARMED** when |close − EMA| ≥ 0.5 × ATR(10) (separation rule).
- **Session reset** on each new PT date.

**Entry — Pullback mode (the winner):** at a 5m close that is biased + armed, place a one-shot limit at the EMA for the *next* 5m bar only. First 1m sub-bar that touches it fills (limit-or-better). Stop = 1× ATR(10) read the minute before the fill. Target = R-multiple from entry.

**Entry — Break mode (the loser):** wait for a 1m rejection bar (pierces EMA, closes back on-side), arm a stop order at its extreme; fill on breakout. Stop = rejection bar's opposite extreme. **Net negative across all conditions — abandoned.**

**Three design decisions locked by the user:**
1. Pullback limit is **one-shot** (dies if untouched in the next 5m bar; must re-earn ARMED).
2. Re-arm after any exit/disarm requires **compress-then-separate** (price must come back within 0.5× ATR of the EMA, then separate again) — prevents re-entering the same continuous trend.
3. The **2-bars-against** disarm (2 consecutive 1m closes on the wrong side of the EMA) applies to **both** modes.

**Exit:** pessimistic same-bar tie-break — if one 1m bar contains both stop and target, count it as the **stop** (loss). End-of-RTH unresolved trades are excluded from all stats.

---

## 3. Headline finding — target size is everything

The single most important result. Same entries, same stops, same filters; only the target distance changes. Config: min-slope 2.0, entries 07:00–11:00 PT, both directions, 4.5 yrs.

| Target | Trades | WR% | avg R | EV \$/trade | Total \$ | **Profit Factor** |
|---|---:|---:|---:|---:|---:|---:|
| **1R** | 5,673 | **63.4%** | **+0.27** | \$36.13 | **\$204,948** | **1.71** |
| 1.5R | 5,508 | 44.7% | +0.12 | \$15.46 | \$85,151 | 1.20 |
| 2R | 5,386 | 35.0% | +0.05 | \$6.92 | \$37,267 | 1.08 |

**The 1R scalp is dramatically better than the 2R hold.** PF jumps 1.08 → 1.71 purely by tightening the target. The strategy was never broken — the 2R target was breaking it.

### Cross-validation against an independent test
A separately-built test (single 1m CSV, 438 days, **fixed 20pt stop**, triple-confluence VWAP/EMA9/EMA20, different implementation) produced **63.0% WR / +0.26R at 1R** — within 0.4% WR and 0.01R of this engine's **63.4% / +0.27R**. Two independent backtests, different data and stop models, converge on the same 1R continuation edge. Strong corroboration. (At 2R the other test does better — +0.18R vs +0.05R — its triple-confluence + fixed stop help the longer hold; at 1R the edge is strong enough that the extra filtering barely matters.)

---

## 4. Regime stability (1R)

At 2R the edge was regime-dependent (2023 & 2025 chop years were PF ~1.01 coin-flips; profit concentrated in trend years). **At 1R that problem disappears:**

| Year | 2R PF | **1R PF** |
|---|---:|---:|
| 2021 (partial) | — | 1.57 |
| 2022 | 1.06 | 1.78 |
| 2023 (chop) | 1.02 | 1.70 |
| 2024 | 1.08 | 1.74 |
| 2025 (chop) | 1.09 | 1.71 |
| 2026 YTD | 1.13 | 1.61 |

Every year PF 1.6–1.8. The chop years that broke 2R are just as profitable as the trend years at 1R.

---

## 5. Long vs Short (1R, min-slope 2.0, 07:00–11:00)

| Side | n | WR% | EV \$ | Total \$ | **PF** |
|---|---:|---:|---:|---:|---:|
| **LONG** | 2,944 | 66.2% | \$41.34 | \$121,702 | **1.96** |
| SHORT | 2,729 | 60.4% | \$30.50 | \$83,246 | 1.52 |

Both sides genuinely profitable at 1R. Longs are stronger (structural index drift), but shorts went from marginal at 2R (PF 1.03) to real at 1R (PF 1.52).

---

## 6. MFE / MAE excursion (normalized to ATR; 1.00 = stop distance)

In-trade max favorable/adverse excursion, 1R champion config:

| Group | n | avgMFE | avgMAE | **loserMFE** | **winnerMAE** |
|---|---:|---:|---:|---:|---:|
| WINNERS | 3,596 | 1.37 | 0.34 | — | 0.34 |
| LOSERS | 2,077 | 0.76 | 1.44 | 0.76 | — |
| OVERALL | 5,673 | 1.15 | 0.74 | 0.76 | 0.34 |

**Two key numbers:**
- **winnerMAE = 0.34** — winners barely go against you (only a third of the way to the 1.0-ATR stop, median 0.27) before working. The stop is *too wide for how winners behave* → strong signal a tighter stop (~0.5–0.6 ATR) keeps most winners while halving losses.
- **loserMFE = 0.76** — losers run 0.76 ATR in your favor (¾ of the way to a 1R target) before reversing to the stop. This is the mechanical reason 1R beats 2R, quantified: the target sits right where price reverses; push it to 2R and these runs never reach it.

Asymmetry: **winners use 0.34 ATR of heat; losers give 0.76 ATR of hope.**

---

## 7. Filter derivation (how we got to the champion config)

**Slope floor (`--min-slope`)** — EV/trade rises monotonically with the floor; total profit peaks around min-slope 1.0–2.0. Slope ≈ 1.0 pts/5m is barely a trend; 2.0 cleanly drops drift. At 2R the floor was load-bearing (shallow/typical buckets were dead PF ~1.01); **at 1R it matters far less** (even the shallow bucket is PF 1.70) — the floor mostly separated "reaches 2R" from "doesn't."

**Time-of-day** — by 30-min PT entry bucket, the profitable windows (07:00–07:30, 08:00–08:30, 10:00–10:30, 12:30–13:00) and the loss windows are stable across slope thresholds. **The 06:30–07:00 open loses money at every threshold** — worst slot, period. 11:00–11:30 and 12:00–12:30 also persistently negative. → chose the **07:00–11:00 PT** window. It also pulled the chop year 2025 from PF ~1.01 to ~1.09 at 2R (time filter did more for regime stability than the slope filter).

**Break mode** — net negative across all conditions (−\$15k at 2R, all-session). Inverted-U on slope (steep slopes lose). Not salvageable as designed.

---

## 8. Current best baseline (the reference point)

> **Pullback, min-slope 2.0, entries 07:00–11:00 PT, 1R target, 1× ATR(10) stop, both sides.**
> 5,673 trades · 63.4% WR · PF 1.71 · +\$204,948 (5 MNQ, no costs).
> Long-only is even cleaner: PF 1.96.

CLI to reproduce:
```
unset ANTHROPIC_API_KEY && npx tsx research/ema-slope/replay.ts \
  --entry pullback --min-slope 2.0 --time-start 07:00 --time-end 11:00 --target 1
```

**Cost caveat:** no commissions modeled. The 1R version is *more* cost-robust than 2R despite ~2× the churn (PF 1.71 has cushion; PF 1.08 does not). Rough check: \$5/trade commission knocks 1R from \$205k → ~\$177k, but knocks 2R from \$37k → ~\$10k.

---

## 9. Open threads / next experiments

1. **Decouple the stop from the target** (`--stop N` in ATR, separate from `--target`). MFE/MAE predicts a ~0.5–0.6 ATR stop with the 1R-distance target (~1.6:1 reward:risk) could push PF well past 1.71. The average winnerMAE (0.34) hides a tail — needs an actual sweep to confirm the trade-off nets positive. **Highest-value next test.**
2. **Breakeven-after-+0.5R rule** — attacks the loserMFE 0.76 directly.
3. **Max drawdown / equity curve** — we report PF and total R but have never computed peak-to-trough DD. Needed before this is "decision-grade." (The other VWAP test reported Max DD −12R at 1R.)
4. **Unfiltered 1R** — quantify how much the slope + time filters actually add at 1R (they add little by bucket — a simpler "just 1R" strategy may hold up).
5. **Walk-forward** — fit filter params on 2022–23, evaluate on 2024–26. Honest out-of-sample.
6. **Port VWAP + static-daily-bias** from the other test onto this engine/dataset to isolate which feature carries its 2R edge.

---

## 10. Data integrity notes

- **Price-divisor bug (fixed).** Three `.scid` files (NQZ23, NQM24, NQU24) store prices unscaled (÷1) instead of ÷100. The reader hardcoded ÷100, making their EMA slope/ATR 100× too small → those contracts silently dropped out under any slope filter (0 trades) and were dollar-undercounted at baseline. Fixed via a first-bar probe (`close < 1000` → divisor 1). Restored ~1,700 trades / ~\$9k. **Any future `.scid` additions should be spot-checked for scaling.**
- **Contract roll:** non-overlapping 3-month windows ending day 14 of expiry month (approx E-mini roll). Larger-file-wins dedup for legacy vs current naming (`NQM6.CME.scid` vs `NQM26-CME.scid`).
- **No lookahead:** EMA/ATR/slope/levels always read from fully-closed prior bars. 1m sub-bars use the prior 5m bar's EMA.

---

## 11. CLI reference

| flag | default | purpose |
|---|---|---|
| `--entry pullback\|break` | pullback | entry rule |
| `--target N` | 2 | target as R-multiple (**1 is the champion**) |
| `--min-slope N` | 0 | slope floor, pts/5m (drop weak trends) |
| `--time-start HH:MM` / `--time-end HH:MM` | — | PT entry window |
| `--side long\|short\|both` | both | direction filter |
| `--ema N` / `--lookback N` / `--atr N` | 9 / 3 / 10 | indicator params |
| `--rearm N` | 0.5 | ATR fractions for separation/re-arm |
| `--contracts N` / `--mult N` | 5 / 2 | PnL math (MNQ defaults) |
| `--from` / `--to` | — | date filters (YYYY-MM-DD) |
| `--show "YYYY-MM-DDTHH:MM"` | — | dump state ±15m around a PT moment (break mode) |
| `--debug N` | 0 | print first N rejection walkthroughs |
| `LIST_TRADES=1` (env) | — | dump every trade with levels, R, MFE/MAE |

Reports emitted: slope terciles · time-of-day (30-min PT) · per-year · long/short · MFE-MAE excursion. All include Profit Factor and total R.
