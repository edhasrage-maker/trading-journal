# Trading Journal — Status Summary

*One-page snapshot for the take-public effort. Date: 2026-06-07.*

## Current status

A **feature-complete personal trading journal** running as a single-user local app
(Next.js + Supabase + Anthropic), used daily alongside Sierra Chart. The decision is made
to take it public as a **hosted, multi-tenant SaaS** for serious discretionary
(futures-leaning) traders. Strategy is well-developed; **the build for launch has not
started.** Constraints driving everything: ~5–10h/week, $500–2k budget, minimal audience,
goal of ~$1–3k MRR (≈40–100 paying users).

**Phase:** pre-validation. Next gate is proving 3–5 target traders will pay before the
~3-month multi-tenant build.

## What's going well

- **Strong, verified differentiators that already exist and are cloud-safe:**
  - **Day-one value** — instant analytics from the first import (beats incumbents whose
    journals need 2–3 months of data to be useful — their biggest weakness).
  - **MFE/MAE in ATR units + capture efficiency** — quantitative depth few competitors show.
  - **Day-type / market-condition intelligence** in prep + analytics.
  - **Drag-drop screenshot → autotag** — near-zero-friction journaling.
- **Auth is done** (Supabase OTP + session/middleware) and reusable as-is.
- **No service-role RLS bypasses** to untangle — clean base for multi-tenancy.
- **Differentiators don't depend on local files** — the `.scid`/OBS cuts don't hurt the
  core value.
- Clear, sharp positioning: *"the journal that pays off on day one."*

## What's still needed (to launch)

1. **Multi-tenancy** — add `user_id` + per-user RLS across ~14 tables and ~200–300 query
   sites (medium lift, not the "one-day migration" once assumed).
2. **Billing + cost controls** — Stripe + tier gating + **per-user AI rate limits/usage
   caps** (none exist today; non-negotiable for an AI product).
3. **Importers that carry excursion data** — Tradezella done; add NinjaTrader (has MAE/MFE),
   verify Tradovate. Collect real sample exports to size the work.
4. **Onboarding** — signup → import → see value in <5 min; lead untagged imports with the
   tag-free metrics.
5. **Validation + a little distribution** — landing page/waitlist, concierge test with
   contacts, brand/name.

## Roadblocks / areas of concern

- **Distribution is the #1 risk.** Minimal audience + light time. Building into silence is
  the real danger — validate before the big build.
- **Time is the binding constraint.** 5–10h/wk stretches launch to ~6 months, MRR target
  to ~9–12 months.
- **Competitors copy features** (esp. Tradezella). Features aren't legally protectable; the
  moat is speed/niche/brand/data + hosting (trade secrets). Do cheap basics (trademark
  name, closed-source, "show the what, hide the how"), then outrun.
- **Excursion-data dependency** — MFE/MAE only lights up for excursion+stop-bearing trades;
  a wrong first import shows blanks on the headline feature.
- **Untagged bulk imports** have no tags/screenshots → tag-driven depth stays dark until a
  low-friction enrichment path exists (bulk tagging).
- **Cut features** (`.scid` charts, OBS video, Rithmic/Databento) — deferred; live charts
  absent at MVP (rely on screenshot upload).
- **TAM limiter:** day-type analysis is currently post-IB-anchored; open-session traders
  need an earlier read before broadening the audience.

## Reference docs

- `docs/TAKE_PUBLIC_PLAN.md` — full strategy (note: predates this session's refinements).
- `docs/SITE_IMPROVEMENTS.md` — concrete product/UX/app to-do backlog.
- Strategic launch plan (off-repo): the lean go-to-market roadmap with phases, budget,
  timeline, and the validation gate.
