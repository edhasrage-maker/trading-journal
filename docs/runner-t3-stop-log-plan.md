# T3 "Stop to breakeven only after TP1": can Sierra's log grade it?

Investigation only, 2026-10-15. Nothing is built, nothing written to either database.

## Answer

**Yes, for Sierra users whose import includes order rows, not just fills.** Sierra writes down every
change to every stop order: the time, the new price, and whether you dragged it or Sierra moved it.
On the **25 runners tapescore.app grades since May** (your logged TP1), the log reads cleanly:

- **24 of 25** moved the stop to breakeven **after** TP1 filled, 4 to 70 seconds after (usually under 10).
- **1 of 25** never moved it to breakeven (May 29, explained below).
- **None** moved it before TP1.
- **With both of your calls applied** (breakeven = entry or better; never moved = pass), all 25 pass T3.

A wider check gave the same picture: 46 runners rebuilt straight from Sierra's files across all your -PRO accounts (TP1 = the first target order that filled where none was logged).
- **40** moved the stop after TP1.
- **5** never moved it (May 4, May 29, Jun 12, Jul 17, Aug 21).
- **1** was settled by decision 1 (Jul 21): under "entry or better" it passes. It isn't one of the site's 25.

Two things stand in the way today:

1. **Your daily exports have no order rows.** All 2025 and 2026 exports in `D:\SierraCharts\SavedTradeActivity` are fills only. The ones from 2023 to June 2024 include orders.
2. **The hosted site keeps no raw logs.** tapescore.app imports go through `/api/import-trades-csv`, which keeps fills and throws the file away. The `sc-logs` bucket is only written by the local-only `/api/import-sc-log`. So there is nothing on the hosted side to backfill from.

## What the log can and can't show

**Can show**
- Every stop order's price at every moment, to the second (Pacific time once converted).
- Who moved it: you (a drag on the chart) or Sierra (re-placed after the entry filled, followed a moved entry order, auto-trail).
- Which target and stop belong to which entry, since each entry has its own bracket. That separates scale-ins, which fills alone can't (see May 29 below).
- Sierra's automatic move-to-breakeven never fired on your trades since May. Every breakeven move was you dragging the stop.

**Can't show**
- Anything at all when the export is fills only.
- Why you moved it.
- Anything for NinjaTrader or generic CSV users. T3 stays "unknown" for them.
- **A fill Sierra never recorded.** On Aug 4 the runner's exit (3 at 7,749, 09:37) is in neither Sierra's own file nor its original export. You added that row by hand: the `.bak` copy lacks it, and its time is exactly 09:37:00.000. So stop history has to be attached to the trade TapeScore already has, by its entry order, never by rebuilding trades from the log. Rebuilding carried 3 phantom contracts into Aug 5 and merged two trades.

**Sierra's own daily files.** `D:\SierraCharts\TradeActivityLogs\*.data` has one file per account per day, back to December 2022, with everything in it. It's Sierra's own binary format, and I decoded it. Rebuilt from those files, your trades since May come out identical to TapeScore's importer on 540 of 543. The other 3 differ only where a position was still open at a file boundary.

## Checked against your trades

- **The site's 25 runners** (read-only look at your trades on tapescore.app, with your logged TP1):
  - Every one's entry order is in Sierra's log under the same ID the site stores, so each trade's stops can be found directly.
  - Table: `hosted_25_table.txt` in the session notes folder. Aug 5 shows "no log" there only because of the rebuild artifact above; read by its entry order, the stop went to 7,787.75 20 s after TP1.
- **The wider 46:** `runners_table.txt` in the same folder. Copies of a trade across accounts count once.

**"TP2 Breakeven" tags on the site: 5 of 6 agree.**
- Jun 18, Jun 24, Jun 26, Jul 1 and Jul 23: you dragged the stop to entry plus 1 point (4 ticks) 4 to 10 s after TP1, and the runner left on that stop.
- May 29 disagrees. TapeScore merged two shorts into one trade: 5 at 30,374, then 5 more at 30,360 while the runner was still on.
  - The runner's stop went to 30,380, which is not breakeven for either entry.
  - The runner was stopped out at 30,380 (6 points against the first entry).
  - The log is right here and the tag is looser.

**Your mockup examples all read as pass:**

| Trade | Stop to breakeven | After TP1 by |
|---|---|---|
| Oct 14 | 08:29:32 | 10 s |
| Sep 18 | 09:54:49 | 62 s |
| Jul 1 | 09:47:39 | 7 s |

**Independent check.** On 76 of 98 trades, the stop price logged on the trade exactly equals the log's stop within a minute of entry. The rest differ by later hand edits. So these are the right orders.


## Decisions (all made 2026-10-15)

1. **What counts as "stop at breakeven"?** **Decided 2026-10-15: at entry or better.** The stop counts as at breakeven only once it's at the entry price or in profit, so a stop still in loss is a tighter stop, not breakeven. That matches every breakeven stop you set since May: at entry or up to 8 ticks into profit, most often 4. It changes none of the site's 25 runners. The one case it settles is Jul 21 (MES long at 7,544). The stop was pulled to 7,543, 4 ticks in loss, 18 s before TP1; that reads as a tighter stop. It went to breakeven (7,544.25) 21 s after TP1, so it passes.
2. **The stop never went to breakeven: how does T3 grade it?** **Decided 2026-10-15: pass.** T3 only forbids moving the stop to breakeven before TP1; how the runner left is T2's job. Reason text, e.g. "Stop never moved to breakeven; it stayed at 30,389."
3. **How does the stop history get in?** **Decided 2026-10-15:**
   - **Going forward:** you export the Trade Activity Log with orders included, not fills only.
     - A day's file goes from about 10 KB to roughly 100 KB to 1.5 MB, under the 4 MB upload limit.
     - Longer exports get their stop moves pulled out in the browser before upload, the way "combine all accounts" already works.
   - **Backfill:** a one-off local run over your May to October trades, reading Sierra's own daily `.data` files.
     - Each trade's stops are matched by its entry order, which all 25 site runners have.
     - It runs dry first and shows what it would write. **It asks you before it writes anything to tapescore.app.**
   - The `.data` format is Sierra's own and undocumented, so it is used only for this backfill, not as an ongoing input.

## How it would be built (mockup first for the wording)

1. **Store:** `review_json.stops` on each trade, holding:
   - the stop at the entry fill;
   - then each change: time to the second, price, you or Sierra;
   - a fingerprint of the fill, so a re-import with different fills is read again.

   It's written the same careful way as the entry rules' `review_json.entry_ctx`, so no SQL migration on either database.
2. **Read:** the Sierra parser keeps the order rows for each trade's stops. This applies to both import routes, and the combine path does it in the browser.
   - Stops are found as the children of the trade's own entry orders (the ID in `sierra_trade_id`), not by re-walking positions.
3. **Grade:** `be_after_tp1` in `src/lib/runner-rules.ts` gives pass, fail or unknown, with reasons like:
   - "Stop to breakeven (30,215) at 09:47:39, 7 s after TP1 filled (09:47:32)."
   - "Stop to breakeven (7,543) at 11:44:37, 18 s before TP1 filled (11:44:55)."
   - "No stop history for this trade: import your Sierra log with orders included."
4. **Wire up:** day stats select `stops:review_json->stops`, the way they select `entry_ctx`. The rules signature includes any new setting.
5. **Screens:** only wording changes: the T3 reason, the Settings hint ("Read from your Sierra order log") and an import-page note for Sierra users.
6. **Order:** build after the structure-fields fix (branch `fix/structure-regime-hosted-import`) lands, because both change `/api/import-trades-csv`.

## Seen along the way (not proposed now)

- **T2 can misread a breakeven stop that slipped.** On May 14 at 09:34, the breakeven stop at 29,709 filled at 29,704.75. T2 reads that as "closed by hand"; the log knows it was the stop.
- **The stop at entry could fill in itself.** The log could fill the trade's stop price automatically on import.
