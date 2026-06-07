# EMA slope vs trade outcomes

Phase 1 research: does the EMA's slope at entry predict win-rate, PnL, or EV?

For each trade in `trades` + `historical_trades` we:

1. Find the 1-minute bar at the entry timestamp (UTC, floored to the minute).
2. Compute an EMA up to that bar (default length 21).
3. Compute slope across the last N bars (default 5):
   - `--unit pct` → average % change of the EMA per bar.
   - `--unit deg` → geometric angle, normalizing dy by `--tick` (default 0.25 = MNQ) and dx by 1 bar.
4. Read the EMA at **`idx - 1`** to avoid lookahead — the EMA at the entry bar includes that bar's close, which the trader didn't have when they pulled the trigger.
5. Align slope with trade direction (negate for shorts) — positive = "the move was with you".
6. Bucket and report n / WR / avgPnL / totalPnL / EV per bucket.

## Run

```
unset ANTHROPIC_API_KEY && npx tsx research/ema-slope/run.ts \
  --from 2026-01-01 --to 2026-06-07 \
  --ema 21 --lookback 5 --unit pct --bucket 0.02
```

Flags:

| flag | default | notes |
|---|---|---|
| `--from YYYY-MM-DD` | 90 days ago | UTC midnight |
| `--to YYYY-MM-DD`   | today      | UTC end-of-day |
| `--ema N`           | 21         | EMA length (1-min bars) |
| `--lookback N`      | 5          | bars across which slope is measured |
| `--unit pct\|deg`   | `pct`      | bucketing unit |
| `--bucket N`        | 0.02 (pct) / 5 (deg) | bucket width in the chosen unit |
| `--tick N`          | 0.25       | tick size for `deg` (MNQ default) |
| `--symbol SYM`      | all        | e.g. `MNQM6.CME` |
| `--source all\|trades\|historical_trades` | `all` | which table to pull from |

## Open caveats

- **Contract rollover.** `ohlcv_bars` only covers symbols/windows you've imported. Trades on uncovered symbols are skipped — see `missing bars: N` in the output. For long historical sweeps (e.g. all 915 Tradezella rows), expect significant skip rates until the bar table is backfilled.
- **PT vs UTC.** Filter dates are UTC midnight-to-midnight. A trade at PT 21:00 on 2026-06-06 falls in the UTC 2026-06-07 bucket. Doesn't change the per-trade slope calculation, just the date filter.
- **Phase 2 not built yet.** This script overlays slope onto *real* trades. The follow-up — bar-replay where we generate synthetic entries when slope crosses thresholds — will be a sibling file (`replay.ts`). Tests the signal in isolation from execution.
