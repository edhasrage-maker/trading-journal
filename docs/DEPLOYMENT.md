# Go-Public Deployment Checklist

*How to take the local single-user app to a hosted, multi-tenant public site.
This is the build/infra brief — pair it with `LAUNCH_TIMELINE.md` (when) and
`STATUS_SUMMARY.md` (what/why).*

## The stack (what changes vs what doesn't)

```
Local today:  browser → localhost (Next.js on PC) → Supabase (cloud) + Anthropic API
Public:       browser → yourdomain.com → Vercel (Next.js) → Supabase (cloud) + Anthropic API
```

- **New piece:** a cloud host for the Next.js app (Vercel).
- **Unchanged:** data already lives in **Supabase** (Postgres + Storage + Auth) — cloud already.
- **Dropped in cloud:** local-file features (`.scid`, OBS/ffmpeg) — keep a local build for those.

## ⚠️ Sequencing note

Per the strategy, the heavy build is **gated on the validation milestone** (see
`LAUNCH_TIMELINE.md`). Don't build multi-tenancy + billing before validating
willingness-to-pay. The *cheap, non-gated prep* (domain, accounts, a staging deploy
to shake out local-route issues) can be done anytime and de-risks the later build.

---

## Phase 1 — Multi-tenancy (THE gate; no public users without it)
- [ ] Add `user_id uuid references auth.users(id)` to every per-user table
  (trades, trading_days, market_context, daily_prep, chart_prefs, bar_imports,
  eod_*; decide shared-vs-per-user for `trade_tags`, `condition_*`,
  `performance_stats`, `ohlcv_bars`). Update `supabase/schema.sql` to match.
- [ ] Switch RLS from `auth.role() = 'authenticated'` to `auth.uid() = user_id`
  on every table. (Today's policy lets any logged-in user see ALL data.)
- [ ] Add indexes on `(user_id, ...)` for the hot query paths.
- [ ] Audit/scope every Supabase query (dashboard, analytics pagination, exports,
  settings) so it filters by the current user.
- [ ] **Verify zero cross-user leakage** with two test accounts (service-role check).

## Phase 2 — Strip/guard local-only routes (so it runs on Vercel)
- [ ] Remove or feature-flag-off in the cloud build: `/api/bars/import-scid`,
  `/api/bars/auto-import`, `/api/video/list`, `/api/video/commentary`, the SC
  folder watcher, BarWatcher. (Vercel has no local FS / ffmpeg.)
- [ ] Add the graceful "no chart data yet" empty state (no `.scid` source in cloud).

## Phase 3 — Production data layer (Supabase)
- [ ] Create/confirm a **production Supabase project**; pick a region near users.
- [ ] Upgrade to **Pro ($25/mo)** for daily backups + headroom (do this at beta, not before).
- [ ] Move screenshots/files to Supabase Storage buckets with per-user RLS.

## Phase 4 — Deploy the app (Vercel)
- [ ] Connect the GitHub repo to **Vercel**; set the production branch.
- [ ] Add env vars in Vercel (never commit): `ANTHROPIC_API_KEY`,
  `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_*` keys. Use the dedicated testing/prod
  Anthropic **workspace key** with its own spend cap.
- [ ] Confirm the build passes without the local-route code paths.

## Phase 5 — Domain + HTTPS
- [ ] Buy a domain (~$12/yr). Point DNS at Vercel; HTTPS is automatic.

## Phase 6 — Billing + cost controls (before paying users)
- [ ] Stripe Checkout + webhook → `subscription_tier` on the user; gate AI by tier.
- [ ] Per-user AI rate limits + monthly usage caps; tag Anthropic calls with
  `metadata.user_id`. (Account/workspace spend cap as the hard backstop.)

## Phase 7 — Legal / trust (you now hold others' trading data)
- [ ] Privacy policy + Terms of Service.
- [ ] Confirm backups (Supabase Pro) and a basic data-deletion path.

## Phase 8 — Pre-launch hygiene
- [ ] Hide or stub-fill `settings/tags` and `settings/stats` (currently "Coming soon").
- [ ] <5-min onboarding: signup → import → first analytics + AI insight.

---

## Rough monthly cost
Vercel free → ~$20/mo if you outgrow hobby · Supabase Pro $25/mo · domain ~$1/mo
· + per-token Anthropic usage. **≈ $25–45/mo** infra before scale.

## What you can safely do NOW (cheap, non-gated)
- Buy the domain · create accounts (Vercel, prod Supabase, Stripe) · deploy the
  *current* app to a **staging URL** to surface every local-route break early.
Everything else waits for the validation gate.

---

## Chart data sourcing & configurable levels (Phase 2 — not for testing)

Cloud users don't have local `.scid`, so "automatic, no-upload charts" is a
Phase-2 build. It's **two separate problems** — solve them independently. For
testing, **screenshot upload sidesteps both** (the user's image already shows
their chart with their own levels), so none of this blocks launch.

### Problem 1 — get the bars automatically (no per-session upload)
"Automatic" = bar data lives server-side, fetched for the symbol+date traded.
Two ways, differing by *who provides the feed*:

| Approach | User friction | Cost to us | Notes |
|---|---|---|---|
| **Data vendor (central)** — Databento (futures), Polygon (FX/stocks) | None | We pay (cache in `ohlcv_bars`, pay once per symbol/day across all users) | Truest "it just works." Databento is futures-strong / FX-weak. |
| **User connects feed once** — Rithmic/CQG/broker OAuth | One-time "Connect" click | ~$0 (their feed) | Auto-syncs bars **and** fills thereafter. Prop-firm killer feature; biggest build + licensing. |
| **TradingView embed** | None | ~$0 | Live chart for any asset, but it's TV's chart — **no trade overlays.** |

The alternative to "upload every session" is **"connect once"** (or we pay a vendor) —
not magic. "Connect once" also solves trade import, not just charts.

### Problem 2 — the right *levels* for users who don't trade like us
Levels are **math on the bars** (PDH/PDL, IBH/IBL, VWAP, opening range, prior-session
hi/lo are all `f(bars, session definition)`). So we **compute** levels; we never store
or impose "our" levels.

> **auto-pull bars → compute levels from bars using the user's *configurable* session/level definitions.**

- Computation is universal; only the **definitions** are personal.
- Our methodology (IB = first 60m, RTH 6:30–13:00 PT, VWAP/IBH/IBL/PDH/PDL) becomes the
  default **"Orderflow Futures" preset** — not a hardcoded assumption.
- ICT FX trader → different preset (killzones, no IB) or self-defined windows.
- Open-trader (no IB) → flips IB off. **The non-IB session audit (in `SITE_IMPROVEMENTS.md`)
  is step one of making levels configurable.**
- Requires parameterizing `src/lib/session-levels.ts` (session windows, IB on/off, which
  levels) via a per-user/style config — the "universal engine + style preset" pattern.

### Sequencing
1. **Now / testing:** screenshot upload (built, $0).
2. **Cheap "live charts for everyone" stopgap:** TradingView embed (loses overlays).
3. **Keep-your-overlay stopgap:** extend the existing bars-CSV import.
4. **Post-revenue, futures-first:** Databento (cached) for seamless overlaid charts.
5. **The prize:** Rithmic/CQG connect-once → auto bars + fills at ~$0 to us.
Parameterize the levels engine in parallel with whichever bar source you pick.
