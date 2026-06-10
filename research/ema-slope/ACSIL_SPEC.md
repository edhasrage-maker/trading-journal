# Sierra Chart / ACSIL build spec — "9 EMA Hold" pullback system

Hand this to the ACSIL (C++) developer. It specifies the exact strategy our backtest validated
(63% win rate, PF 1.71, ~5 trades/day over 4.5 yrs of NQ). Terminology is Sierra-native.
Where it says "champion config," those are the validated defaults.

---

## 0. What it is, in one paragraph

On a 1-minute NQ chart, with a 9-period EMA computed on **5-minute** closes: when price is trending
(price on the correct side of the 5m EMA *and* the EMA sloping that way by ≥ 2 pts/5m bar) and has
separated from the line by ≥ 0.5× ATR, place a **limit order back at the 5m EMA** for the next 5-minute
bar. Fill on the pullback. Stop = 1× ATR(10) on 1-minute bars. Target = **1R** (this is the key result —
1R beats 2R decisively). One position at a time, entries only 07:00–11:00 PT.

---

## 1. Chart setup

- **Trading/execution chart:** 1-minute, NQ (front contract; trade MNQ for sizing).
- **Indicator source:** the 9 EMA lives on the **5-minute** timeframe. Two valid approaches:
  - **(A, recommended) Cross-chart reference.** Add a 5-minute chart of the same symbol with a
    *Moving Average – Exponential, Length 9, on Last*. From the 1-min study, read it with
    `sc.GetStudyArrayFromChartUsingID(ChartNumber5m, StudyID, 0, EMA5m)` and map the current 1-min
    bar to the containing 5-min bar via `sc.GetContainingIndexForSCDateTime(ChartNumber5m, sc.BaseDateTimeIn[sc.Index])`.
  - **(B) Internal resample.** Aggregate 1-min closes into wall-clock 5-min buckets in code and run
    your own EMA (α = 2/(9+1) = 0.2) on the bucket closes. Matches our backtest's bucketing exactly.
- ATR(10) **Wilders** on the 1-min chart: `sc.ATR(sc.BaseDataIn, ATR, 10, MOVAVGTYPE_WILDERS)`.
- Set the chart **time zone to Exchange (or your PT reference)** so the session windows below line up.

## 2. Study Inputs (`sc.Input[]`)

| Input | Default | Notes |
|---|---|---|
| EMA length (5m) | 9 | |
| Slope lookback (5m bars) | 3 | |
| Min slope (pts per 5m bar) | 2.0 | direction-aligned magnitude floor |
| ATR period (1m, Wilders) | 10 | |
| Separation / re-arm (× ATR) | 0.5 | arming distance from EMA |
| Target (R multiple) | **1.0** | 1R is the validated champion (not 2R) |
| Entry window start (PT) | 07:00 | no new entries before |
| Entry window end (PT) | 11:00 | no new entries after |
| RTH start / end (PT) | 06:30 / 13:00 | exits allowed across full RTH; flatten at 13:00 |
| Side | both | long / short / both |
| 5m chart number | — | for approach A |
| Use VWAP filter | off | optional, see §7 |

## 3. Core definitions (no lookahead — read carefully)

- **5m EMA known value at a 1-min bar** = the EMA of the **most recently *closed* 5-minute bar**.
  Inside an in-progress 5-min bar, use the **prior** 5-min bar's EMA (`EMA5m[k-1]`), never the
  forming bar's. This is the single most important correctness rule.
- **Slope** (at each 5m close, bar k): `slope = (EMA5m[k] − EMA5m[k-3]) / 3`  → points per 5m bar.
- **ATR** read for a fill = `ATR[fillBarIndex − 1]` (the minute *before* the fill; no peeking).

## 4. State machine — evaluate at each **5-minute bar close** (use `sc.GetBarHasClosedStatus`)

Persist across calls with `sc.GetPersistentInt/Float` (or a struct via `sc.GetPersistentPointer`);
reset all state when `sc.IsFullRecalculate` is true.

```
BIAS (recompute every 5m close, bar k):
  if Close5m[k] > EMA5m[k] AND slope > 0 → LONG
  elif Close5m[k] < EMA5m[k] AND slope < 0 → SHORT
  else NONE
  apply Side input; if |slope| < MinSlope → NONE; if outside entry window → NONE
  if BIAS changed → DISARM (clear armed, pending, needCompress, consecAgainst)

ARMING (only when biased, flat, not armed):
  sep = |Close5m[k] − EMA5m[k]|
  if needCompress:                      // post-exit / post-2-against gate
      if sep < 0.5*ATR → needCompress = false   // observed the compression; can re-arm next time
  elif sep >= 0.5*ATR:
      armed = true

PENDING LIMIT (one-shot):
  if biased AND armed AND flat:
      pendingLimitPrice = EMA5m[k]      // valid for the NEXT 5m bar's 1-min sub-bars ONLY
  else:
      pendingLimitPrice = none
```

## 5. State machine — evaluate at each **1-minute bar** inside the live 5m bar

```
EXIT first (if in a position): see §6.

If flat AND biased AND armed AND pendingLimitPrice set:
  LONG:  if 1m Low <= pendingLimitPrice → FILL at min(1m Open, pendingLimitPrice)
  SHORT: if 1m High >= pendingLimitPrice → FILL at max(1m Open, pendingLimitPrice)
  on fill:
     stopDist = ATR[fillIdx-1]
     stop   = entry ∓ stopDist           (long: entry−stopDist)
     target = entry ± stopDist*TargetR    (long: entry + 1*stopDist)
     clear pending
  (the limit is one-shot: if the 5m bar ends unfilled, it dies — re-earn ARMED)

2-BARS-AGAINST (while armed, flat):
  wrongSide = (LONG and 1m Close < EMA5m[k-1]) or (SHORT and 1m Close > EMA5m[k-1])
  if wrongSide → consecAgainst++  else consecAgainst = 0
  if consecAgainst >= 2 → DISARM, needCompress = true
```

## 6. Exit logic (per 1-minute bar, while in a position)

```
LONG:  if 1m Low  <= stop   → EXIT at stop   (−1R)        // pessimistic: stop wins ties
       elif 1m High >= target → EXIT at target (+TargetR)
SHORT: mirror.
After ANY exit: armed = false; needCompress = true.      // forces compress-then-separate before re-arm
At 13:00 PT (RTH end): flatten any open position (it's an unresolved/scratch — exclude from edge stats).
```

**Pessimistic tie-break:** if one 1-min bar's range contains *both* stop and target, count the **stop**.
In Sierra's backtest, set the Trade Simulation fill model to "Stop orders fill first" (or equivalent)
so live and backtest agree.

## 7. Optional VWAP quality filter (improves PF 1.71 → 1.83)

Add a **VWAP** study with **session start = 15:00 PT** (3pm, the ETH open) so it's a rolling 24-hour
VWAP. Gate the bias: allow LONG only if 5m Close > VWAP, SHORT only if < VWAP. Everything else identical.

## 8. Order handling (auto-trading)

- `sc.AllowMultipleEntriesInSameDirection = false;` one position at a time; no pyramiding.
- Entry = **limit** order at `pendingLimitPrice` (`SCT_ORDERTYPE_LIMIT`), good for the current 5m bar only —
  cancel/replace each 5m bar (one-shot semantics). Use attached **Stop** and **Target (Limit)** child orders
  (`s_SCNewOrder.Stop1Offset / Target1Offset` or absolute prices).
- Quantity = full size at entry; **exit the entire position at the 1R target.** Do **not** scale out /
  hold runners — we tested 3-off-at-1R + runner-to-EMA and it *cut* PF from 1.71 → ~1.42. Single bracket.
- Flatten at 13:00 PT.

## 9. Things that will bite you (gotchas)

1. **Lookahead via the forming 5m bar.** Always use the prior closed 5m EMA for 1-min decisions.
2. **Timezone.** Session inputs are PT; make sure the chart's time setting matches, or convert with
   `sc.TimeFromDateTime` against an explicit offset (mind DST — our backtest is DST-aware).
3. **Re-arm gate.** After an exit you must see price compress back inside 0.5×ATR of the EMA *before*
   a new separation can arm. Skipping this re-enters the same trend repeatedly and inflates results.
4. **Contract roll.** Trade the front month; our study used non-overlapping 3-month windows ending the
   14th of the expiry month.
5. **Price scaling** is not an ACSIL concern (Sierra hands you real prices), but note our raw `.scid`
   reader had to detect a ÷1 vs ÷100 scaling quirk on a few files — irrelevant inside Sierra.

## 10. Acceptance test

On NQ 1-min, champion inputs (EMA 9, slope≥2.0, ATR 10, sep 0.5, target 1R, window 07:00–11:00 PT, both
sides), over a multi-month sample you should see roughly: ~5 trades/day, ~63% win rate, average winner ≈
average loser in dollars (1:1 R), profit factor in the 1.6–1.8 range. If win rate prints near 50% or
trades/day are 10+, the no-lookahead or arming/re-arm logic is wrong.
