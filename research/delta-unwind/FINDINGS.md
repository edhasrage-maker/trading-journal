# Delta Unwind Stars — findings

## Run 1 — signal quality at default params (2026-06-10)

**Config:** NQ, all front-month `.scid` windows (NQH22 → NQM26, ~4.4 years),
1-minute bars, RTH only, ATR(14), study defaults (ema 30, floor 100/100,
impulse 0.8, unwind-strength 1.0, long close ≥0, short close ≤0).
**Sample:** 1,589,224 1m bars · 9,264 long signals · 9,837 short signals.

| side  | horizon | medMFE | medMAE | MFE/MAE | baseMFE | baseMAE | lift | race WR | base WR | edge |
|-------|---------|--------|--------|---------|---------|---------|------|---------|---------|------|
| LONG  | 5m      | 0.98   | 0.98   | 1.00    | 0.93    | 0.93    | +0.05 | 49.0%  | 49.9%   | −0.9pp |
| LONG  | 10m     | 1.38   | 1.38   | 1.00    | 1.33    | 1.33    | +0.05 |        |         |        |
| LONG  | 20m     | 1.88   | 1.88   | 1.00    | 1.88    | 1.88    | +0.00 |        |         |        |
| SHORT | 5m      | 0.98   | 0.98   | 1.00    | 0.93    | 0.93    | +0.05 | 49.5%  | 49.6%   | −0.1pp |
| SHORT | 10m     | 1.38   | 1.38   | 1.00    | 1.33    | 1.33    | +0.05 |        |         |        |
| SHORT | 20m     | 1.93   | 1.93   | 1.00    | 1.88    | 1.88    | +0.05 |        |         |        |

### Verdict: no measurable directional edge at default params on 1m RTH.

- **MFE/MAE ≈ 1.00 on both sides, all horizons.** Forward excursion is symmetric
  — the signal does not lean price in its predicted direction.
- **Bracket-race WR ≈ baseline** (long −0.9pp, short −0.1pp). The 1:1 ATR race is
  the cleanest direction-aware metric, and it says ~coin-flip.
- **The +0.05 medMFE "lift" is a volatility artifact, not an edge.** Signal bars
  also carry +0.05 *medMAE*. The study selects high-delta-impulse bars, which are
  simply more volatile — more excursion *both* ways, no directional skew.
- **Baseline is ~symmetric over the full sample** (49.9% / 49.6%), so unlike the
  short 2-month preview (which showed a +1.3pp long edge in an up-market), there
  is no drift confound here. The 2-month positive was sample-size noise.

### Caveats before declaring the study dead
1. **Timeframe.** Tested on 1m bars. If the study is actually run on a different
   bar type in Sierra (5m / range / volume / Renko), these results do not
   transfer — rerun with `--tf` or a different bucketing.
2. **Default params.** The knobs exist to be tuned; edge may concentrate at
   higher unwind-strength / floor thresholds. Needs a parameter sweep.
3. **Time of day.** Reversal signals often only work in specific windows
   (e.g. post-open, lunch). Not yet segmented.
4. **Reconstruction fidelity.** Delta not yet cross-checked against live Numbers
   Bars. Relative signal-vs-baseline comparison is robust to small error; absolute
   thresholds (floor 100) are not.

### Next steps
- Parameter sweep over `--str`, `--floor-min/max`, `--imp` → look for a WR plateau.
- Time-of-day segmentation.
- Confirm the bar type the study is actually traded on.

---

## Run 2 — parameter sweep + time-of-day (2026-06-10)

**Config:** same data (4.4y, 1m, RTH), `sweep.ts`. Race = 1:1 ATR bracket, 20-bar
horizon. Grid: str ∈ {1.0,1.25,1.5,2.0} × floor ∈ {100,150,200,300} × imp ∈
{0.8,1.0,1.5}. Baseline race WR: **long 49.9% / short 49.6%** (n=444,159).
Confirmed traded on **1-minute bars**, so Run 1's config is the right one.

### Longs: dead everywhere.
Every one of the 48 combos has **negative** edge (best −0.3pp). No parameter
region rescues the long side.

### Shorts: a weak, consistent hint — floor 150 + stricter strength.
A cluster of adjacent combos beats baseline by ~+2pp:

| str | floor | imp | WR | edge | n |
|-----|-------|-----|------|------|------|
| 1.5 | 150 | 0.8 | 52.3% | +2.6pp | 1310 |
| 1.5 | 150 | 1.0 | 51.7% | +2.1pp | 1230 |
| 1.25| 150 | 0.8 | 51.3% | +1.7pp | 2114 |
| 2.0 | 150 | 0.8 | 51.9% | +2.2pp | 597 |

Notably **floor 150 is the sweet spot** — not 100 (default, no edge) and not
200/300 (too few signals). That an adjacent block of params all lean the same way
is more credible than a lone cell, but the magnitude is small and each cell is
only ~1.5–2σ over baseline (and the cells share bars, so not independent).

### Time of day (default params): short edge concentrates late session.
SHORT shows a clear lean in the **last 90 min of the cash session**:

| PT | sigWR | baseWR | edge | n |
|------|------|------|------|------|
| 11:30 (14:30 ET) | 53.8% | 49.7% | +4.2pp | 390 |
| 12:00 (15:00 ET) | 55.1% | 50.3% | +4.8pp | 412 |

LONG time-of-day is noisy with no clean structure (07:30 −3.8pp, 12:00 +2.3pp).
The morning open (06:30) is *negative* for both sides — fading the open thrust
does not work here.

### Verdict (Run 2)
Default-param study = no edge (Run 1 stands). But **two independent cuts point the
same way**: the edge, such as it is, is **short-only**, sharpest at **floor ≈ 150 /
str ≥ 1.25** and in the **11:00–12:30 PT window**. This is *suggestive, ~2σ, not
proven* — small once you stack filters.

### Recommended confirmatory test
Stack the filters: short-only, floor 150 / str 1.5, restricted to 11:00–12:30 PT,
then apply the Layer-2 trade model (entry next-bar, ATR stop, R target) and check
expectancy + whether the edge survives out-of-sample (split 2022–24 vs 2025–26).
If it evaporates on the holdout, it was noise.

---

## Run 3 — 1m 9 EMA direction filter (2026-06-10)

**Config:** same data, `ema-filter.ts`. Tested whether gating the flip on the 1m
9 EMA direction helps (3-bar slope lookback). Variants: no filter / **align**
(flip same direction as EMA) / **counter** (flip against EMA). RTH-only.

**CANDIDATE (str1.5/floor150), SHORT** — baseline 49.6%:

| variant | meaning | WR | edge | n |
|---|---|------|------|------|
| nofilter | — | 52.3% | +2.6pp | 1310 |
| align | short while 9 EMA falling | 48.0% | −1.6pp | 608 |
| **counter** | **short while 9 EMA rising** | **55.9%** | **+6.3pp** | 702 |

### Verdict: the EMA direction filter works — but COUNTER-trend, not aligned.
- Gating shorts to a **rising** 9 EMA (fading strength) lifts WR to **55.9%
  (+6.3pp, ~3σ)**. Gating to a *falling* 9 EMA kills it (−1.6pp). ~8pp spread
  between the two variants = the filter genuinely carries directional info.
- This is correct for an **exhaustion/absorption reversal**: it's a *fade*. You
  sell a bearish delta-reabsorption bar *into* a short-term uptrend (trapped
  buyers), not into an already-falling tape (chasing).
- Confirmed RTH-only (n shrinks but edge holds vs the all-session run: +6.3 vs
  +5.8pp). Not an ETH artifact.
- LONGs: dead in every variant (−2 to −3pp). The signal is short-only.
- DEFAULT params (str1.0/floor100): counter-short only +0.5pp — the edge needs
  the str1.5/floor150 selectivity AND the counter-EMA gate together.

### Caveat
This is now THREE filters chosen post-hoc (short-only · str1.5/floor150 ·
counter-EMA). +6.3pp at n≈702 is promising but multiple-comparisons-fragile.
**Must** survive a fit/holdout split before trading.

### Decisive next step (unchanged, now better-targeted)
Rule = **SHORT · str1.5 · floor150 · 9 EMA rising**. Run through the Layer-2
trade model (next-bar entry, ATR stop, R target) on a **2022–24 fit / 2025–26
holdout** split. Optionally also gate to the 11:00–12:30 PT window (Run 2). If
the holdout keeps positive expectancy, it's a real late-session NQ short fade.

---

## Run 4 — EMA-filter robustness (period × lookback) (2026-06-10)

**Config:** `emafilter-tune.ts`, candidate short (str1.5/floor150), RTH,
baseline 49.6%, candidate no-filter 52.3% (+2.6pp). Counter = filter EMA rising
(fade strength); align = falling. Edge vs baseline / n:

**COUNTER-trend short (the fade):**
| EMA | lb1 | lb3 | lb5 | lb10 |
|-----|-----|-----|-----|------|
| 9  | +5.0 (568) | **+6.3 (702)** | **+6.3 (716)** | +4.1 (723) |
| 20 | +5.1 (617) | +5.3 (719) | +4.6 (723) | +3.3 (723) |
| 50 | +4.1 (628) | +3.0 (692) | +2.9 (702) | +1.8 (709) |

**ALIGN short (contrast):** EMA9 lb3 −1.6 / lb5 −1.8; EMA20 ≈0; EMA50 +2.3/+3.6.

### Verdict: robust, not a 9/3 fluke.
- Counter-trend short clears baseline in **every** cell; +3–6pp across all fast-EMA
  configs. The original 9-EMA/3-bar pick is near-optimal but not special.
- The **counter−align spread** (direction-effect strength, baseline-independent)
  is ~8pp at EMA9, ~5–6pp at EMA20, and **collapses to ~0–1pp at EMA50**. That
  decay confirms the mechanism is "fade *short-term* thrust" — a slow EMA can't
  define the local strength being faded, so the effect should weaken, and does.
- Adding the gate on top of candidate-no-filter (52.3%): EMA9 rising → 55.9%
  (+3.6pp incremental); EMA falling → 48.0% (−4.3pp). The filter genuinely
  discriminates; it isn't just sub-sampling.
- Samples healthy (~570–720/cell).

### Recommended filter setting
**Filter EMA 9 (or 20), slope lookback 3–5 bars, require RISING for shorts.**

### Still the decisive gate: holdout + trade model.
All edge so far is bracket-race WR on data the rule was tuned on. Next: lock
**SHORT · str1.5 · floor150 · 9 EMA rising (lb3)**, apply next-bar entry / ATR
stop / R-target, split **2022–24 fit vs 2025–26 holdout** (no time gate). Positive
holdout expectancy = real setup; otherwise multiple-comparisons noise.

---

## Run 5 — EMA geometry: slope × location (2026-06-10)

**Config:** `geometry.ts`, candidate short, RTH, EMA9 slope-lb3. Tested whether
the flip bar TOUCHING the EMA (straddle: low≤EMA≤high) matters vs just position.
Baseline 49.6%, no-filter candidate 52.3%. Cells = WR / edge(pp) / n:

| slope \ loc | above-EMA | straddle | below-EMA | ALL(slope) |
|---|---|---|---|---|
| RISING  | **57.5 +7.9 (414)** | 53.7 +4.0 (288) | — (0) | 55.9 +6.3 (702) |
| FALLING | — (3) | 45.4 −4.2 (362) | 52.5 +2.9 (243) | 48.0 −1.6 (608) |
| ALL(loc)| **57.1 +7.5 (417)** | 49.1 −0.5 (650) | 52.5 +2.9 (243) | 52.3 +2.6 (1310) |

### Verdict: TOUCH is not the edge — extension ABOVE the EMA is.
- Best cell = **bar entirely above a RISING 9 EMA: 57.5% (+7.9pp), n=414.**
- Straddle/touch ≈ baseline (loc marginal 49.1%, −0.5pp). Tagging the EMA adds
  nothing; within rising-EMA, above (57.5) beats touch (53.7) by ~4pp.
- Reframes the setup as **fade-an-overextension**: short delta-exhaustion when
  price is stretched ABOVE its rising mean, not on a pullback to it.
- Collinearity caveat: above-EMA ≈ rising-EMA (414/417 overlap). Slope still
  carries independent info (straddle row: rising 53.7 vs falling 45.4 = +8pp).

### ⚠️ Overfitting watch
We have now made FIVE in-sample refinements (short-only → str1.5/floor150 →
counter-EMA → above-EMA). Each lifts in-sample WR but compounds
multiple-comparisons risk, and n is down to ~414. **No further slicing before a
holdout.** Lock the rule and validate out-of-sample next.

---

## Run 6 — DECISIVE holdout + trade model (2026-06-10)

**Rule (locked):** SHORT · str1.5 · floor150 · flip bar entirely above a RISING
9 EMA (lb3). **Model:** next-bar-open entry, ATR stop, fixed-R target,
force-flatten at RTH close. Split FIT 2022–24 (n=284) vs HOLDOUT 2025–26 (n=101).
`holdout.ts`. ~1.3 trades/day.

| stop/target | FIT avgR | FIT PF | HOLD avgR | HOLD PF |
|---|---|---|---|---|
| 1.0 / 1.5R | +0.190 | 1.36 | **+0.089** | 1.16 |
| 1.0 / 2R   | +0.270 | 1.47 | **+0.069** | 1.11 |
| 1.0 / 3R   | +0.277 | 1.41 | −0.050 | 0.94 |
| 1.5 / 1.5R | +0.160 | 1.30 | −0.058 | 0.91 |
| 1.5 / 2R   | +0.144 | 1.24 | −0.108 | 0.85 |
| 1.5 / 3R   | +0.177 | 1.26 | −0.072 | 0.91 |

### VERDICT: FAIL (fragile / overfit). Not tradeable as-is.
- FIT positive on all 6 combos (PF 1.24–1.47); HOLDOUT positive on only **2 of 6**
  (both tight-stop), and weakly (avgR ≤0.09, PF ≤1.16). ~75% of expectancy lost
  out-of-sample (target-2R: 0.270 → 0.069; WR 42.3% → 35.6%).
- The fit-window edge was largely the residue of 5 in-sample refinements. The
  holdout caught it — exactly what the discipline is for.
- **Costs not included.** PF 1.1–1.16 before commissions/slippage almost
  certainly drops below 1.0 net on NQ. The survivors are also the tight-stop
  configs most flattered by noise and most hurt by per-trade cost.

### Conclusion
Delta Unwind Stars on **NQ 1-minute** does not yield a robust, tradeable edge —
default OR optimized. There is a faint exhaustion/mean-reversion tilt (fade a
short delta-flip when price is stretched above a rising 9 EMA) that shows
in-sample and flickers in the tight-stop holdout, but not strongly enough to
trade after costs. **Recommend: shelve for 1m NQ.**

---

## Run 7 — flip vs the user's actual trades (2026-06-11)

**Not a backtest** — observational study of 915 real MNQ Tradezella trades
(2025-06 → 2026-04) against NQ tick-delta. `trade-flip.ts`. Flip = study signal
(default params) in the 5 completed 1m bars before entry. All 915 mapped, 0 gaps.

| bucket | n | win% | avg$ | avgPts | avgRR |
|---|---|---|---|---|---|
| ALL | 915 | 35.8 | 22.36 | 1.41 | 0.41 |
| NO flip | 761 | 35.0 | 18.01 | 1.20 | 0.40 |
| ANY flip | 154 | 40.3 | 43.88 | 2.48 | 0.48 |
| aligned flip | 100 | 37.0 | 25.40 | 1.19 | 0.35 |
| **opposing flip** | 67 | **43.3** | **70.71** | **4.24** | **0.64** |

### Finding: the flip is a FADE marker, not confirmation.
- Recent flip → ~2.4× avg$ vs quiet tape (flips mark active order flow).
- Aligned flip (same dir as trade) ≈ baseline — confirmation carries no edge.
- **Opposing flip (against the trade) = best trades** (avg$ 70.71, win% 43.3,
  RR 0.64); 67 trades = 70% of all with-flip profit. The user fades fresh flips well.

### Caveats
- Observational on the user's own discretionary entries/management — reflects
  flip-as-context, NOT a standalone edge (cf. Run 6, where the flip failed as a
  system). Different, fairer question.
- NQ delta used as proxy for the MNQ footprint actually charted (MNQ data had
  36% front-month gaps). Same market, directionally valid, not bit-identical.

### Window robustness check (±5m vs 5m-before)
Widening to ±5m (adds entry minute + 5 after) nearly doubled the opposing sample
and the edge HELD — strongest evidence in the session:

| bucket | 5m before | ±5m |
|---|---|---|
| OPPOSING | n=67 · 43.3% · $71 · RR 0.64 | n=130 · 42.3% · $60 · RR 0.79 |
| aligned | n=100 · 37.0% · $25 · RR 0.35 | n=173 · 35.3% · $21 · RR 0.34 |
| NO flip | n=761 · 35.0% · $18 | n=649 · 35.1% · $18 |

- Opposing edge robust to doubling n. win% (+6.5pp) and RR (0.79 vs 0.41 baseline)
  corroborate avg$ → NOT an outlier artifact (clears the n=67 concern).
- Aligned = baseline in BOTH windows (confirmed null).
- Before-only is both actionable AND strongest per-trade — ideal.

### Side split CORRECTS the "opposing" read — it's flip DIRECTION, not alignment
Splitting by trade side (prior-5m, RR shown — outlier-robust):

| | LONG trade | SHORT trade |
|---|---|---|
| bullish(long) flip | aligned n=46 · 45.7% · RR 0.66 | opposing n=43 · 46.5% · RR 0.95 |
| bearish(short) flip | opposing n=24 · 37.5% · RR 0.20 | aligned n=54 · 29.6% · RR 0.10 |

- The diagonal shows the real variable is the **flip's direction**, not its
  alignment: a **bullish flip near entry → good trades both ways** (RR 0.66/0.95);
  a **bearish flip → poor both ways** (RR 0.20/0.10).
- The Run-7 "opposing = edge" claim was an ARTIFACT of pooling: aggregate
  "opposing" was mostly short-trades-after-bullish-flips; "aligned" cancelled
  good-longs vs bad-shorts. Corrected: bullish flip = green light, bearish = red.
- Collapsed: bullish flip (n=89) ~46% / $72 / RR ~0.8; no flip (761) 35% / $18 /
  0.40; bearish flip (78) ~32% / $11 / RR ~0.15. Fits the 2025–26 NQ uptrend.

### By setup (prior-5m): flip-context helps real setups; the leak is structure
| setup | n | total$ | flip effect |
|---|---|---|---|
| break & retest | 257 | +16,804 | helps (ANY $109 vs no $54) |
| supply & demand | 158 | +11,378 | helps ($122 vs $65) |
| lvn rejection | 50 | +3,487 | helps ($184 vs $38) |
| IB fade-back | 42 | +3,203 | HURTS ($-10 vs $103, n=10) |
| discretionary | 187 | −2,067 | losing bucket |
| (no setup) | 239 | −7,501 | losing bucket |

- **Biggest P&L finding (not flip-related): untagged "(no setup)" + "discretionary"
  = −$9,568 over 426 trades (47% of activity), ~26% win. The four named setups
  made ~+$35k. The unstructured trades are the leak.**
- Bullish-flip context improves the genuine setups; IB fade is the exception
  (better without a flip, n=10 — thin).
- Many setup×opposing cells are tiny (S&D opp n=5, lvn opp n=7) — do not over-read.

### If pursued further (lower priority)
- Different instrument/timeframe (the study is bar-agnostic; range/volume bars or
  a higher TF change delta accumulation entirely — never tested).
- Fidelity cross-check vs live Numbers Bars (still outstanding) before any retest.
- Paper-forward the tight-stop short on live data if you want to watch it, but
  treat the prior as "no edge" given the holdout.
