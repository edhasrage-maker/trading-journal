# Beginner / Pro Modes — spec

*TapeScore · draft v0.1 · branch `docs/beginner-pro-spec` (off `feat/public-mvp-v2`).
Companion to the visual design system. This defines a UI-density mode toggle so the
same app serves developing traders (default) and power users (opt-in).*

## 1. Principle

- **Beginner is the DEFAULT and the primary experience.** Most traders live here.
  **Pro is the opt-in "advanced view."** (Design Beginner as the real app — not a
  crippled fallback.)
- **Beginner is a plain-English presentation layer over the SAME engine.** Every
  metric (MFE, MAE, capture, process, execution, conditions) keeps computing. Beginner
  mode *consumes* that depth and outputs plain guidance; it does not remove it.
  - Pro sees: `MFE Realized 66%`.
  - Beginner sees: *"You kept about two-thirds of the move you were offered — try
    holding to your target."*  (Same math, translated.)
- **Progressive reveal, not a wall.** Beginners should be gently drawn toward Pro as
  they grow — never told they're missing out, never nagged.
- **Never punish.** Coaching tone, honest but encouraging. (Inherits the palette's
  threat-reduction: no alarm-red, P&L carries the honest signal.)

## 2. Mechanism

- **State:** `mode: 'beginner' | 'pro'`, default `'beginner'`.
- **Provider:** a React context (`UiModeProvider` / `useUiMode()`) mounted in the app
  layout so every screen can read/branch on it.
- **Persistence:** `localStorage['tapescore-ui-mode']` for v1. (Later: a per-user
  column so it follows the account across devices — same pattern as other prefs.)
- **Hydration:** default `beginner` on first paint, then read localStorage in an
  effect after mount to avoid an SSR/client mismatch (mirror the existing
  `mfeUnit`/column-order hydration pattern in `RecentDaysList`/`DashboardStats`).
- **Toggle UI:** a small segmented control (`Beginner | Pro`) in the top bar, right
  side, always visible. Amber-selected, dark text (matches button rule).
- **Graduation nudge (v1 = manual + subtle):** a dismissible one-time hint ("Ready for
  more detail? Switch to Pro") — no auto-switching. Automate the trigger later.

## 3. Plain-language map (jargon → Beginner phrase)

| Power term (Pro) | Beginner phrasing |
|---|---|
| Process / Compliance | "Rules followed" — *did you follow your rules?* |
| Execution / Execution Parameters | "Trade quality" — *how well you executed* |
| MFE (max favorable excursion) | "the move you were offered" / "best point in your favor" |
| MAE (max adverse excursion) / heat | "worst point against you" |
| MFE Realized % / Capture | "how much of the move you caught" |
| R-multiple | "reward vs. risk" |
| ATR | "typical daily range" (no unit toggles in Beginner) |
| RVOL | "how active the market is" |
| IB / IBH / IBL | "the opening range" |
| Day type (Double Inside, Mush, GBX…) | keep the name, add a one-line plain gloss on hover; collapse to "market type" in Beginner |
| Order-flow tags (Delta Flip, Absorption…) | hidden from Beginner tagging; surfaced as plain "why" inside coach text |
| Numeric grade / score | a WORD + dot ("Clean", "Solid", "Rushed", "Breach"); the number lives in Pro |

Rule: **plain label is primary; the exact power term is one hover away and always
present in Pro** — pros lose nothing.

## 4. Per-screen mode matrix

For each screen: what **Beginner** shows, and what **Pro** adds back.

### Dashboard
- **Beginner:** hero P&L for the period · "12 green days of 23" subline · **one "your
  focus" card** (coach) · simple session list (date · quality dot+word · PnL) · equity
  curve (kept — intuitive).
- **Pro adds:** the 5-KPI jargon grid (Day/Trade Win %, Avg MFE/MAE w/ unit toggle,
  Exec/Compliance) · the full Recent Days table (Exec, Process, Trades, MFE/MAE,
  Capture, Win %, PnL) · day-type chips.

### Daily Prep
- **Beginner:** Bias · Observations · Mood · plain AI "what to watch" · the chart.
  *(Public Prep already simplified to Bias/Observations/Mood — commit `9ec5cce`; this
  formalizes it as the Beginner view.)*
- **Pro adds:** levels (PDH/PDL/ONH/ONL/IBH/IBL) · IB size · volatility metrics
  (RVOL/ADR/ATR) · MGI reactions · named setups/trade plans · distribution pills · full
  AI analysis + prep score.

### Intraday
- **Beginner:** log the essentials (time, direction, entry/exit/qty, note) · screenshot
  auto-detect · a few simple setup tags · session journal.
- **Pro adds:** the full tag taxonomy (Confluences / Order Flow / Entry Model /
  Management) · R / MFE / stop fields.

### EOD Recap
- **Beginner:** plain session recap · one focus · "what worked / what to fix" in plain
  words · trade list with plain result + quality word.
- **Pro adds:** Process rules (P1–P5) with pass/breach · Execution sub-metrics +
  composite · MAE/heat columns · full recording-commentary detail.

### Weekly Recap
- **Beginner:** the coach synthesis (already plain) · week P&L · one theme.
- **Pro adds:** per-day Exec/Compliance chips · full week metric grid.

### Analytics
- **Beginner:** 3–4 plain cards — "Your best setups" · "What's costing you" · "Best
  market conditions for you" · a simple equity/trend view.
- **Pro adds:** the full tag/confluence/order-flow/day-type/structure/management tables
  · Period Comparison · ATR buckets · Journal Themes · R stats · export.

## 5. What Beginner NEVER hides
P&L (the honest signal) · the AI coach / one focus · the equity curve · the ability to
log/import trades. Beginners still see the truth — just without the jargon.

## 6. Interaction & copy rules
- One **hero number** per screen in Beginner; supporting detail dimmed or in Pro.
- Quality shown as **word + colored dot** (Clean / Solid / Rushed / Breach), not a bare
  score. Bands derived from process pass-count + execution composite (exact thresholds
  set at build time).
- Every surfaced metric in Beginner has a one-line "what's this?" on hover.
- Tone: coaching, honest, encouraging — never punishing.

## 7. Build sequence (each step screenshot-verified, shipped behind the toggle)
1. **Foundation:** `UiModeProvider` + `useUiMode()` + header toggle + localStorage
   persistence. (Pro renders exactly today's UI — zero visual change when Pro is on.)
2. **Dashboard** Beginner view (highest traffic, clearest payoff).
3. **EOD Recap** Beginner view.
4. **Prep** (mostly there) + **Intraday** Beginner views.
5. **Analytics** Beginner cards.
6. Graduation nudge; later, DB-backed per-user preference.

## 8. Open decisions (need a call before/early in build)
- **Toggle location:** top bar right (recommended) vs sidebar footer.
- **Graduation trigger:** manual-only for v1 (recommended) vs auto-hint after N sessions.
- **Preference storage:** localStorage for v1 (recommended) vs DB column now.
- **"Focus" generation:** reuse the existing AI coach / EOD analysis output (recommended)
  vs add rule-based translations. Most is reuse; some new plain-language mapping.
- **Quality-word thresholds:** define the Clean/Solid/Rushed/Breach bands from
  process/exec at build time.
