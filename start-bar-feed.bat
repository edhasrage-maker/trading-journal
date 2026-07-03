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

setlocal
cd /d "%~dp0"

REM Skip if another instance is already running (crude single-instance guard via
REM a lock file that this window holds open).
if exist "%~dp0.cache\bar-feed.lock" (
  echo === Skipped at %date% %time% — lock present === >> "%~dp0start-bar-feed.log"
  endlocal
  exit /b 0
)
if not exist "%~dp0.cache" mkdir "%~dp0.cache"
echo %date% %time% > "%~dp0.cache\bar-feed.lock"

:LOOP
echo. >> "%~dp0start-bar-feed.log"
echo === Run at %date% %time% === >> "%~dp0start-bar-feed.log"
call npx tsx scripts/public-bar-feed.ts >> "%~dp0start-bar-feed.log" 2>&1
REM Wait ~3 min before the next push, then repeat.
timeout /t 180 /nobreak >nul
goto LOOP
