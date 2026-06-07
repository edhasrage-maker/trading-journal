# Site improvement to-do

Running backlog of product/UX improvements for the trading journal. Separate from
the strategic take-public work (`TAKE_PUBLIC_PLAN.md`) — this is concrete site/app
tasks. Newest considerations near the top of each section.

## Onboarding / day-one value

- [ ] **First import must populate MFE/MAE, or the headline feature shows blanks.**
  The MFE/MAE stats (capture %, MAE-heat) only compute for trades that carry
  excursion data (`high/low_during_position`) — and MAE-heat also needs a
  `stop_price`. Tradezella `historical_trades` have neither, so MFE/MAE renders as
  "—" for historical-heavy imports. Risk: a new user's *first* import shows blanks
  on the headline differentiator — the opposite of the "immediate value on day one"
  promise. Mitigations:
  - Prioritize excursion-carrying importers (SC log ✓; NinjaTrader exports MAE/MFE;
    verify Tradovate before committing).
  - Guide/encourage the first import to be an excursion-carrying source.
  - Clear empty-state messaging when MFE/MAE can't be computed ("import a source
    with excursion data to unlock capture/heat").

- [ ] **Day-1 value surfacing order** (what a new user should see immediately, in
  priority order):
  1. PnL
  2. Equity curve
  3. Win rate — both **per-trade** and **per-day**
  4. MFE/MAE stats (capture %, MAE-heat)
  5. Performance by day type

## Analytics discoverability

- [ ] MFE/MAE stat cards are labeled "MFE Realized %" / "MAE Heat %" and sit in the
  same grid as Win Rate / Profit Factor — easy to scan past. Consider clearer
  labeling/grouping or a short tooltip-by-default so the differentiator stands out.

## (Add new items below)
