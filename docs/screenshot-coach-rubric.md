# Screenshot coach — rubric (v3: the coach's own read, verified)

Per-trade "tape vs your read". Since 2026-08-16 (§3a): the coach reads the
screenshot BLIND, verifies every element of that read against the bar record,
and speaks only what survives; the trader's tags are a low-weight reference
checked afterwards. Sections 1–3 below describe the earlier claim-first
framing and the bar-side axes, which the verified read still uses as its
truth. Owner-only for v1.

Status: rubric agreed, harness built and validated against 154 real trades.
**Not scoreable yet** — see [Blocked on labels](#blocked-on-labels).

Harness: `scripts/screenshot-coach-harness.ts` → `evals/screenshot-coach/*.jsonl`.

---

## 1. The framing that everything else follows from

**The screenshot is not a claim.** A Sierra 2-pane capture is evidence of the
situation on screen at the decision — it can't be right or wrong. What can
diverge from the tape is the *stated* read: the setup tags, the confluence
tags, and the `notes` text. So the model is given both blocks and may only ever
quote numbers from `truth`.

**The image is never trusted unverified — on categories or on prices.**
Superseded framing was "never ask the image for a price". The trader's
correction (2026-08-16): any price the image proposes can be *looked up* — the
1-minute bar record knows every visible bar's range at every visible minute,
the harness knows every session level's exact price, and the DB knows the
fill and bracket. So the rule became: the image may propose a price only as
an anchored read (with its minute, or as a labelled level, or as a bracket
tag), every one is checked, and only confirmed reads may be spoken. See §3a
for the measured reliability per kind of read.

**Every number in the output is either from bars or a confirmed image read.**
If a fact can't be checked, the coach doesn't get to state it.

---

## 2. The gate: frame integrity

Runs before any axis. If it fails, the whole trade returns `insufficient` and no
axis is graded.

**The metadata cannot answer this, and that is a measured finding.** Storage
upload times and the 13-digit epoch in the filename are both WRITE times, and
they arrive in batches: five 2026-08-14 trades with entries spread over 16
minutes carry file epochs landing within seconds of each other. OBS rows are
written anywhere from 14 minutes to 26 hours after the entry.

A write time bounds the capture in one direction only — `capture ≤ write`. And
**OBS auto-captures fire at entry** (owner-confirmed 2026-08-16; the recording
holds the exit but the still is the entry frame), which is proof by
construction, independent of any timestamp. So:

| Evidence | Verdict |
|---|---|
| OBS capture | **proven pre-exit** (43) |
| manual save written before the exit | **proven pre-exit** (14) |
| manual save written after | **unknown** (97) — NOT "hindsight" |

**What the gate is for — revised.** It was framed as a hindsight-image
detector. That over-weighted it: the coach never takes a number from the
image, every axis compares tags to bars, and the truth block already
separates pre-entry facts from post-exit ones — so an image showing bars past
the exit cannot contaminate a verdict. What remains is a **usability** check:
is this a chart of this trade with a visible entry marker. Calibrated on the
14 write-time controls (0/14 false alarms across two runs, after a v1 that
mistook open-P&L readouts for closed trades). No negative control exists and,
given the revised purpose, none is needed.

Population: 43 OBS auto-captures, 111 manual saves, 154/154 with an image.

### Calibration (measured, `scripts/screenshot-coach-frame-gate.ts`)

The 14 proven-pre-exit trades are a **positive control**: the model must not
report a finished trade on an image that provably predates its exit. Run on
`claude-sonnet-5` (first Sonnet with 2576px vision), `effort: low`, structured
output, prompt asks only ordinal facts anchored on the entry marker — never a
price.

| Pass | Control false alarms | What changed |
|---|---|---|
| v1 | **4 / 14** | Every false alarm cited a P&L readout as proof of completion. Sierra paints the *open* P&L on the live position line — a dollar figure is what an open trade looks like. Definitional bug in the prompt, not a vision failure. |
| v2 | **0 / 14** (held across two runs) | Prompt states P&L is not evidence; completion needs entry + a separate exit marker or a flat tag. On 16 unknowns (8 OBS / 8 manual): 15 "no", 1 "unknown", zero "yes". |

Two limits, so this is not over-read:

- **No negative control.** Zero false alarms proves the gate does not *invent*
  a finished trade. It cannot prove the gate would *catch* one — no screenshot
  in the set is provably post-exit. v1→v2 fixed over-claiming; whether v2 now
  under-claims is unmeasured. The 8 OBS shots all reading "not completed" fits
  both "OBS captures at entry" and "the model can't see completion"; only a
  known-completed screenshot separates them.
- **Jitter at `effort: low`.** Between the two v2 runs, entry-marker visibility
  flipped on 2/14 controls and `chart_right_of_entry` on 3/14. Nothing crossed
  into "completed=yes", so the safety property is stable and the descriptive
  fields are not. Production: higher effort or two votes.

Descriptively (no ground truth): entry marker visible on 86–88% regardless of
source, always at *medium* confidence, never high; price scale, footprint pane
and drawn annotations read as present on 100% — the layout is uniform enough
that those fields don't discriminate. Footprint reads are stored unscored in
`frame-gate-reads.jsonl` for the axis-3 confirmation decision.

---

## 3. The axes

Each returns `agree` / `diverge` / `n/a`. Never a score, never a /5 — rails are
per-trader. `n/a` is a correct answer, not a failure, and its rate is a
first-class metric.

### Axis 1 — Entry location vs reference level

Truth: distance from the entry bar to the nearest of IB high/low, PDH/PDL,
ON high/low. **Measured as a fraction of the day's ADR, not in 1-minute ATR** —
at ~1.5 pts on ES, 1-min ATR makes an ordinary 13-point gap read as nine ATR.
1-min ATR stays the unit for excursion, where it belongs.

VWAP is excluded from "nearest" and reported separately as a side. Price
oscillates across VWAP by construction, so including it made VWAP the nearest
level on 58 of 154 trades and buried the structural level the trade was about.

| Band | Threshold | Owner's set |
|---|---|---|
| at level | ≤ 0.05 ADR | 53 |
| near | ≤ 0.15 ADR | 34 |
| in space | > 0.15 ADR | 47 |

Also carried: `touches_before_entry` — how many times price visited that level
earlier in the SAME session, with hysteresis (price must clear by a full ATR
before the next visit counts). Median 3, p75 6, max 13. First touch and sixth
touch are different trades.

**Diverges when** a setup tag implies a level trade and the entry sat in space.

**`n/a` on ≥20 of 154 (13%)** — those days have no usable `market_context`: the
row is for a different instrument (MES traded, NQ context stored) or the symbol
is parse garbage. See [Data problems found](#5-data-problems-found).

### Axis 2 — Direction vs structure

Truth: `trades.structure_5m_alignment` (following 67 / fading 48 / neutral 7 /
null 32).

**Diverges when** the trade faded a trending 5m structure with no fade tag on
it, or claimed a fade while following.

`n/a` on the 32 rows with a null alignment.

### Axis 3 — Chase / timing

Truth: how far the leg had already run when the entry printed — from the
opposite extreme of the prior 30 bars to the entry bar, in 1-min ATR (this axis
is about the immediate leg, so the fine unit is right here).

| Band | Threshold | Owner's set (percentile) |
|---|---|---|
| early | ≤ 1.0 ATR | p25 = 0.73 |
| mid | 1.0 – 3.0 ATR | p50 = 1.33 |
| extended | > 3.0 ATR | p75 = 2.28, max 9.84 |

**Diverges when** the entry came late into an already-extended leg while the
claim describes a fresh entry.

This axis replaced "confirmation state". Absorption and delta live in the
footprint pane, which is exactly where vision is least reliable — so
confirmation is **collected unscored** in v1 (does the footprint pane appear,
is it annotated) purely to measure whether those reads are reliable enough to
promote to a real axis later.

### Axis 4 — Exit vs plan

Truth: MFE/MAE in ATR, capture % (clamped ≤100), exit vs logged stop/TP1,
R multiple, and the 15-min post-exit excursion in ATR.

Judged against the trader's exit **style**, never against a fixed target — for a
scale-out trader low capture on most trades is by design, not a leak. Capture
reads p50 0% / p75 55% across the set precisely because losers and scratches are
in the denominator; it is only meaningful on move-trades.

**Diverges when** the exit contradicts the stated management tag — held past a
stated TP1, or cut a runner the plan said to hold.

Coverage: stop logged on 151/154, capture computable on 149/154.

---

## 3a. The coach (`scripts/screenshot-coach-read.ts`) — its own read, verified

**Redirected 2026-08-16.** The first grader treated the trader's tags as the
claim and only asked whether the bars supported it — so an untagged trade got
nothing, and the trader's view framed every verdict. The trader's direction:
the coach should look at the image and form its OWN read, bump that against
the SCID/bar truth to verify itself, and treat the tags as a low-weight
reference to be checked, never as the frame. That grader is retired
(`screenshot-coach-grade.ts`, in git history).

Three passes per trade, two model calls (`claude-sonnet-5`, effort medium):

1. **Blind read** — image only; no tags, no note, no bars. Categorical: which
   labelled level the entry sits at, which way the 5m structure runs,
   with/against, fresh/extended, trade type, footprint. Plus **anchored price
   reads** — position line, bracket-order tags, axis level labels, drawn
   levels, and any specific bar extreme *with its x-axis minute*.
2. **Verify** — code, no model. Each categorical element is mapped onto the
   harness truth: confirmed / contradicted / partial / unverifiable. Each
   price read is *looked up*: position/stop/target against the recorded
   fills; level labels against the known session-level prices; bar extremes
   against the 1-minute bar at that minute (inside its range or not); drawn
   levels range-checked and described by distance-from-entry and touch
   count. Contract-vs-continuous basis is applied before any bar comparison.
3. **Write-up** — image + blind read + verification + truth + tags marked
   REFERENCE ONLY. Contradicted elements are dropped, not hedged, and not
   narrated ("not a short as first read" is banned). Numbers only from truth
   or confirmed price reads. One line on the tags, and only on bar-judgeable
   elements — order-flow tags the bars can't see are "not checkable", not a
   disagreement. No suggestions: the "TapeScore suggested" lines were being
   manufactured from the band vocabulary and contradicted each other across
   trades, so they are gone.

**Sierra conventions the blind read must know** (found by looking at the
images the model got wrong): the position line reads `+N | P/L` (long) or
`-N | P/L` (short); the order tags are the *bracket* and carry the OPPOSITE
side letter (a long is bracketed by two `S|…` orders); `IBL -100%` /
`IBH +50%` are IB *extension* levels, not IBL/IBH. Before this, direction
read wrong 4/8; after, 7/7.

**Measured on 7–8 trades per pass (small n, directional):**

| image read | held vs bars |
|---|---|
| direction | 7/7 (canary — the fill knows anyway) |
| level in play | 3/5 judged + 2 partial |
| with/against 5m | 3/3 judged |
| timing fresh/extended | 3/4 judged (was 1/5 before the price-read change) |
| footprint | unverifiable by construction; claimed on 2/7 after calibration (was 8/8) |
| price: position line | 6/7 exact |
| price: stop tag / target tag | 5/7 / 7/8 exact |
| price: axis level label | 6/13 exact |

Every miss above was caught and dropped before the coach spoke. Reading the
price on the position line also made the model *find* the position line —
the categorical reads sharpened as a side-effect of anchoring.

Honesty checks (deterministic): fabricated numbers — every number in the
prose must exist in truth, a confirmed price read, the verification text, or
the trader's own tag names, with rounding tolerance; and every contradicted
element must appear in the write-up's own `dropped` list. Zero real
fabrications across three v2/v3 passes; the checker's own false positives
("5m", "0.5 ATR", "IBL -50%", "20 EMA", 92 for 92.3%) were each fixed.

Harness additions for this: IB extension levels (±50/±100%) and 1-minute
EMA 9/20 at the entry bar in the truth; moving lines (VWAP, EMAs) excluded
from "nearest" and reported on the side.

## 4. Output contract

Per axis: a verdict and **one factual sentence containing numbers taken from
`truth`**. No causal stories ("you got scared"), no invented lessons. Suggestions
are phrased "TapeScore suggested". Locked identity: carbon + scoreboard-blue,
finding-first.

Cached to `trades.review_json.tape_read` by read-merge — `verdict` is the
trader's and must never be clobbered. The route at
`src/app/api/trades/[id]/review/route.ts` already merges this way, and
`TradeReview.tape_read` is already reserved in `src/lib/supabase/types.ts`.

---

## 4a. Instrument coverage (NQ and ES)

The owner trades both. Bars, ATR, ADR and excursion are fully instrument-correct
on each; reference levels are weaker on ES purely because the context data is.

| | ES (41) | NQ (113) |
|---|---|---|
| bar feed resolved | `ES` | `NQ` |
| entry price vs entry bar (p50) | 7759 / 7740 | 29838 / 29848 |
| roll basis p50 | 0.75 pts | 5.5 pts |
| ATR p50 | 2.43 | 21.74 |
| ADR p50 | 86.8 | 435.0 |
| bar strip present | 40/41 | 113/113 |
| reference level resolved | 29/41 | 105/113 |

Verified by an explicit contamination check — each trade's 1-min ATR as a
fraction of its own entry price, flagged outside the band plausible for either
product. Zero hits, so no ES trade carries an NQ-scale ATR. Worth re-running
after any change to `backfill-entry-metrics.ts`, whose sources are NQ-only.

The ES level gap is a data gap: `market_context` holds 455 NQ rows against 10
ES rows, so on 10 of 41 ES trades the day's only context row is NQ and the
scale guard drops it. Without the guard those entries would have been compared
to levels ~22,000 points away.

## 5. Data problems found

Surfaced by building the harness. Items 1–2 are FIXED (2026-08-16) by
`scripts/backfill-market-context-es.ts` (dry-run by default, `--apply` to
write; owner-scoped; a row per traded (day, instrument) in both directions,
plus garbage-symbol relabel by inferring the instrument from level values).
Applied in two passes: 8 ES rows + 18 relabels, then 2 NQ rows (a
never-populated day, and an ES-prepped day with MNQ trades). Result:
reference-level coverage **134 → 153 of 154**; zero garbage symbols remain
in the table. The one left is item 3. Items 3–5 are guarded, not fixed.

The second pass also exposed a harness bug: a day-keyed fallback let an ES
context row serve an NQ trade — levels dropped by the scale guard, but its
ADR still borrowed as the denominator, and `context_matched` reading true
because VWAP (from the trade's own bars) always survives. Now a strict
(day, instrument) match with no fallback.

1. **`market_context.symbol` is polluted.** Valid values are `NQ` (455 rows) and
   `ES` (10). The rest are parse garbage from the screenshot-extraction path:
   `"5"`, `"Trade"`, `"S@30805.00"`, `"5028561.00"`, `"5@30725.00"`.
2. **Instrument mismatch on MES days.** Several days where the trader traded MES
   carry only an NQ context row, so the levels are for the wrong product.
   Dropped by a 20%-of-price scale guard rather than compared.
3. **One trade row carries an NQ-scale entry under an `MESU6.CME` symbol**
   (2026-07-21, entry 29284 against ES bars at ~7546). Its bar-derived fields
   are nulled.
4. **Two rows have excursions that don't bracket their own entry** (a −0.75pt
   "MFE"). Nulled rather than reported negative.
5. **Contract vs continuous roll basis.** `ohlcv_bars` is a continuous
   front-month series; trades carry `MNQM6`-style contracts. Subtracting one
   from the other doesn't cancel — a 2026-06-15 MNQM6 long read as a −288pt
   chase. Everything bar-derived is now anchored on the entry bar so the basis
   cancels, the same way the tick excursion fix anchors on entry. Residual basis
   is p50 4 pts.

---

## Blocked on labels

**There are zero verdicts on prod — for any user.** The migration is applied and
the query is correct; the Game film UI has simply never been clicked through.
228 owner trades, 155 with screenshots, 0 labelled.

Step 4 (scoring) needs them. Until then `--unlabelled` builds the truth half
against every screenshot trade, which is what validated everything above.

When labels exist, scoring is:

- **Primary:** does "diverge on ≥1 axis" predict the trader's `mistake`?
- **Baseline ablation:** a P&L-sign-only predictor, run alongside. The verdicts
  are outcome-contaminated — losers get called mistakes — so a coach that
  doesn't beat this baseline has learned nothing about the tape.
- **Over-claiming:** divergences whose stated number disagrees with a
  deterministic recompute, plus any non-`n/a` axis on a gated frame.
- **Blind spots:** trades labelled `mistake` where every axis said agree. Those
  notes, clustered, are the list of missing axes.

Note the useful cell is **diverge on a trade the trader called good**. High
agreement means the coach is redundant with the trader.
