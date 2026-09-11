# Deploy Runbook — public testing version

Step-by-step to stand up a shareable, multi-tenant testing build. Pairs with the
code on branch `feat/public-testing-mvp`. Estimated time: ~30–60 min.

**What this gives you:** a hosted URL where testers sign up, each with fully
isolated data. No billing (free for testers). Local-only features (`.scid` charts,
OBS commentary) are hidden in the cloud build and untouched in your local build.

---

## 0. One-time concepts

- **Two Supabase projects now:** your existing personal one (unchanged) + a NEW
  one for the public version. They never mix.
- **One codebase, two modes:** the env var `NEXT_PUBLIC_ENABLE_LOCAL_FEATURES`
  controls local features. Set it `true` in your local `.env.local`; leave it
  unset on Vercel.

---

## 1. Create the new Supabase project
1. supabase.com → New project. Pick a **region near your testers**. Save the DB password.
2. Project Settings → API → copy **Project URL** and the **anon public** key (you'll need both for Vercel).

## 2. Run the multi-tenant schema (TWO scripts, in order)
`schema.public.sql` is a multi-tenant **overlay** — it ALTERs the tables that
`schema.sql` creates, so `schema.sql` must run first.
1. SQL Editor → New query → paste all of **`supabase/schema.sql`** → Run.
2. SQL Editor → New query → paste all of **`supabase/schema.public.sql`** → Run.
3. Confirm: Tables shows 17 tables; `trade_tags` is **empty** (the overlay clears
   the global seed — tags now seed per user on signup via an `auth.users` trigger).
   - ⚠️ Run BOTH, in this order. Do not run either against your single-user
     PERSONAL project — this is only for the separate multi-tenant public project.
   - The overlay is idempotent: re-running it (or re-running both) is safe.

## 3. Storage buckets
1. Storage → create two buckets: **`screenshots`** and **`sc-logs`**.
2. For early testing, add a simple policy per bucket (Storage → Policies → New):
   *allow authenticated users to read/write the bucket.*
   - This is permissive (a tester could in theory read another's screenshot URL).
     Fine for trusted early testers; the per-user-folder hardening is a follow-up
     (see `schema.public.sql` → Storage note + Follow-ups below).

## 4. Auth configuration
1. Authentication → Providers → ensure **Email** is enabled (magic-link signup works out of the box).
2. Authentication → URL Configuration:
   - **Site URL:** your Vercel URL (set after step 5; e.g. `https://acuity-xxx.vercel.app`).
   - **Redirect URLs:** add `https://<your-vercel-url>/auth/callback`.
   - (You can come back and fill these once Vercel gives you the URL.)

### 4b. Google sign-in — brand the consent screen BEFORE inviting anyone

Supabase hosts the OAuth callback, so Google's consent screen is configured in
**Google Cloud**, not in this repo and not in Supabase. `redirectTo` in
`AuthCard.tsx` only says where *our* app resumes afterwards — Google never sees
it, and no code change can alter that screen.

An OAuth client with no **App name** set makes Google fall back to the host of
the authorized redirect URI. Because that URI is
`https://<project-ref>.supabase.co/auth/v1/callback`, a new user is asked to
sign in to `dmutgkycrjudfejswvhg.supabase.co` — a random-looking string with no
connection to the product. People decline that, correctly. This happened to a
real tester on the live project; it is the first thing to fix on any new
environment.

1. Google Cloud Console → **APIs & Services → OAuth consent screen → Branding**:
   - **App name:** `TapeScore` — this alone changes the headline to
     "Sign in to TapeScore".
   - App logo, support email, homepage, privacy policy and terms links.
2. **Audience / Publishing status:** "Testing" allows only explicitly-listed
   test users, capped at 100. Move to **In production** before a public invite.
   Our scopes are `email` / `profile` / `openid`, all non-sensitive, so Google
   does NOT require a verification review and users see no "unverified app"
   warning — publishing is enough.
3. **Credentials → OAuth 2.0 Client ID → Authorized redirect URIs:** must include
   `https://<project-ref>.supabase.co/auth/v1/callback`.
4. Supabase → Authentication → Providers → **Google**: paste the client ID and
   secret.

The line *under* the headline ("Google will allow …supabase.co to access this
info") comes from the redirect host, so branding will not change it. Making that
read `tapescore.app` requires Supabase's **Custom Domain** add-on (paid): move
auth to e.g. `auth.tapescore.app`, then update the authorized redirect URI in
Google and the Site URL in Supabase to match.

## 5. Deploy to Vercel
1. Push the branch (already done if you pulled): `feat/public-testing-mvp`.
2. vercel.com → New Project → import the GitHub repo → select that branch.
3. **Environment variables** (Project Settings → Environment Variables):
   | Key | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | new project URL (step 1) |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | new project anon key (step 1) |
   | `ANTHROPIC_API_KEY` | a key from your **testing workspace** (with the spend cap) |
   | *(do NOT set)* | `NEXT_PUBLIC_ENABLE_LOCAL_FEATURES`, `SIERRA_DATA_DIR`, `OBS_RECORDINGS_DIR`, `SUPABASE_SERVICE_ROLE_KEY` |
4. Deploy. Copy the resulting URL → go back to **step 4** and set Site URL + Redirect URL, then redeploy if needed.

## 6. Smoke-test isolation (critical)
1. Open the URL in a normal browser → sign up as **tester A** → add a trade.
2. Open in an **incognito** window → sign up as **tester B** → you should see an
   empty journal (NOT tester A's data). Add a trade as B.
3. Back as A → you should see only A's trade. ✅ Isolation confirmed.
   - If B can see A's data, **stop** — RLS isn't applied; recheck step 2 ran fully.

## 7. Share with testers
Send the URL. They sign up with email (magic link), go to **Import** in the
sidebar, upload a trade-history **CSV** exported from NinjaTrader / Tradovate
(or log trades manually from the dashboard empty-state), and explore.
> Local-only ingestion paths — Sierra `.scid` bar import, the SC-log "Import
> Trades" button, OBS commentary — are hidden in the cloud build. The CSV
> uploader is the cloud importer of record.

---

## Keep your LOCAL build full-featured
In your local `.env.local`, add:
```
NEXT_PUBLIC_ENABLE_LOCAL_FEATURES=true
```
Your local app keeps `.scid` charts, the bar watcher, and OBS commentary exactly
as before. (It still points at your PERSONAL Supabase project — don't repoint it.)

---

## Verify the code change (on your machine, before/after pulling)
```
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "local-features|EodClient|PrepClient"   # expect blank
npx eslint src/lib/local-features.ts src/components/eod/EodClient.tsx src/components/prep/PrepClient.tsx
```

## Done in the public-mvp build
- **Nav gating** — Bar Data / SC Archives / Condition Lookup hidden in the cloud
  build (`LOCAL_FEATURES_ENABLED`); Perf Stats stub hidden; Import nav added.
- **Defense-in-depth route guards** — `/api/bars/auto-import`, `/api/bars/import-scid`,
  `/api/video/list`, `/api/video/commentary` return 404 in the cloud build
  (`src/lib/local-features-guard.ts`). `/api/bars` + `/api/bars/levels` are DB-backed
  and degrade to empty (no guard needed); LiveChart shows a clean no-data message.

## Known follow-ups (not blocking testing)
- **Storage per-user folders** — prefix uploads with `auth.uid()` and switch to the
  folder RLS policy (in `schema.public.sql`) to fully isolate screenshots.
- **Billing + per-user AI usage caps** — deferred until paid launch (see `DEPLOYMENT.md`).
- **Seed shared reference data** (condition_lookup, performance_stats) only if you
  want those analytics populated for testers; otherwise they show empty gracefully.
