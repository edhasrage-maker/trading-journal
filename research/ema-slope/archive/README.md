# Archived — 1-minute 9/20 EMA experiments

**Archived 2026-06-17.** Set aside, not deleted. Revive if the 1m-EMA thread ever becomes relevant again.

## What's in here

Output logs from running the strategy's EMA **on the 1-minute timeframe** (`--decision-tf 1`),
both the 9 and the 20 EMA, across slope floors, R-multiples, separation floors, and VWAP variants.

## Why it's archived

**The strategy's entry is always the 5-minute 9 EMA.** The 1-minute is only ever used for
execution timing (which 1m sub-bar tags the 5m EMA level) and stop sizing — it never defines
the entry line. Running the *decision* EMA on the 1m is a different strategy, and it loses.

Head-to-head, same period / execution / filters, only the decision timeframe changed
(slope filter off to isolate the timeframe effect; tick-resolved; 2R):

| Decision TF | Trades/day | Win% | Median MFE | EV/trade | Profit factor | Total $ (5 MNQ) |
|---|---|---|---|---|---|---|
| **1m** | 11.78 | 33.1% | 1.18 | −$2.13 | **0.98** | **−$29,146** |
| **5m** | 4.71 | 34.3% | 1.37 | +$5.39 | **1.06** | **+$29,466** |

The 1m EMA gets crossed constantly → it overtrades on noise (11.8 signals/day vs 4.7) with
poor follow-through (median MFE 1.18 — barely past 1R before reversing). The 5m EMA holds
structure. The decision (direction + entry line + slope) belongs on the 5m. Door closed.

## Reviving

The engine still supports `--decision-tf 1` (it defaults to 5). To regenerate any of these:

```
unset ANTHROPIC_API_KEY && npx tsx research/ema-slope/replay.ts --decision-tf 1 --ema 9 ...
```
