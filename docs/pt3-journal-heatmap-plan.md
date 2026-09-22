# Pt 3 — Journal Language Heatmap (for the coach to react to)

## Context
From the Q1 discussion (Pt 2 chat). The trader wants the journal's FREE-TEXT mined
for recurring words/phrases + emotional language, correlated to outcomes, and fed
to the AI coach so it can react — e.g. "keeps writing 'hate myself' → low
confidence → surface positive data to uplift", or "keeps writing 'thought I saw
selling' on trades that then lose → flag that pattern". Pull from ALL trader-
authored text sources: **Daily prep, Intraday (per-trade notes), EOD recap,
Weekly recap.**

This EXTENDS the existing "Journal Themes" feature, which today only reads
`eod_notes` and is hidden on public.

## What already exists (reuse / extend — don't rebuild)
- **Journal Themes:** `src/app/api/extract-themes/route.ts` + `src/lib/themes-prompt.ts`
  (`buildThemesPrompt(NoteEntry[])`, `PROMPT_VERSION` cache key, `ThemeRaw` /
  `EnrichedTheme` with `avg_grade`/`avg_pnl`/`avg_process_score`) → persisted in
  the `eod_themes_analysis` table → rendered by `src/components/analytics/JournalThemes.tsx`.
  It ALREADY does LLM recurring-theme extraction + correlation to day outcomes,
  but ONLY over EOD notes, day-level, and is NOT fed to the coach. (Confirm its
  exact table DDL + the public-hide gate in Pt 3.)
- **Coach context injection:** `src/lib/coach-context.ts` `buildCoachContext()` is
  inherited by BOTH coach chat (`api/coach/route.ts`) AND weekly recap
  (`api/analyze-week/route.ts`) — so a block added there reaches both for free.
  EOD is separate: `api/analyze-eod` = `profileContextBlock + behavioralProxiesPromptBlock(trades)
  + buildEodPrompt(...)`.
- **Block-builder pattern to mirror:** `behavioralProxiesPromptBlock(trades)` in
  `src/lib/behavioral-proxies.ts` — a pure function returning a prompt string block.
  A `journalHeatmapPromptBlock(...)` would follow the same shape.

## Free-text sources to pull (confirm exact columns in Pt 3)
- **Prep:** `PrepNotes.bias_notes` (+ any other free-text fields on the prep shape).
- **Intraday:** `trades.notes` (per-trade), possibly `recording_commentary`.
- **EOD:** `trading_days.eod_notes` (the trader's reflection — already used by Themes).
- **Weekly:** VERIFY whether any trader-authored weekly text exists, or the weekly
  recap is purely AI-generated (likely no user text — may drop from sources).
- Multi-tenant: confirm `user_id` on these tables for per-user scoping + RLS.

## Design forks to resolve with the user (Pt 3, before coding)
1. **Extraction method:** deterministic phrase-frequency "heatmap" (stopword-filtered
   n-grams, counts + intensity, correlated to win/loss / PnL / grade) vs the existing
   LLM theme extraction vs **hybrid** (deterministic frequency+correlation surface,
   fed to the coach which interprets). User's word "heatmap" leans deterministic;
   "react to / uplift" leans semantic → hybrid is likely.
2. **Granularity:** per-TRADE notes → per-trade outcome (the "thought I saw selling"
   example needs this) AND/OR day-level (prep/eod) → day outcome.
3. **Where it surfaces:** coach chat context (primary), EOD analyzer, and/or a visual
   heatmap UI panel. Weekly inherits via buildCoachContext.
4. **Storage/caching:** mirror `eod_themes_analysis` (versioned cache table) vs compute
   live in buildCoachContext. Per-user `user_id` + RLS.
5. **Uplift loop:** how the coach USES a low-confidence signal (surface positive data
   points) — prompt directive vs structured flag.

## Still-open from Pt 1/2 (carry into Pt 3)
- **Personal-DB post_exit migration PENDING.** Public project done. Run on personal
  (`gppxmkvceyrnljbhfwgl`): `alter table trades add column if not exists
  post_exit_favorable_pts numeric, add column if not exists post_exit_against_pts numeric;`
  then `node --experimental-strip-types scripts/backfill-post-exit.ts`. Pt 2 shipped
  in commit `2ff04d1`; Pt 1 in `763e9cc`.

## Confirmed exploration findings (captured before transition; 2 of 3 agents)

### Coach / EOD / Weekly injection points
- `buildCoachContext()` (`src/lib/coach-context.ts`) does **NOT** currently SELECT
  the trade `notes` free-text (only tags_json + geometry). A heatmap over per-trade
  notes needs an ADDED fetch of `trades.notes` there. Returns one big string; the
  14 context blocks emit in order — insert a new "JOURNAL LANGUAGE" block after
  "BEHAVIORAL PATTERNS ACROSS SESSIONS" (~line 533). Coach chat AND weekly recap
  (`analyze-week` calls buildCoachContext ×2) inherit it automatically.
- EOD (`api/analyze-eod` → `buildEodPrompt`) DOES already include each trade's
  `notes` text + `recording_commentary` in the tradesBlock. Inject a heatmap block
  after tradesBlock / before the EOD reflection (~eod-prompt line 670), OR add a
  `journalHeatmapPromptBlock(...)` call in the route next to `behavioralProxiesPromptBlock`.
- **Mirror `behavioralProxiesPromptBlock(trades)` in `src/lib/behavioral-proxies.ts`**
  — pure fn: compute → returns a formatted string block or `''` when no signal.
  The heatmap should be a new `src/lib/journal-language-heatmap.ts` with the same shape.

### Journal Themes (the thing to extend)
- `api/extract-themes/route.ts`: reads `trading_days` (`date, eod_notes, eod_pnl,
  overall_grade, process_score, id`), filters `eod_notes >= 20 chars`, paginated;
  one `claude-sonnet-4-6` call (max_tokens 4000) via `buildThemesPrompt`; enrichment
  (avg grade/pnl/process over excerpt dates) done IN THE ROUTE; upserts
  `eod_themes_analysis` on `userConflict('from_date,to_date,prompt_version')`.
  AI gate `consumeAiUsage(supabase,'extract_themes')` = 15/day (skipped on LOCAL).
- `eod_themes_analysis` table (schema.sql ~570): `(from_date,to_date,prompt_version)`
  unique + `themes_json/notes_count/total_chars/model/generated_at`; RLS; `user_id`
  overlaid in `schema.public.sql`. **This is the storage/cache pattern to replicate.**
- ⚠️ `JournalThemes.tsx` is currently a **placeholder** ("Under Construction"), not
  the live feature — so the UI side is greenfield.
- ⚠️ `trading_days.overall_grade` / `process_score` columns **may not exist** (route
  has 42703 error-recovery → 503). Confirm before relying on them for correlation;
  else derive from `eod_ai_analysis_json` (`execution.composite`, `process.verdict`).
- Weekly recap has its OWN `themes[]` (AI-synthesized in `analyze-week`, cached in
  `weekly_recap` table) — separate from `eod_themes_analysis`; don't conflate.

### Free-text source inventory — CONFIRMED (3rd agent)
All trader-authored (exclude AI outputs `ai_analysis_json` / `eod_ai_analysis_json`
/ `ai_synthesis_json` and `recording_commentary`, which is AI vision text):
- **Prep** → `trading_days.prep_notes_json` (JSONB `PrepNotes`): `bias_notes`,
  `setups_areas`, `volume_profile_notes`, `mood`, `market_clarity`, and
  `trade_plans[].{setup_name, invalidation, targets, scary_factors, quality_reasons}`.
  PLUS a separate `daily_prep.notes` (text — condition-lookup observation).
  Written via `/api/trading-days/[date]` POST + `/api/daily-prep/[date]` POST.
- **Intraday** → `trades.notes` (text). (`recording_commentary` = AI, exclude.)
- **EOD** → `trading_days.eod_notes` (text). Written by `EodNotesForm`.
- **Weekly** → `weekly_recap.notes_md` (text) — **YES, trader-authored** ("Your
  weekly notes", `WeeklyRecapClient.tsx`, `/api/weekly-recap/[weekStart]` PUT).
  So weekly IS a source (earlier "likely AI-only" was wrong).
- **Multi-tenant:** core tables (`trading_days`, `trades`, `weekly_recap`,
  `daily_prep`) have **no explicit `user_id`** — isolation is via RLS `auth.uid()`
  in `schema.public.sql` + the session client. So per-user scoping needs NO new
  user_id on these; a new heatmap CACHE table should follow `eod_themes_analysis`
  (RLS + `user_id` overlaid in schema.public.sql via `userConflict(...)`).
