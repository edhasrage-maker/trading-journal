@echo off
REM Public bar feed — LOCAL agent that keeps tapescore.app's live chart current.
REM
REM Reads today's NQ + ES 1-minute bars from your Sierra .scid files and pushes
REM them to the PUBLIC Supabase feed (keyed by the NQ/ES root the cloud chart
REM queries). The cloud can't read .scid itself, so this MUST run on your
REM machine. Loops every 3 min — same cadence as the in-app BarWatcher.
REM
REM SETUP (once):
REM   1. Create .env.public-feed in the repo root:
REM        PUBLIC_SUPABASE_URL=https://dmutgkycrjudfejswvhg.supabase.co
REM        PUBLIC_SUPABASE_SERVICE_ROLE_KEY=<your new sb_secret_ key>
REM   2. One-time backfill so the chart has session-level lookback + history:
REM        npx tsx scripts/public-bar-feed.ts --days 30
REM   3. Schedule THIS file on login via Task Scheduler (see start-bar-feed.log
REM      for run output). Keep NQ + ES charts open in Sierra so .scid stays live.
REM
REM Off-hours / weekends print "no ticks" and skip — harmless. Close this window
REM to stop the loop (don't Ctrl+C).

REM Single-instance is handled by Task Scheduler's "Do not start a new instance"
REM setting (see SETUP), so no lock file is needed here.

setlocal
cd /d "%~dp0"

:LOOP
echo. >> "%~dp0start-bar-feed.log"
echo === Run at %date% %time% === >> "%~dp0start-bar-feed.log"
call npx tsx scripts/public-bar-feed.ts >> "%~dp0start-bar-feed.log" 2>&1
REM Wait ~3 min before the next push, then repeat.
timeout /t 180 /nobreak >nul
goto LOOP
