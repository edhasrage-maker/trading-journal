# Project notes for Claude

You're working on a personal trading journal that's been built across many sessions. This file captures the *Claude-relevant* context — architecture quirks, conventions, tolerated lint, and open threads. Read it once at the start of every session so you don't relearn the same gotchas. The user's README.md is for *humans onboarding the app*; that's a different doc.

## Architecture

- **Stack:** Next.js 16 (App Router, Turbopack) · TypeScript · Tailwind · Supabase (Postgres + Storage + Auth) · `@anthropic-ai/sdk` (model `claude-sonnet-4-6`) · lightweight-charts v5 · Recharts where used.
- **Critically: the dev server runs LOCALLY on the user's Windows machine** — same machine as Sierra Chart. Server routes can (and do) read local files: `.scid` market data via `src/lib/scid-reader.ts`, OBS recordings via `src/lib/video-frames.ts` (ffmpeg/ffprobe), and the user's `D:\SierraCharts\Data` directory. Designs that assume a cloud server are wrong here.
- **Two synced machines.** The project lives on two Windows machines via GitHub. Same Supabase backend; SQL changes happen *live* on Supabase, the user runs them in the dashboard, then we update `supabase/schema.sql` to match.

## Dev server quirks

- **Always launch dev with `unset ANTHROPIC_API_KEY && npm run dev`.** Claude Code leaks an empty `ANTHROPIC_API_KEY` env var that overrides `.env.local`, making every Anthropic-backed route return 503. This is a known leak — work around it, don't fight it.
- `start-journal.bat` is the production launcher (Task Scheduler runs it on login). `start-journal.log` is the rolling dev log — `tail -n 5 start-journal.log` is the fastest "did it compile / did the request land?" check.
- Hot-reload is Turbopack — fast but **doesn't run full TypeScript checks**. Always end a code change with `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "<filename>"`. ESLint runs cleanly via `npx eslint <files>`.

## Data model (Supabase)

| Table | Holds |
|---|---|
| `trading_days` | One row per session date. Owns prep notes, EOD AI analysis, day_type, eod_pnl override. |
| `trades` | Per-trade fills (linked by `trading_day_id`). `entry_time`/`exit_time` are timestamptz, seconds-precise from Sierra import. `exits_json` is `[{time, price, qty}]` for multi-leg exits. `tags_json` shape is `{ setups: string[], confluences: string[], order_flow: string[], trade_management: string[], day_type: string, mistakes: string[], emotions: string[] }`. |
| `trade_tags` | Tag library. `category` ∈ those 7 keys above. |
| `market_context` | Per-day RVOL, ADR, ATR, IB size, PDH/PDL/IBH/IBL etc. — feeds analytics condition buckets. |
| `historical_trades` | Separate read-only store for imported Tradezella history (915 rows in DB). Analytics page UNIONs this with `trades` for long-term tag analysis. Synthesized `stop_price` from `realized_rr` so Avg R includes them. |
| `ohlcv_bars` / `bar_imports` | 1-minute bars for the Live chart, imported from `.scid` via `/api/bars/import-scid` or auto-refreshed by `BarWatcher`. |
| `daily_prep` / `condition_*` / `lookup_metadata` / `performance_stats` | Various supporting tables; consult `supabase/schema.sql` when relevant. |

RLS is enabled on every table with one policy: `for all using (auth.role() = 'authenticated')`. New tables should match.

## Conventions

- **Dates** are `YYYY-MM-DD` strings in API params and URLs. Timestamps are stored UTC; the UI displays America/Los_Angeles by convention.
- **Market sessions are exchange-anchored**, not user-anchored. RTH is 06:30–13:00 PT, ETH starts 15:00 PT prior day. See `src/lib/session-levels.ts` (TypeScript port of the Sierra `EdhasrageSessionLevels` study).
- **Supabase row cap is 1000.** Anything that may exceed (`trades`, `historical_trades`, sometimes `ohlcv_bars`) must paginate with `.range(p*PAGE, p*PAGE + PAGE - 1)` and order with an `id` tiebreaker for deterministic paging. Reference implementation: `src/app/(app)/analytics/page.tsx`.
- **AI routes** follow a common pattern: `new Anthropic()` at module scope, `claude-sonnet-4-6`, JSON-out prompts with a `text.match(/\{[\s\S]*\}/)` fallback parser. Multimodal images use base64 + `normalizeAnthropicMediaType` from `src/lib/anthropic-image.ts`. Examples: `/api/analyze-eod`, `/api/trades/summary`, `/api/video/commentary`.
- **Live chart view persistence** uses a *logical* (bar-index) range stored under `livechart-view-v3-{symbol}-{date}`, restored once per day-open inside `requestAnimationFrame` (synchronous `setVisibleLogicalRange` after `setData` gets clobbered by the library's auto-fit a frame later). VWAP/EMA/trade-line series set `autoscaleInfoProvider: () => null` so only the candles drive the price axis.
- **Co-author tag on commits**: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. Use this verbatim.

## Tolerated lint

`src/components/charts/LiveChart.tsx` previously carried 4 pre-existing `react-hooks/set-state-in-effect` errors plus an unused-var warning; all resolved. General rule still applies: when adding sync `setState` in an effect for load-from-localStorage hydration, add `// eslint-disable-next-line react-hooks/set-state-in-effect -- <reason>` ONLY if eslint actually flags it; the rule fires inconsistently across files.

## Recently shipped (active branch: `feat/tag-taxonomy-cleanup-restore`, unmerged PR open)

- Live chart (lightweight-charts v5) with VWAP/EMA/session-level lines, working saved zoom, row-hover ↔ chart crosshair link, AI Overview column per trade. Per-(symbol, date) TF persistence — each day remembers its own timeframe. Exit fills grouped per time bucket; on-hover ribbons highlight; per-fill detail in popup, not on chart markers.
- LiveChart mounted on prep page too (with screenshot/live toggle, defaults to Live). Analyze Prep auto-snaps the LiveChart canvas as a fallback chart-read image when no Sierra screenshot has been uploaded.
- Background `BarWatcher` auto-imports today's bars from `.scid` every 3 min.
- Tradezella import (`scripts/import-tradezella.ts`) + tag normalizer (`src/lib/tradezella-import.ts`); analytics UNIONs historical + native trades. `tagKey()` folds `&` → `and` (so `Break & Retest` and `Break And Retest` dedupe).
- Analytics: paginated trades query (essential — without it, only the *oldest 1000* trades load and recent tagged trades drop out of the date filter), collapsible sections, new `PeriodComparison` section (week-by-week / month-by-month with delta chips).
- Dashboard rebuild: period selector (Week / Month / 30d / YTD / Last Year), 5 stat cards (P&L / Day Win % / Trade Win % / Avg MFE-MAE with pts/$/×ATR toggle / Median Process), combined `day_types[]` chip with array-aware filter, Today tile cascades Intraday→green once EOD is Completed.
- EOD recap polish: W/L inline, `MAE %` no-wrap, ? help popups on stats columns and trade table headers, whole-dollar PnL.
- OBS recording → AI per-trade frame commentary MVP (`/api/video/commentary`, `src/components/eod/RecordingCommentary.tsx`). DB persistence + localStorage→DB backfill landed. Plan file: `C:\Users\lamed\.claude\plans\jiggly-swimming-axolotl.md`.
- EOD trade row click → intraday log deep-link.
- Day's Range + current_price + auto-flag stats (rvol/adr/atr) — extracted from Sierra screenshot via `extract-context`, written to `market_context.day_range`; DR_ADR pill reactive to context updates; auto-applied bucket-driven flags in `MarketContextForm`.

## Open threads (not blocking, but pick these up if relevant)

- **In-app tag creation doesn't dedupe via `tagKey()`.** The `&` → `and` fold in `tagKey()` (`src/lib/tradezella-import.ts`) already handles Tradezella imports, but the in-app TagSelector flow does an exact-label match before inserting. Result: case-only variants (e.g. `Waited for 2x Failed Attempts` vs `Waited For 2x Failed Attempts`) get created as separate rows. Follow-up: switch in-app tag creation to the same key-based dedup the importer uses.
- **Tag-merge UI for residual near-duplicates.** Even with key-based dedup, manual variants accumulate (typos, plurals, qualifier differences). A Settings → Tags merge view that surfaces edit-distance ≤ 2 pairs and offers "Merge A into B" (rewrites `tags_json` across trades, deletes A) is the proper general-purpose fix. Bigger lift than the in-app dedup above.
- **`day_types[]` migration: dashboard done, calendar + analytics still on singular.** `CalendarClient.tsx` filter and `AnalyticsClient.tsx`'s `aggregateByDayType` both read `day_type` (singular). Combo days only count under their primary tag in those two views. Dashboard's `RecentDaysList` + `RecentDaysSection` were migrated to the array; calendar/analytics are the same pattern when ready. For analytics specifically, design decision needed: should a combo-day trade count under EACH tag, or only under the combo as a unit?
- **Tradezella re-import is script-only.** If the user re-exports periodically, the next step is a Settings → Tradezella re-import UI (mirror the SCID importer's dropdown pattern at `src/components/settings/BarImportClient.tsx`).
- **OBS video commentary MVP needs evaluation on a real session.** Current scope is frame-only (entry + exit JPEGs per trade). The high-value follow-up is audio: Whisper transcription aligned to fill times so the coach can compare *intent at the moment* to outcome. Don't build it until the frame version has been judged useful. (Persistence to DB landed in this session — `RecordingCommentary.tsx` now backfills localStorage → DB.)
- **Process vs Grade scoring — Ruleset v1.3 amended 3× on 2026-06-08, current shape = "v1.4".** Architecture: `/api/analyze-prep` produces `ai_analysis_json.score` = **Prep Quality** (UI label; storage field `process_score` unchanged). `/api/analyze-eod` produces `eod_ai_analysis_json.process` (verdict + per-rule statuses) and `.execution` (sub-metrics + composite). Amendments 2026-06-08: (1) verdict threshold relaxed "all 7 pass" → "5 of 7 pass"; (2) added prep_adherence sub-metric; (3) **major restructure**. After amendment 3: Process drops to **5 hard safety-rail rules** (P1 DLL, P2 size cap, P3 no-size-up-after-loss, P4 cooldown ≥90s, P5 trade cap ≤7). Old P4 (stop validity) and old P7 (setup validity) moved INTO a new Execution sub-metric called **Execution Parameters** (35% weight, 9-criterion per-trade checklist: setup-in-playbook, stop in 0.5-1.5 ATR, TP1 ≥ 2R or reasoned, clear AOI, 2/3 OF reads, Break of Cluster/Bubble entry, chart-not-emotion management, no mistakes tagged, Stable emotion). Duration-to-thesis sub-metric **REMOVED** entirely. New Execution weights: Exec Params 35%, MFE 20%, Prep 20%, MAE 15%, RR 10%. Verdict threshold: **≥4/5 = Compliant**. Dashboard Process column derives 0-10 from `pass_count/5 × 10` so values land in {0,2,4,6,8,10}; tooltip says "Compliant — N/10 (≥4/5 rules pass)" or "Breach — Pn, Pm failed". Banded coloring: 10 deep green, 8 emerald (at threshold), 6 orange (just-under breach), 4 red, 2 deeper red, 0 darkest. EOD `max_tokens` 6000; prompt has LENGTH DISCIPLINE block + markdown-fence stripping in parser. Trade block includes TP1 + exit_price for RR computation. Spec file `docs/Ruleset_v1.3_Process_Execution_Spec.md` is canonical — loaded verbatim into the EOD prompt at module scope. **Legacy data caveat:** pre-amendment-3 rows have P1-P7 keys + duration_to_thesis sub-metric. Dashboard process score ignores P6/P7 from old rows (shows understated score for those days). To refresh under v1.4, re-click "Analyze Session" on the day.
- **Morning Conditions view picker: default by trade count.** `condition-lookup.ts` `pickConsolidated()` currently chooses Median vs Tertile view by *specificity* (more constrained metrics wins, ties to median). Proposed change: default to whichever view has the larger trade count (sample size = more reliable stats), with a small dropdown to switch to the alternative view if needed. More intuitive than the specificity ladder.
- **LiveChart should auto-populate market_context levels.** Today the chart computes pdh/pdl/onh/onl/ibh/ibl deterministically from .scid bars via `session-levels.ts` and draws them as horizontal lines, but those values never reach `MarketContextForm` — the only auto-fill path is the screenshot → `/api/extract-context` flow. When the user toggles to "Live chart" instead of "Screenshot", the form fields stay empty even though the data is on-screen. Fix: add `onLevels?: (lvls: SessionLevels | null) => void` prop to LiveChart, fire on state update; PrepClient merges into marketContext for fields the user hasn't manually edited. Small (~30 lines across LiveChart + PrepClient).
- **"Take this public" planning — not started, no notes yet.** User wants a written plan covering scalability, IP protection (preventing model/prompt theft + journal-data privacy if multi-tenanted), and projected costs. Strategy conversation first, code second — should run in its own focused chat. Likely topics to cover: multi-tenancy via Supabase RLS scoping, Anthropic API key rotation + per-user usage caps, where the `.scid` reading lives (today: local file system — won't survive cloud deploy), pricing model + monthly costs at varying user counts, terms-of-service / data-handling disclosures.
- **Pre-existing `set-state-in-effect` lint errors** — see "Tolerated lint" above.

## Verification routine

After any code change:

1. `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "<changed-file>"` — must return blank.
2. `npx eslint <changed files>` — must return blank or only known-tolerated warnings.
3. `tail -n 2 start-journal.log` — confirm the dev server hot-reloaded clean (`✓ Compiled`).
4. **For schema or data shape changes**, query the live DB via service-role to confirm. Pattern:

   ```bash
   node -e "const fs=require('fs');for(const l of fs.readFileSync('.env.local','utf8').split(/\r?\n/)){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m)process.env[m[1]]=m[2].replace(/^[\"']|[\"']$/g,'');}const{createClient}=require('@supabase/supabase-js');const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);(async()=>{const{data,count}=await sb.from('TABLE').select('*',{count:'exact',head:true});console.log(count);})()"
   ```

5. For UI changes, the user can hard-reload at `http://localhost:3000/eod/<date>` or wherever the change lives. No browser MCP is paired (Claude-in-Chrome extension is not connected on this machine, last checked), so visual verification is on the user — surface logs / diagnostics in the code if a UI bug is hard to reason about.

## What to read first when picking up an unfamiliar area

- **Chart / Live chart anything**: `src/components/charts/LiveChart.tsx`, `src/lib/session-levels.ts`, `src/lib/scid-reader.ts`.
- **EOD page anything**: `src/components/eod/EodClient.tsx` (the orchestrator), `src/components/eod/TradeList.tsx`, `src/components/eod/RecordingCommentary.tsx`.
- **Intraday page**: `src/components/intraday/IntradayClient.tsx`, `src/components/intraday/TradeForm.tsx`.
- **Analytics**: `src/app/(app)/analytics/page.tsx` (server), `src/components/analytics/AnalyticsClient.tsx` (client orchestrator), `src/lib/analytics.ts` (pure aggregations), `src/components/analytics/TagPerformanceTable.tsx`.
- **AI surfaces**: `src/app/api/analyze-eod/route.ts`, `src/app/api/trades/summary/route.ts`, `src/app/api/video/commentary/route.ts`.
- **Schema reference**: `supabase/schema.sql` is the source of truth.
