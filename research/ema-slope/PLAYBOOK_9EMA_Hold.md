# 9 EMA Hold — 5-min Pullback Continuation

*Backtested edge: 18 NQ contracts, ~4.5 yrs, RTH only, no commissions. Champion config below.*

---

## The setup in one line
In a 5-minute trend, buy the **pullback back to the 9 EMA** (sell it in a downtrend), risk 1× ATR,
**take the full target at 1R.** High win-rate scalp — the edge is the hit rate, not big winners.

## The edge (why this is in the book)
| | |
|---|---|
| Win rate | **63%** |
| Profit factor | **1.71** (1.83 with VWAP filter) |
| Avg trade | **+0.27R** · median +1.1 ATR captured vs −0.6 ATR risked |
| Frequency | **~5 trades/day** (07:00–11:00 PT window) |
| Best side | **Longs** (PF 1.96) > shorts (PF 1.52) — both work |

## Context filters (no trade unless ALL true)
- **Time:** entries **07:00–11:00 PT only.** Skip the 06:30 open — it loses money every year.
- **Trend (5m close):** price on the correct side of the 9 EMA **and** the EMA sloping that way.
- **Slope strength:** EMA tilting **≥ 2 points per 5-min bar** (a real lean, not a drift). Steeper = better.
- **Separation:** price has pushed **≥ ½ ATR** away from the EMA (it's trending, not glued to the line).

## Trigger & entry
1. With the filters met, you're **armed.** Place a **limit at the 9 EMA** for the next 5-min bar.
2. Price pulls back and touches it → **filled.** (One-shot: if it doesn't touch within that 5-min bar,
   cancel and wait to re-arm.)

## Risk & target
- **Stop:** 1× ATR(10) on the 1-min, just past your entry.
- **Target:** **1R. Full position off at 1R.** This is the whole finding — 1R crushes 2R (PF 1.71 vs 1.08).
- **Sizing:** full size in, full size out. *No scaling, no runners* — tested, it cut PF to ~1.4.

## Management & invalidation
- Winners work fast (they barely dip — median ¼ ATR of heat). If it's deeply underwater early, it's wrong.
- **Bail the setup** if 2 one-minute bars in a row **close on the wrong side of the EMA**, or the 5-min
  trend flips. After any trade, wait for price to come **back to the EMA and push out again** before re-arming
  (don't re-enter the same continuous move).
- Flat by the 1pm cash close.

## Optional A+ filter (highest quality)
Only take **longs above** the 24-hour VWAP (anchored 3pm PT) and **shorts below** it. Fewer trades,
cleaner edge → **PF 1.83**, every year green.

## Do NOT
- ✗ Trade the 06:30–07:00 open · ✗ Stretch the target to 2R · ✗ Scale out / hold runners
- ✗ Chase when price is glued to the EMA (no separation) · ✗ Fade a slope steeper *against* you

> **Mental model:** "Strong, tilted 5-min trend → wait for the dip to the 9 EMA → take a quick 1R.
> Bank it. The money is in the 63% hit rate, repeated cleanly — not in holding for home runs."
