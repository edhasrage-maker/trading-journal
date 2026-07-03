# Deploy Checklist — Hosting the Public Build

**Status:** Runbook. Follow top-to-bottom when you're ready to put the public build online. Nothing here is automated — each step is something *you* do in a dashboard. Cross-references [`take-public-plan.md`](./take-public-plan.md) and [`mobile-app-plan.md`](./mobile-app-plan.md) (this deploy is also the mobile app's backend).

The goal: deploy the **public build** (local features flag **off**) to **Vercel**, pointed at the **PUBLIC Supabase project** — the multi-tenant one, NOT your personal `.env.local` project.

---

## 0. What's already done (don't redo)

- ✅ **Multi-tenant RLS** — `supabase/schema.public.sql` is applied to the public project. Every per-user table has `user_id` + `auth.uid() = user_id` owner policies; verified 0 unowned `trades` rows. Methodology/bar-feed tables are intentional shared-read.
- ✅ **One-codebase-two-builds** — `LOCAL_FEATURES_ENABLED` (`NEXT_PUBLIC_ENABLE_LOCAL_FEATURES`) gates every local-file feature (`.scid`, OBS, ffmpeg, folder watchers). Leaving it unset = clean cloud build.
- ✅ **AI-cap table** — `ai_usage` + `consume_ai_usage` RPC live on the public project.
- ⏳ **AI-cap enforcement** — helper (`src/lib/ai-usage.ts`) exists; wiring into the Anthropic routes is in progress (see §3).

---

## 1. Vercel project

1. Import the GitHub repo (`edhasrage-maker/trading-journal`) into Vercel.
2. **Production branch:** decide deliberately. `feat/beginner-pro-mode` is the active app; do NOT point Vercel at `main` (stale). Either promote beginner-pro-mode's content to a release branch or set it as the production branch.
3. Framework preset: **Next.js** (auto-detected). Build command / output are default.
4. **Do not deploy yet** — set env vars (§2) first, or the first build ships mis-configured.

---

## 2. Environment variables (Vercel → Settings → Environment Variables)

**Set these** (values from the **PUBLIC** Supabase project dashboard + your Anthropic account — NOT the values in `.env.local`, which are the private project):

| Var | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Public project URL | Public by design (reaches browser) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public project anon key | Public by design; RLS is the guard |
| `ANTHROPIC_API_KEY` | Your Anthropic key | Server-only. Consider a **separate key** for the public deploy so you can track/kill public spend independently |
| `ADMIN_EMAIL` | Your email | Grants you the admin-only Settings pages on the hosted build |

**Leave UNSET** (so the flag is off and local-only features vanish):

- `NEXT_PUBLIC_ENABLE_LOCAL_FEATURES` — unset ⇒ `false`
- `SIERRA_DATA_DIR`, `OBS_RECORDINGS_DIR`, `FFMPEG_BIN`, `FFPROBE_BIN` — local-only paths; meaningless on Vercel

> Sanity check before deploy: `grep -rn "process.env" src/` — every non-`NEXT_PUBLIC_` var either is set above or is guarded by `LOCAL_FEATURES_ENABLED`. If a route needs `SUPABASE_SERVICE_ROLE_KEY` at runtime (scripts use it, routes shouldn't), add it as a server-only var — but confirm it's actually referenced first.

---

## 3. AI cost caps (the second must-do) — wire before public signups

Per-user daily caps stop a public user from running up unbounded Anthropic spend. Infra is built (`ai_usage` table + `consume_ai_usage` RPC + `src/lib/ai-usage.ts`); the routes need the gate.

**Cloud-exposed Anthropic routes to cap** (skip the 2 coach routes — other session's WIP; `coach-score` already caps itself):

- `analyze-eod`, `analyze-prep`, `analyze-week`, `predict-day-type`
- `extract-trade`, `extract-context`, `extract-themes`
- `trades/summary`, `trades/suggest-tags`, `spell-check`
- (`video/commentary` is local-only — no cloud cap needed)

**Pattern** (gate only in the cloud build; the local founder stays uncapped):

```ts
if (!LOCAL_FEATURES_ENABLED) {
  const supabase = await createClient()               // session client → RLS keys the row to the user
  const gate = await consumeAiUsage(supabase, 'analyze_eod')
  if (!gate.allowed) return NextResponse.json({ error: gate.message, ...gate }, { status: 429 })
}
```

- Add each action's daily limit to `AI_LIMITS` in `ai-usage.ts` (defaults to 3 if omitted).
- `consumeAiUsage` is **fail-open** — if the table/RPC is missing it allows the call, so this never breaks the local build.
- Consume **once per user action**, before the model call.

---

## 4. Deploy hygiene (batchable — do around first deploy)

- **Security headers** — add CSP/HSTS/X-Frame-Options via `next.config.ts` `headers()` (none set today).
- **Error scrubbing** — a few routes return raw error detail (e.g. CSV import 500). Return generic messages to the client; log full detail server-side.
- **Privacy policy / ToS** — required once holding other users' trade data + AI-processed uploads. Link from the landing + signup.
- **Anthropic spend alert** — set a billing alert / budget on the public key.
- **Supabase** — confirm the public project is on a plan that fits expected rows/storage; enable point-in-time backups if paid.

---

## 5. First-deploy smoke test

1. Deploy. Open the Vercel URL.
2. Confirm **local features are gone**: no SC/bar-watcher/OBS buttons; Import = CSV only; Settings shows only Coaching + Tags (unless logged in as `ADMIN_EMAIL`).
3. **Sign up a throwaway account** → confirm it sees an **empty** dashboard (RLS working — your data must NOT appear).
4. Import a small CSV → dashboard/analytics populate; MFE/capture compute (bar feed reachable).
5. Fire an AI route (e.g. Analyze Session) repeatedly → confirm the cap returns `429` after the limit.
6. Load on a phone → drawer nav + Highlights review screens usable.

---

## 6. Custom domain + mobile

- Point a domain at the Vercel deploy (TapeScore branding is in place).
- This deploy is the **mobile app's backend** — the Capacitor wrapper (see `mobile-app-plan.md`) points at this URL or straight at the public Supabase.

---

## 7. Rollback

- Vercel keeps every deployment — **Promote** a previous one to roll back instantly.
- RLS/schema changes are the only non-instant part; the overlay is idempotent, but take a Supabase backup before any further schema change.
