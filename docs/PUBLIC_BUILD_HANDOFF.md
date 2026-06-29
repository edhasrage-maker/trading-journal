# Public Build — handoff brief (start a fresh chat with this)

Purpose: build the **multi-tenant PUBLIC/TESTING version** of the platform on top
of the now-canonical `main`. The earlier attempt (this branch,
`feat/public-testing-mvp`) was built on a stale base — reuse its new files, but
**redo the schema + the file-edits on current `main`.**

## Current state
- **`main` is the single source of truth** (consolidated this session; ~16 tables
  incl. new `trader_profile`, `weekly_recap`; Settings → Tags is now a REAL
  feature; new Coaching settings page).
- This branch holds reusable, schema-agnostic NEW files + the strategy docs.

## Decisions already made — DO NOT relitigate
- Fresh, **separate Supabase project** (multi-tenant) for the public version;
  personal/local project stays as-is.
- **Per-user tag library**, seeded with defaults on signup (auth.users trigger).
- **One codebase, flag-gated** via `NEXT_PUBLIC_ENABLE_LOCAL_FEATURES` (local =
  full features incl `.scid`/OBS; cloud = those hidden). Converge to one
  multi-tenant `main` eventually.
- **Free testing — NO billing/Stripe yet.**
- **Importer = CSV upload** (NinjaTrader/Tradovate), no broker login.

## Reuse from `feat/public-testing-mvp` (new, schema-agnostic — copy onto a fresh branch off main)
- `src/lib/local-features.ts`
- `src/lib/csv-trade-import.ts`
- `src/app/api/import-trades-csv/route.ts`
- `src/app/(app)/import/page.tsx`
- Docs: `docs/DEPLOY_RUNBOOK.md`, `docs/DEPLOYMENT.md`, `docs/STATUS_SUMMARY.md`,
  `docs/SITE_IMPROVEMENTS.md`, `docs/LAUNCH_TIMELINE.md`, `docs/VALIDATION_KIT.md`,
  `docs/DESIGN_NOTES.md`

## Build on a fresh branch off `main` (e.g. `feat/public-mvp-v2`)

### 1. Multi-tenant schema
Either a regenerated `supabase/schema.public.sql` OR a catalog-driven overlay that
runs AFTER `schema.sql`. For ALL current tables, add
`user_id uuid references auth.users(id) on delete cascade default auth.uid()` +
owner RLS `for all using (auth.uid() = user_id) with check (auth.uid() = user_id)`.
- **Per-user:** trading_days, market_context, trades, trade_tags, daily_prep,
  chart_prefs, ohlcv_bars, bar_imports, historical_trades, eod_themes_analysis,
  **trader_profile**, **weekly_recap**.
- **Shared read-only** (authenticated SELECT only): performance_stats,
  condition_thresholds, condition_lookup, lookup_metadata.
- **Make natural-key PKs/uniques composite with user_id:** daily_prep PK
  (trade_date → user_id,trade_date); chart_prefs PK (key → user_id,key);
  ohlcv_bars PK (symbol,ts → user_id,symbol,ts); uniques on `trading_days.date`,
  `trades.sierra_trade_id`, `trade_tags(category,label)`,
  `historical_trades.dedup_key`, `eod_themes_analysis(from,to,version)`. Check
  `trader_profile` / `weekly_recap` PKs and make them per-user too.
- **Seed default tags** via an `auth.users` AFTER INSERT trigger (security
  definer) inserting the default tag library for `new.id`.
- ⚠️ Read the CURRENT `supabase/schema.sql` + `supabase/migrations/*` to get
  every table/column/PK right — the schema grew a lot.

### 2. First-run CTA (A2)
Dashboard empty-state ("Import trades" / "Log manually") when the account has no
data (`recentDays.length === 0`). Re-apply onto the CURRENT dashboard page.

### 3. Settings nav (A3) — CORRECTED for current main
In `src/components/Sidebar.tsx`: **KEEP Coaching + Tags** (real, cloud-safe
features); **HIDE only the Perf Stats stub**; gate **Condition Lookup + Bar Data +
SC Archives** behind `LOCAL_FEATURES_ENABLED`; hide the Settings section if empty;
add an **"Import"** nav item.

### 4. Local-feature gating
Wrap BarWatcher / SCFolderWatcher / RecordingCommentary in EodClient + PrepClient
behind `LOCAL_FEATURES_ENABLED`. **AUDIT** newer components/effects for any that
auto-call `/api/bars/*` or `/api/video/*` and gate them too.

## Verify (no node_modules in the Claude env → the user runs locally)
- `npx tsc --noEmit -p tsconfig.json` — filter to `src/` (ignore `.next` noise;
  stop the dev server or delete `.next` for a clean run).
- `npx eslint <changed files>` — PrepClient/LiveChart have known-tolerated
  `set-state-in-effect` lint; leave those.
- ⚠️ The CSV parser's header aliases + MAE/MFE-as-price-points **must be validated
  against real NinjaTrader/Tradovate exports.** Test the importer against the NEW
  multi-tenant Supabase project, not the personal single-user one.

## Then: deploy via `docs/DEPLOY_RUNBOOK.md` → isolation smoke-test → share.
