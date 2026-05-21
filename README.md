# Trading Journal

A personal cloud-hosted trading journal for Sierra Chart users.
Covers the full day: pre-market prep → intraday trade tagging → end-of-day recap → macro analytics.

**Stack:** Next.js 14 (App Router) + TypeScript + Tailwind · Supabase (Postgres + Storage + Auth) · Anthropic Claude (AI prep & EOD analysis) · html2canvas (Discord dashboard PNG export).

## Quick start (new machine)

Prerequisites: **Node.js 20+**, **git**.

```bash
git clone https://github.com/edhasrage-maker/trading-journal.git
cd trading-journal
npm install
cp .env.local.example .env.local       # then edit .env.local — see below
npm run dev
```

Open <http://localhost:3000>, log in via magic link, you're in.

## Environment variables

Create a `.env.local` file in the project root with the following four values (template in `.env.local.example`):

| Key | Where to find it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Dashboard → Project Settings → API → "Project URL" |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same page → "Project API keys" → `anon` `public` key |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page → `service_role` `secret` key (used by server routes for privileged ops) |
| `ANTHROPIC_API_KEY` | <https://console.anthropic.com/> → Settings → API Keys |

The `.env.local` file is gitignored and never leaves your machine. When setting up on a second machine, copy the file over from the first or recreate it by hand.

## Database setup

The full schema lives in [`supabase/schema.sql`](supabase/schema.sql). On a fresh Supabase project, paste the file into the SQL Editor and run it. It's idempotent (all statements are `if not exists` / `or replace`) so re-running picks up any added columns safely.

Two storage buckets need to exist (create in Supabase Dashboard → Storage):

- `screenshots` — chart and trade entry screenshots
- `sc-logs` — Sierra Chart trade log uploads

## Daily workflow

```bash
git pull            # before you start — grab anything pushed from another machine
npm run dev         # start the dev server
# ... use the app at localhost:3000 ...
# if you made code changes:
git add .
git commit -m "<what you changed>"
git push            # send to GitHub so your other machine can pull
```

Trading data (trades, prep notes, screenshots, condition lookup) lives in Supabase, so it's automatically in sync across machines. Only the code itself needs `git pull/push`.

## App overview

Pages (all under `/`):

- **`/dashboard`** — today's actions, 30-day stats, recent days list
- **`/prep/[date]`** — daily prep: chart screenshot + AI auto-fill of market context, prep notes, day type, trade plans, AI prep analysis, Discord dashboard export, **Morning Conditions** filter (5-metric condition lookup → verdict)
- **`/intraday/[date]`** — paste a trade screenshot, click to drop entry/stop/TP1 pins, AI-extract trade levels, tag the trade
- **`/eod/[date]`** — upload day chart, calibrate axes, trade arrows auto-positioned, EOD notes + AI session analysis, **Import SC log** + auto-watch SC folder
- **`/journal`** — calendar heatmap of daily P&L, click any day to drill in
- **`/analytics`** — macro performance: setup tag breakdown, condition buckets, rolling equity curve, CSV export
- **`/settings/tags`** — tag library management
- **`/settings/stats`** — performance-stats CSV upload
- **`/settings/condition-lookup`** — refresh the morning-prep condition filter from CSVs
- **`/settings/sc-logs`** — manage archived SC log files

## Sierra Chart integration

1. In SC: right-click the Trade Activity Log window → **Export Window Contents to Text File** → tab-delimited
2. Save (or have SC auto-save) to `C:\SierraChart\TradeActivityLogs\`
3. Open the journal at `/eod/{today}`, click **Watch folder**, point at that directory
4. From then on (while the tab is open), new `TradeActivityLog_YYYY-MM-DD*.txt` files auto-import every 60s with the date parsed from the filename

The importer aggregates per-trade fills into single trade rows by position round-trip, computes dollar P&L using the symbol's multiplier (MNQ=$2, NQ=$20, ES=$50, etc. — see `src/lib/sc-importer.ts`), and dedups re-imports via the `sierra_trade_id` partial unique index on `trades`.

Account filter: only "live" accounts pass through (anything not matching `Sim*` / `None`). Edit `SIM_ACCOUNT_RE` in `src/lib/sc-importer.ts` if you want sim trades to import too.

## Auto-starting the dev server (Windows)

`start-journal.bat` launches `npm run dev` in the background and logs to `start-journal.log`. Idempotent — if port 3000 is already in use, exits silently.

To auto-start on login:

1. Open **Task Scheduler** → **Create Basic Task**
2. Name: `Trading Journal Dev Server`
3. Trigger: **When I log on** (and optionally also **On workstation unlock**)
4. Action: **Start a program** → browse to `start-journal.bat`
5. Properties → Settings → uncheck "Stop the task if it runs longer than"

The bat file's port-check makes it safe to fire multiple times — duplicates no-op.

## Useful scripts

- `npm run dev` — Next.js dev server with hot reload
- `npm run build` — production build
- `npm run lint` — ESLint
- `node scripts/test-sc-import.mjs <path>` — parse an SC log file and print what trades the importer would emit (no DB writes)

## Deployment

Cloud-hosted via Vercel. After importing the repo into Vercel:

1. Paste the same 4 env vars into Vercel project settings
2. `git push` triggers a new build automatically
3. Both machines bookmark the resulting `*.vercel.app` URL → no more local dev server needed for routine journaling

## Project structure

```
src/
  app/                       # Next.js App Router
    (app)/                   # Authenticated routes
      dashboard/  prep/  intraday/  eod/  journal/  analytics/  settings/
    api/                     # Server routes
      analyze-prep/  analyze-eod/  extract-context/  extract-trade/
      spell-check/  trades/  trading-days/  screenshots/  import-sc-log/
      condition-lookup/  daily-prep/  export-csv/
  components/
    prep/  intraday/  eod/  journal/  analytics/  condition/  settings/
    charts/                  # Reusable SVG bar/line charts
  lib/
    supabase/                # Server + browser clients, types
    sc-importer.ts           # SC trade log parser
    condition-lookup.ts      # Morning-prep condition filter math
    analytics.ts             # Performance aggregation helpers
    eod-transforms.ts        # Chart calibration coord transforms
    resilient-upsert.ts      # Schema-cache-tolerant upserts
    storage.ts               # Supabase Storage helpers
    word-diff.ts             # Spell-check diff highlighting
supabase/
  schema.sql                 # Full DB schema (idempotent)
scripts/
  test-sc-import.mjs         # Standalone SC parser tester
start-journal.bat            # Windows auto-start launcher
```

## License

Private — single-user personal project. Not for redistribution.
