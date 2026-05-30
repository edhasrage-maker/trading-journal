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

`src/components/charts/LiveChart.tsx` carries **4 pre-existing `react-hooks/set-state-in-effect` errors** (load-prefs effect, hasSavedView effect, two more) — they're committed and the dev build runs fine. Don't try to "fix" them by ripping out the patterns; they're load-from-localStorage shims that need to setState in the effect. The rule fires inconsistently — when adding new sync `setState` in an effect, add `// eslint-disable-next-line react-hooks/set-state-in-effect -- <reason>` only if eslint actually flags it.

## Recently shipped (latest commits on `feat/chart-migration-phase-1`)

- Live chart (lightweight-charts v5) with VWAP/EMA/session-level lines, working saved zoom, row-hover ↔ chart crosshair link, AI Overview column per trade.
- Background `BarWatcher` auto-imports today's bars from `.scid` every 3 min.
- Tradezella import (`scripts/import-tradezella.ts`) + tag normalizer (`src/lib/tradezella-import.ts`); analytics UNIONs historical + native trades.
- Analytics: paginated trades query (essential — without it, only the *oldest 1000* trades load and recent tagged trades drop out of the date filter), collapsible sections.
- OBS recording → AI per-trade frame commentary MVP (`/api/video/commentary`, `src/components/eod/RecordingCommentary.tsx`). Plan file: `C:\Users\lamed\.claude\plans\jiggly-swimming-axolotl.md`.
- EOD trade row click → intraday log deep-link.

## Open threads (not blocking, but pick these up if relevant)

- **Tag near-duplicates from the Tradezella import** (e.g. `Break And Retest` vs `Break & Retest`, `Supply And Demand` vs `Supply & Demand`). The matcher does alphanumeric-only comparison, so `&` ↔ `and` doesn't fold. A small follow-up: extend `tagKey` in `src/lib/tradezella-import.ts` to normalize `&` → `and`, re-run the import (idempotent), and offer a tag-merge UI for residual dupes.
- **Tradezella re-import is script-only.** If the user re-exports periodically, the next step is a Settings → Tradezella re-import UI (mirror the SCID importer's dropdown pattern at `src/components/settings/BarImportClient.tsx`).
- **OBS video commentary MVP needs evaluation on a real session.** Current scope is frame-only (entry + exit JPEGs per trade). The high-value follow-up is audio: Whisper transcription aligned to fill times so the coach can compare *intent at the moment* to outcome. Don't build it until the frame version has been judged useful.
- **Video commentary persistence.** Results currently cache in `localStorage` only. If the feature lands, add a `trades.recording_commentary` column or a small `trade_commentary` table.
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
