# Post-Exit Verdict Column — Spec (Pt 16, item 6)

Replaces the raw signed-number post-exit column in `TradeList.tsx` with a
plain-language verdict chip. This is the differentiator "we grade your
decisions, not your P&L" made literal at the row level.

## Inputs available per trade

From `postExitByTradeId[t.id]` (`PostExitData`, `src/lib/atr.ts`, 30-min window):
- `continued_favorable_pts` (`cont`) — how much further the market ran in the
  trade's direction after exit = money left on the table.
- `continued_against_pts` (`against`) — how much it reversed against the trade
  direction after exit = adverse move you were out of.
- `full_window` — false when bars ran out (recent trade / EOD).

From the trade row:
- `direction` (long/short), `pnl` (win/loss sign), `entry_price`, `exit_price`,
  `stop_price`, `quantity`, `symbol` → `symbolToMultiplier`.
- `capturedPts` = direction-adjusted `exit − entry`.
- `isGiveBackTrade(t)` — loser that reached ≥1R MFE before reversing.
- `mfeMaePoints(t).mfe` — peak favorable excursion (points).

## Sizing denominator (materiality)

Everything is judged in **R** when a stop exists, else falls back:
1. `riskPts = |entry − stop|` → `contR = cont/riskPts`, `againstR = against/riskPts`.
2. No stop but `entry_atr_1m` present → threshold = 1× entry ATR (report in pts).
3. Neither → raw points, threshold 3 pts (matches the current code's `cont>=3`).

**Material** = ≥ **0.5R** (or ≥1× ATR / ≥3 pts on the fallbacks). Below that the
post-exit move is treated as noise → "flat/well-timed".

## Verdict decision tree (first match wins)

**Post-exit continuation is judged first** (founder decision 2026-07-13): the
column's job is to describe what the market did *after* you left. The intra-trade
`isGiveBackTrade` label is only the *fallback* for a loser whose post-exit window
was flat — otherwise the app already flags give-backs via the bold capture chip.

| # | Condition | Chip | Copy |
|---|-----------|------|------|
| — | no `ext` | — | `—` (unchanged) |
| 1 | **Winner** & favorable continuation material & `cont ≥ against` | ◐ amber | `early — left {contR}R (~${leftUsd})` |
| 2 | **Winner** & reversal material | ✓ green | `exit right — {dropped\|rallied} {against}pts after` |
| 3 | **Winner** & neither material | ✓ green (muted) | `well-timed — flat after` |
| 4 | **Loser** & adverse continuation material & `against ≥ cont` | ✓ green | `stop right — kept {falling\|rising} {against}pts` |
| 5 | **Loser** & favorable reversal material | ◐ amber | `early — recovered {cont}pts after` |
| 6 | **Loser**, flat after, & `isGiveBackTrade(t)` | ✗ red | `gave it back — had +{mfeR}R, closed red` |
| 7 | **Loser**, flat after, not give-back | · gray | `flat after` |

Winner/loser split on `pnl` sign; fall back to `capturedPts > 0` when `pnl` null.
Materiality threshold = **0.5R** (fallback ×ATR, then 3 pts). When both sides are
material, the larger one wins (the `cont ≥ against` / `against ≥ cont` guards).

### Direction-aware verbs
- Long reversal (winner, row 3): price **dropped** after. Short: **rallied**.
- Long adverse-continuation (loser, row 5): kept **falling**. Short: kept **rising**.

### Dollar figure (row 2)
`leftUsd = round(cont × quantity × symbolToMultiplier(symbol))` — the extra
dollars a full-size hold would have added. Shown only when qty & multiplier known.

### R display
`contR`, `againstR`, `mfeR` to 1 decimal (e.g. `1.2R`). When on the pts fallback,
show points instead of R (`left 8pts (~$…)`).

### Partial window (`!full_window`)
- Tooltip always appends "(partial window — bars ran out)".
- If the verdict would be a *confident* one (rows 3/5 "exit/stop right") but the
  window is partial AND the move is only marginally material (< 1R), downgrade to
  the neutral "flat so far" chip — don't claim vindication on incomplete data.

## Rendering

- One chip component reused by both desktop `<td>` (line ~756) and the mobile
  `MobileMetric` (line ~409). Extract a pure `postExitVerdict(t, ext, bars?)`
  helper returning `{ glyph, tone, label, title }` so both call sites and the
  logic stay in one place. Put the helper in `src/lib/analytics.ts` (next to
  `captureRatio`/`isGiveBackTrade`) or a small `src/lib/post-exit-verdict.ts`.
- Tone → tailwind: green `text-green-400`, amber `text-amber-400`, red
  `text-red-400`, muted-green `text-green-500/70`, gray `text-gray-600`.
- Column header tooltip updated: "Was your exit well-timed? Judged by what the
  market did in the 30 min after you were out."

## Worked examples (internally consistent)

- Long, +18pts captured, `cont=1.5 / against=9`, stop 12pts away
  → `againstR=0.75 ≥ 0.5`, winner → **✓ exit right — dropped 9pts after**.
- Long, +6pts captured, `cont=14 / against=1`, risk 10pts, qty 5, NQ (×20)
  → `contR=1.4`, winner → **◐ early — left 1.4R (~$1,400)**.
- Long loss, stopped −10pts, `cont=1 / against=9`, risk 10pts
  → loser, `againstR=0.9` → **✓ stop right — kept falling 9pts**.
- Long loss −8pts, MFE 13pts, risk 10pts → `isGiveBackTrade` true
  → **✗ gave it back — had +1.3R, closed red**.
