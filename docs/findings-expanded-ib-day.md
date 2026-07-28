# Finding — the Pt 23 day-character result was an import artifact; what survives after repair

**Date:** 2026-07-27 · **Scope:** Pt 24 Task A · **Data:** prod (`dmutgkycrjudfejswvhg`),
user `fa3fb352`, native `trades` ∪ `historical_trades`, joined to `market_context.ib_regime` /
`ib_size_band` by trading day.

> Read order matters here. §1–§2 diagnose a data defect. §3 repairs it. §4 is the
> **current** answer; the numbers in §1 no longer describe the database.

## 1. The claim under test

Pt 23 reported that on days whose Initial Balance is *expanded* relative to its own ATR
(IB ÷ meanHL10 ≥ 13), EV roughly halves — and that EV rose monotonically with absolute IB size:

| lens | bucket | n | EV | PF |
|---|---|---:|---:|---:|
| regime | chop | 1124 | $24.66 | 1.28 |
| regime | mid | 2640 | $23.97 | 1.30 |
| regime | **expanded** | **1053** | **$11.00** | **1.09** |
| size | small | 1602 | $11.37 | 1.12 |
| size | normal | 1941 | $23.09 | 1.27 |
| size | large | 1188 | $30.27 | 1.35 |

The stated puzzle was that the two lenses disagreed: a big first hour is good, but one that is
big *relative to its own ATR* is bad.

## 2. Neither result was about trading

**41% of the "expanded" sample was one import blob.** `2025-08-27` carried **430 trades and
−$8,715**, against an expanded-bucket total of +$11,585. Every other day in the journal has a
median of 8 trades.

It was not a trading day:

- All 430 rows shared one `created_at` (`2026-05-21T20:53:38`) — a single import action.
- Their `entry_time` values spanned **57 distinct PT dates, 2025-05-27 → 2025-08-27**. Only
  **4 rows** actually happened on 2025-08-27 (net −$87).
- Entries landed at every hour of the clock (00:20 → 23:59 PT), which no RTH session produces.
- `sierra_trade_id` is `${account}:${firstOpenIOID}` (`src/lib/sc-importer.ts:337`), and the
  blob held **51 distinct accounts** — an unfiltered copy-trading log.

This is the open thread in `CLAUDE.md`: *"Importer multi-day-log merge — `/api/import-sc-log`
pins ALL parsed trades to the single form `date`/`day.id`."* It is not pending-and-theoretical;
it had already fired. A second blob, `2023-06-12`, held 397 rows over 18 dates from a single
account.

The 2025-08-27 blob landed on a genuinely expanded, genuinely small-IB day (`ib_size` 119,
`meanhl10` 8.125, ratio **14.65**; `ib_vs_10d_avg` **0.64**), so three months of multi-account
trading — including its worst sessions — was attributed to one `expanded × small` cell. That is
the entire origin of both Pt 23 headlines.

**Journal-wide scale.** A trading day here is the PT calendar day (`sessionUtcWindow`,
`src/lib/pt-time.ts`). Counting rows more than one day from their parent — the ±1-day
population is left out as plausibly deliberate:

- **1,173 of 5,754 native trades (20%) were filed under the wrong day**, across **37 trading days**.
- Two blobs dominate: `2025-08-27` (419) and `2023-06-12` (385); then a long tail —
  `2025-06-30` (53), `2024-02-20` (35), `2023-08-23` (33), …
- Only 26 had an exact twin under the correct day, so this was mis-attribution, not
  double-counting. **Totals were never wrong** (the misfiled rows are −$1,889 of $98,487);
  every *per-day* and *per-condition* aggregate was.

An important non-finding: the journal is **legitimately multi-account** (326 single-account
days, 87 two-account, a tail to 8 — the trader rotates prop-firm accounts, each covering a date
window). So the blob's rows are real, distinct fills with unique `sierra_trade_id`s. Only the
parent was wrong. That is what made repair, rather than deletion, the correct move.

## 3. The repair

`scripts/repair-misdated-trades.ts` (dry-run by default, `--apply` to write, backup JSON of
every move written first). Applied to prod 2026-07-27:

- **1,173 trades re-parented** into 131 trading days
- **49 `trading_days` rows created** for dates the journal had never recorded
- verification pass: **0 rows still more than one day off**
- `condition_lookup` refreshed afterwards (236 rows, 6,669 trades aggregated)
- `trading_days.stats_json` self-heals — `trg_trades_invalidate_day_stats` nulls the cache on
  both the old and the new parent

## 4. The read after repair — this is the current answer

Re-attributing is not the same as dropping. Most of the misfiled rows landed on days that
*do* have `market_context`, so they are now classified under their true day's character and the
classified sample **grew** from 4,817 to 4,706 usable rows on corrected parents.

| lens | bucket | n | WR | EV | PF |
|---|---|---:|---:|---:|---:|
| — | all classified | 4706 | 36.4% | $22.67 | 1.26 |
| regime | chop | 1196 | 35.4% | **$11.79** | 1.12 |
| regime | mid | 2800 | 37.5% | $29.37 | 1.35 |
| regime | expanded | 710 | 33.5% | $14.61 | 1.17 |
| size | small | 1207 | 36.4% | $20.70 | 1.27 |
| size | normal | 2176 | 35.3% | $25.16 | 1.27 |
| size | large | 1224 | 36.8% | $19.51 | 1.21 |

**Both Pt 23 headlines are dead, but not in the way a first pass suggested.**

1. **The size gradient is gone outright.** small $20.70 · normal $25.16 · large $19.51 — an
   inverted-U inside a $6 band. There is no "bigger IB is better" effect. Pt 23's monotone ramp
   was the blob sitting in the `small` band.
2. **The regime ranking changed, and it is not stable.** Expanded is no longer worst — *chop*
   is. But neither separation survives a concentration check:

   | regime | days | trades/day | dayWR | median day | trade EV | EV, worst+best day trimmed |
   |---|---:|---:|---:|---:|---:|---:|
   | chop | 120 | 10.0 | 67.5% | +$375 | $11.79 | **$15.94** |
   | mid | 263 | 10.6 | 66.5% | +$369 | $29.37 | **$28.88** |
   | expanded | 66 | 10.8 | **71.2%** | **+$391** | $14.61 | **$22.37** |

   Expanded's low trade-level EV is one session: **2025-05-29, −$7,601 over 30 trades**, against
   an expanded-bucket net of $10,376. Chop's is **2025-06-10, −$6,643 over 19 trades**. Drop one
   day at each end of every regime and the spread collapses to $15.94 / $28.88 / $22.37 — and at
   day level, weighting each session equally, **expanded has the *best* day win rate (71.2%) and
   the *best* median day (+$391)**.
3. **So the "regime vs size disagreement" never existed.** There is nothing to reconcile. The
   honest summary of the IB day-character lens is: *it does not sort this trader's P&L by
   itself.* mid runs a bit better than chop and expanded, on 263 days versus 120 and 66, and
   most of the apparent gap between the other two is single-session noise.

## 5. What does survive — three sub-findings, consistent across both the drop-based and the re-attributed analysis

These are the slices the task asked for. Each held its sign and rough magnitude whether the
misfiled rows were dropped or re-parented, which is the only robustness test available here.

- **Expanded-day shorts are a genuine leak.** EV **−$6.73** (n=324, PF 0.92) vs expanded longs
  **+$32.53** (n=386, PF 1.39). Everywhere else the ordering is the other way round (rest shorts
  +$25.51, rest longs +$23.24). Under the drop-based cut it was +$9.18 vs +$46.52 — same sign,
  same direction of the gap. Spread over 48 expanded days, 23 of them losing on the short side,
  so it is not one blowup.
- **On expanded days, follow beats fade by much more than usual.** follow **+$41.88** (n=274,
  PF 1.53) · fade **−$1.15** (n=157, PF 0.99) · neutral **−$7.94** (n=275). Elsewhere the same
  split is +$31.54 / +$24.69. Fading an expanded IB is the specific thing that does not work —
  which is exactly what a "trend day" read predicts, and is the direct answer to Task C.
- **Expanded days are front-loaded and then leak all afternoon.** 08:00–09:00 PT **+$59.39**
  (n=92, **PF 2.43**), then 09:00–10:00 **−$5.43**, 10:00–11:00 +$9.89, 11:00–12:00 +$9.75 —
  against the rest of the book running +$6.57 / +$36.58 / +$33.99 in those same windows. The
  money is made in the first ninety minutes and given back for the rest of the session. This is
  the single most actionable pattern in the study.

One more, on the now-weakest bucket: **chop days with neutral 5m structure are dead money** —
EV −$1.68 over n=479. Chop is the one regime where fade slightly *beats* follow ($23.33 vs
$19.67), consistent with a range read.

## 6. Answering the specific questions asked

- **Fewer winners, smaller winners, or bigger losers on expanded days?** Fewer winners, and only
  slightly: WR 33.5% vs 37.1% elsewhere. Average win $298 vs $308 and average loss $129 vs $144 —
  both marginally *better* than the rest of the book. There is no severity story: native-trade
  loss magnitudes are indistinguishable (median 20.0 pts/contract on expanded vs 20.1 elsewhere,
  p95 41.0 vs 39.7) and median MAE is *lower* (8.3 pts vs 9.5). The regime-level EV difference is
  a hit-rate difference concentrated in shorts and fades, not a risk-control difference.
- **Setups.** Nothing survives. 942 of the 1,053 pre-repair expanded trades carried no setup tag
  (the blobs are untagged), so the pre-repair setup table was reading the defect. Post-repair no
  setup reaches n=30 within the expanded bucket.
- **R-multiple.** Cannot be built for the native side: `trades.stop_price` is populated on 136 of
  7,857 rows, and only `historical_trades` carries `realized_rr` (n=79 on expanded). Stop-outs
  were approached through per-contract loss magnitude instead (above); the distributions match
  between expanded and the rest, so nothing is hiding there.
- **Mistake tagging.** 5.0% of pre-repair expanded trades were mistake-tagged vs 8.4% elsewhere
  — again a blob effect, not a behavioral read.

## 7. Known gaps

- **177 of 639 trading days still have no `market_context` row**, 49 of them newly created by the
  repair (17 are 2025-or-later: 2025-03-28, 2025-05-10, 2025-06-11, 2025-06-17/18, 2025-07-02/03,
  2025-07-18/20/23/26, 2025-08-10/11/12, 2025-11-22, 2026-04-18). Trades on those days sit out
  the day-character buckets entirely rather than being misclassified. Filling them means running
  the bars→market-context path for those dates, then `scripts/backfill-ib-day-type.ts` and a
  lookup refresh.
- **The importer bug itself is unfixed.** The repair cleans history; the next multi-day log will
  re-create it. The real fix is the one CLAUDE.md describes: group parsed rows by PT entry date,
  ensure a `trading_day` per date, and loop the 4b–4e pipeline per date.
- **±1-day offsets (502 rows over 79 days) were deliberately left alone.** They are plausibly
  intentional and no import blob is one day off, but they have not been audited.
