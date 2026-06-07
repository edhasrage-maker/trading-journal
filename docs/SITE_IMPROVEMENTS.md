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

## App / mobile conversion (post-validation, not now)

- [ ] **Turn the site into an app.** Lift assessment: the wrapper is trivial; the real
  work is mobile-responsive UI (currently desktop-only — only ~22 responsive-class
  usages across the whole app, no PWA/Capacitor/Tauri). Reframe: journaling/prep/EOD
  is a desk activity; mobile's job is *review + quick capture*, so scope to read
  surfaces (dashboard, analytics, equity curve, calendar, day list), not full
  journaling parity. Effort ladder at ~5–10h/wk:
  - PWA shell only (installable): ~1 week — low value until UI is responsive
  - + responsive review surfaces (genuinely usable on phone): ~1–1.5 months total
  - + Capacitor wrapper for app stores: +2–3 weeks + store accounts/upkeep
    (Apple $99/yr, Google $25 one-time)
  - Full mobile journaling parity: 3+ months — not recommended
  - *Separate fork:* a Tauri/Electron **desktop** app could preserve the local
    `.scid`/OBS integrations the cloud SaaS must cut — a potential power-user/Pro tier.

## (Add new items below)
