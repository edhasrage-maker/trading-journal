@echo off
REM Trading Journal — Next.js dev server launcher
REM
REM Behavior:
REM   - Idempotent on launch: if port 3000 already has a listener, exits silently.
REM   - Auto-restart loop: if npm run dev exits (crash OR Ctrl+C), waits 10s and
REM     relaunches. To stop the loop, close this terminal window (don't Ctrl+C).
REM
REM Used by Windows Task Scheduler for auto-start on login/unlock.
REM Loop added 2026-05-31 so the dev server survives mid-session kills.

setlocal
cd /d "%~dp0"

REM Skip if another instance is already listening on port 3000
netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
  echo. >> "%~dp0start-journal.log"
  echo === Skipped at %date% %time% — port 3000 already in use === >> "%~dp0start-journal.log"
  endlocal
  exit /b 0
)

:LOOP
echo. >> "%~dp0start-journal.log"
echo === Starting at %date% %time% === >> "%~dp0start-journal.log"

call npm run dev >> "%~dp0start-journal.log" 2>&1

echo. >> "%~dp0start-journal.log"
echo === Exited at %date% %time% (exit code %errorlevel%) — restarting in 10s === >> "%~dp0start-journal.log"
timeout /t 10 /nobreak >nul

REM Re-check port (in case something else grabbed it during the 10s window)
netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
  echo === Port 3000 now in use by another process — exiting loop === >> "%~dp0start-journal.log"
  endlocal
  exit /b 0
)
goto LOOP
