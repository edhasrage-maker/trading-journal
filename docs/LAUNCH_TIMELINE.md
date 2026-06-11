# Product Launch Timeline — Acuity *(working name)*

**Start:** mid-June 2026 · **Target public launch:** early January 2027
**Assumptions:** ~8 h/week focused effort · AI-accelerated build · scope locked to MVP
(no charts / Rithmic / video / mobile at launch) · **July fully blocked (personal)**.

> Dates are *target completion* (end of that week). This is gated: the **go/no-go
> decision in early August** determines whether the build months proceed as written.
> If validation fails, the build phase pauses and we iterate positioning instead.

**Milestones:** 🚩 Validation gate (Aug 7) · 🧪 Private beta (Nov 6) · 🚀 Public launch (Jan 8)

---

## JUNE 2026 — Validation & branding *(Phase 0)*

**Week of Jun 15** — *target: Jun 19*
- [ ] Build target-trader list (8–10), with tracking table — **Jun 17**
- [ ] Lock the name + run domain/handle/trademark availability — **Jun 18**
- [ ] Send outreach (templates A/B) to the list — **Jun 19**

**Week of Jun 22** — *target: Jun 26*
- [ ] Run 3–4 discovery interviews (Mom-Test script) — **Jun 26**
- [ ] Put 2–3 best-fit traders on the current app (concierge) — **Jun 24**
- [ ] Collect NinjaTrader + Tradovate sample exports — **Jun 26**

**Week of Jun 29** — *target: Jun 30 (wrap before July)*
- [ ] 2–3 more interviews (running total 6–8) — **Jun 30**
- [ ] Draft pricing tiers (benchmarked) — **Jun 30**

---

## JULY 2026 — 🚫 BLOCKED (personal)

- No active work. **Passive incubation:** concierge traders keep using the app on
  their own; note any unprompted usage/feedback for the August readout.

---

## AUGUST 2026 — 🚩 Gate + Multi-tenancy *(Build Phase 1)*

**Week of Aug 3** — *target: Aug 7*
- [ ] Finish interviews + concierge readouts — **Aug 5**
- [ ] **🚩 Score the go/no-go gate → DECISION** — **Aug 7**
- [ ] If GO: set up deploy target, project board, working branch — **Aug 7**

**Week of Aug 10** — *target: Aug 14*
- [ ] Schema migration: `user_id` + per-user RLS across ~14 tables + indexes — **Aug 14**

**Week of Aug 17** — *target: Aug 21*
- [ ] Query-layer scoping: dashboard + analytics paths — **Aug 21**

**Week of Aug 24** — *target: Aug 28*
- [ ] Query-layer scoping: settings, exports + shared/reference-table model — **Aug 27**
- [ ] Multi-tenant security QA (zero cross-user leakage, verified) — **Aug 28**

---

## SEPTEMBER 2026 — Billing + Importer #1 *(Build Phase 2)*

**Week of Sep 7** — *target: Sep 11*
- [ ] Stripe Checkout + webhook → `subscription_tier`; tier gating on AI — **Sep 11**

**Week of Sep 14** — *target: Sep 18*
- [ ] Per-user AI rate limits + monthly usage caps + `metadata.user_id` — **Sep 18**

**Week of Sep 21** — *target: Sep 25*
- [ ] Importer #1 (NinjaTrader): parser + MAE/MFE/excursion mapping — **Sep 25**

**Week of Sep 28** — *target: Oct 2*
- [ ] Importer #1: testing on real samples + start onboarding flow — **Oct 2**

---

## OCTOBER 2026 — Onboarding + Cloud deploy *(Build Phase 3)*

**Week of Oct 5** — *target: Oct 9*
- [ ] Onboarding: signup → import → day-1 value in <5 min; empty states — **Oct 9**

**Week of Oct 12** — *target: Oct 16*
- [ ] Decouple/cut `.scid` + OBS for cloud; deploy to staging — **Oct 16**

**Week of Oct 19** — *target: Oct 23*
- [ ] Deploy hardening (env/secrets), full end-to-end multi-tenant test — **Oct 23**

**Week of Oct 26** — *target: Oct 30*
- [ ] Bug bash + polish the day-1 surfacing order; beta readiness check — **Oct 30**

---

## NOVEMBER 2026 — 🧪 Private beta

**Week of Nov 2** — *target: Nov 6*
- [ ] Onboard 5–10 beta users (validation waitlist + contacts) — **Nov 4**
- [ ] **🧪 Beta live** — instrument activation/usage — **Nov 6**

**Week of Nov 9** — *target: Nov 13*
- [ ] Collect feedback; fix top-3 friction points — **Nov 13**

**Week of Nov 16** — *target: Nov 20*
- [ ] Iterate; add Importer #2 (Tradovate) if validated as needed — **Nov 20**

**Week of Nov 23** — *target: Nov 27*
- [ ] Stabilize; pursue first paid conversions + testimonials — **Nov 27**

---

## DECEMBER 2026 — Launch prep + soft launch *(holiday-lightened)*

**Week of Dec 7** — *target: Dec 11*
- [ ] Final landing page + messaging; build-in-public content queued — **Dec 11**

**Week of Dec 14** — *target: Dec 18*
- [ ] Soft launch to 1–2 communities; watch onboarding at small scale — **Dec 18**

**Weeks of Dec 21 & 28** — *lighter (holidays)*
- [ ] Monitor, fix, buffer. No major pushes. — **rolling**

---

## JANUARY 2027 — 🚀 Public launch + growth

**Week of Jan 4** — *target: Jan 8*
- [ ] **🚀 Public launch push** (content, communities, waitlist conversion) — **Jan 8**

**Week of Jan 11** — *target: Jan 15*
- [ ] Monitor funnel: activation → paid conversion; fix drop-offs — **Jan 15**

**Weeks of Jan 18 & 25**
- [ ] Double down on the channel that converts; track toward $1–3k MRR — **rolling**

---

## Notes & risk buffers

- **The gate is real.** If Aug 7 fails the criteria, do NOT start the build — iterate
  positioning or pause. The build calendar assumes a GO.
- **Scope creep is the #1 schedule killer.** Charts, Rithmic, video, mobile, and the
  open-trader session-model audit are all **post-launch**. Guard the cut list.
- **One importer at launch** (NinjaTrader). Tradovate is a beta-window add only if
  users demand it.
- **Pace sensitivity:** this assumes ~8 h/wk. At 5 h/wk, add ~6–8 weeks overall; at
  10 h/wk in focused blocks, you could pull launch into December.
- **Built-in buffer:** late-December is deliberately light (holidays) and acts as slack
  if earlier phases slip.
