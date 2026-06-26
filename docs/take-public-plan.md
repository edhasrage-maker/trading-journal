# Take-Public Plan — Trading Journal

**Status:** Planning / strategy-first. **No code changes yet.** This doc captures decisions and open questions before any build work. Today the app is a **local, single-user tool** (localhost, same machine as Sierra Chart) — none of the below is a live risk in that setup; it all becomes real only when the app is hosted and/or multi-tenant.

---

## 0. The core reality (read this first)

The biggest blocker to "going public" is **not security — it's architecture.** Server routes read **local files** on the user's Windows machine:

- `.scid` market data via `src/lib/scid-reader.ts`
- OBS recordings via ffmpeg/ffprobe (`src/lib/video-frames.ts`)
- the `D:\SierraCharts\Data` directory, and OBS recordings dir

A cloud host cannot read these. So "launch" is first an **architecture decision**, and the security/multi-tenancy work is downstream of it. Don't start security hardening until the deployment shape is chosen.

---

## 1. Deployment architecture (decide first) — OPEN

How do the local-file dependencies survive a hosted product?

- **Option A — Hybrid (local agent + cloud app).** A small local companion (the existing dev server, or a slimmed agent) reads `.scid`/OBS on the user's machine and syncs/serves to a cloud app. Keeps the Sierra integration; adds a sync/auth channel.
- **Option B — Desktop app** (Electron/Tauri wrapping the current Next app). Stays local-first, distributes as an installer, still talks to a shared Supabase. No cloud compute for the file-reading parts.
- **Option C — Cloud-only.** Users upload their own data (CSV exports, screenshots); drop the live `.scid`/OBS reading. Loses the headline Sierra/OBS features.

**Decision needed before anything else.** Everything below assumes a multi-user backend (Supabase) regardless of which is chosen.

---

## 2. Multi-tenancy & data isolation — ⚠️ THE critical security item

**Current state:** RLS is enabled on every table, but every policy is `for all using (auth.role() = 'authenticated')`. That means **any logged-in user can read/write ALL rows** — fine for single-user, a critical breach the moment a second user exists (user A reads user B's trades).

**Work required (not a 5-minute fix):**
- Add a `user_id` column to every user-owned table (`trades`, `trading_days`, `trade_tags`, `market_context`, `ohlcv_bars`, `historical_trades`, …).
- Backfill existing rows to the owner.
- Rewrite every policy to `auth.uid() = user_id` (per-operation where needed).
- Scope every query/insert to set/filter `user_id` (server `createClient()` carries the session, but inserts must stamp the owner).
- Audit storage (the `screenshots` bucket) policies for per-user scoping too — currently any authenticated user could read any object.

---

## 3. Security checklist — assessed against this codebase

Sourced from a "vibe-coded app" launch thread; verdicts are for **this** app, for an eventual public launch.

| Item | Verdict | Notes |
|---|---|---|
| Secrets in frontend / API keys (#7/#8) | ✅ Clean | Only `NEXT_PUBLIC_SUPABASE_URL` + anon key reach the browser (public by design). Service-role key is **scripts-only**; Anthropic key is server-side. No leak. |
| OWASP — SQLi / XSS (#5) | ✅ Low risk | Supabase parameterizes queries (no raw SQL); **zero `dangerouslySetInnerHTML`** (React auto-escapes). |
| Auth gating | ✅ Present | `(app)/layout.tsx` → `getUser()` → `redirect('/login')`. NB: this gates **pages**, not `/api` routes — those rely on RLS as the backstop. |
| **RLS scoping (#2)** | ⚠️ **Must fix for multi-tenant** | See §2. Authenticated-only ≠ user-scoped. |
| **Rate limits (#9)** | ⚠️ **Must fix for public** | See §4. 12 Anthropic-backed routes, no caps. |
| Security headers (#4) | ❌ Batchable | None set (CSP/HSTS/etc.). ~10 min via `next.config` headers / middleware at deploy. |
| Non-leaky errors (#11) | ⚠️ Batchable | Some routes return raw error detail (e.g. the CSV 500). Scrub before public; log full server-side. |
| Server-side validation (#6) | ⚠️ Review | Inputs loosely validated; RLS is the real backstop. One pass pre-public. |
| Test failure paths (#3) | — | Supabase Auth covers most; relevant once public signup exists. |
| CAPTCHA + CORS (#10) | N/A (for now) | No public forms; API routes are same-origin. Add Turnstile + locked CORS if public signup/forms are added. |
| Privacy policy / GDPR/CCPA (#1) | ❌ Legal | See §8. Required once holding other users' data. |

**Bottom line:** the only two that genuinely bite at multi-tenant launch are **§2 (user-scoped RLS)** and **§4 (rate limits / usage caps)**. The rest is standard deploy hygiene to batch once.

---

## 4. Cost & abuse control — OPEN (one of the two real must-dos)

- **AI rate limits / per-user usage caps.** 12 routes call Anthropic (`analyze-prep`, `analyze-eod`, `video/commentary`, `trades/summary`, `trades/suggest-tags`, `extract-*`, …) with **no caps**. Public exposure = someone hammers an endpoint and runs up the Anthropic bill (the thread's $20→$200 story is exactly this). Needs per-user/day token or request caps + a hard ceiling.
- **Anthropic key management.** Single shared key today; consider per-tenant usage accounting + rotation.
- **Supabase cost scaling** — row counts, storage (screenshots/OBS frames), bandwidth.

---

## 5. IP protection — OPEN

- **The prompts ARE the product.** The `analyze-prep` / `analyze-eod` rulesets (and `docs/Ruleset_v1.3_Process_Execution_Spec.md`) encode the coaching edge. They live server-side (good) but must never ship to the client or be echoed back verbatim in responses. Audit AI routes for prompt leakage.
- **Journal-data privacy** if multi-tenanted — see §2/§8.

---

## 6. Pricing & projected costs — OPEN

- Model per-user monthly cost at varying user counts: Anthropic tokens (dominant variable — how many analyses/day × tokens/call) + Supabase (DB rows, storage for screenshots/OBS frames, bandwidth) + hosting.
- Pricing model (flat sub vs usage-based vs tiered by AI volume).

---

## 7. Cross-trader benchmarking (flagship differentiator) — OPEN

- Aggregate, anonymized benchmarks: "median MFE today," "median hold time today," percentile vs other traders, etc. A genuine differentiator that **only works hosted/multi-tenant** (needs the cross-trader pool).
- Pushes the architecture toward SaaS/hybrid and weakens a pure open-source-self-host path. Privacy/consent model needed (opt-in, anonymized aggregates only).

---

## 8. Legal / compliance — OPEN

- Privacy policy; GDPR/CCPA once collecting others' data.
- Terms of service / data-handling disclosures (esp. AI-processed trade data + uploaded screenshots/recordings).
- Where user data lives (Supabase region) and retention.

---

## Sequencing (proposed)

1. **Decide §1 (architecture).** Nothing else is concrete until this is picked.
2. **§2 user-scoped RLS** + **§4 rate caps** — the two real security must-dos, once multi-user is real.
3. **§6 cost model** in parallel (informs pricing + whether the AI volume is even viable).
4. Batch the deploy hygiene (§3 headers/errors/validation, §8 legal) at deploy time.
5. **§7 benchmarking** as the post-launch differentiator.
