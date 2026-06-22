# Delta Unwind Stars — backtest harness

Measures the effectiveness of the Sierra Chart custom study
`D:\SierraCharts\ACS_Source\DeltaUnwindStars.cpp` (delta-exhaustion / absorption
reversal signal) against historical NQ tick data.

The study itself only *plots stars* — it has no exits — so "effectiveness" is
defined here as **signal quality**: do the flagged bars produce better forward
excursion than a random bar? This is the cheap, exit-agnostic test for whether
an edge exists at all, before committing to any trade model.

## Pieces

- **`scid-delta.ts`** — delta-aware `.scid` reader. Same binary format as
  `src/lib/scid-reader.ts`, but reconstructs per-bar order flow from each tick's
  `BidVolume`/`AskVolume`:
  - `deltaClose` = Σ(ask − bid) over the bar
  - `maxDelta` / `minDelta` = highest / lowest the *running* cumulative delta
    reached intrabar (seeded at 0 each bar open)
  These three are exactly what the study reads from a Numbers Bars Calculated
  Values study (DeltaClose / MaxDelta / MinDelta subgraphs).
- **`signal.ts`** — faithful TS port of the study's long/short conditions and
  EMA-of-|delta| impulse filter. Defaults mirror the `.cpp` `SetDefaults` block.
- **`run.ts`** — sweeps all NQ front-month contract windows (via
  `ema-slope/scid-discovery.ts`), computes signals, and reports forward
  MFE/MAE + a 1:1 bracket-race win rate, **signal vs baseline**.

## Methodology

- **Entry reference** = next bar's open (no lookahead — the study's
  `EvaluateOnClose` means a signal is only known after its bar closes).
- **Forward MFE/MAE** over horizons of 5 / 10 / 20 bars, normalized to ATR at
  the signal bar. Reported as medians (robust to the fat right tail).
- **Baseline** = the same forward-excursion distribution computed over *every*
  eligible bar, framed both long and short. This controls for NQ's directional
  drift: a long signal in an up-market shows favorable excursion regardless, so
  the figure that matters is `lift` = signal medMFE − baseline medMFE, and the
  bracket-race edge in percentage points.
- **Bracket race** = does favorable ±`bracketK`×ATR get touched before adverse,
  within the max horizon? Same-bar double-touch resolves to the adverse side.

## Usage

```bash
# All available NQ .scid, RTH, default study params
unset ANTHROPIC_API_KEY && npx tsx research/delta-unwind/run.ts

# Scoped window + parameter override + ETH/all sessions
npx tsx research/delta-unwind/run.ts --from 2026-01-01 --to 2026-06-09 \
  --session all --str 1.5 --floor-min 150 --imp 1.0 --horizons 5,10,20,40
```

Flags: `--from --to --scid-dir --tf <min> --atr <period>
--session rth|eth|all --horizons a,b,c --bracket <ATR>` and study params
`--ema --floor-min --floor-max --imp --str --long-ge0 0|1 --short-mode 0|1|2
--short-frac`.

## Fidelity caveats (validate before trusting figures)

1. **Running-delta seeding.** min/max bracket 0, so a one-sided bar has the
   opposite extreme == 0. Standard Numbers Bars behavior; if Sierra is set to
   seed from the first tick, one-sided bars differ slightly.
2. **Per-record net.** Each `.scid` record's net (ask − bid) is applied as one
   step. Records that aggregate multiple trades lose intrabar ordering, so
   min/max can be marginally understated vs a pure tick stream.
3. **No reclassification.** Aggressor side is whatever was captured into the
   `.scid` — the same data Numbers Bars sees.

**Recommended cross-check:** pick one day, compare reconstructed
`deltaClose/minDelta/maxDelta` against the live Numbers Bars study values in
Sierra before drawing conclusions. See `FINDINGS.md` for results.
