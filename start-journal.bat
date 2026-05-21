@echo off
REM Trading Journal — Next.js dev server launcher
REM Idempotent: exits silently if port 3000 already has a listener.
REM Used by Windows Task Scheduler for auto-start on login/unlock.

setlocal
cd /d "%~dp0"

REM Check if anything is already listening on port 3000
netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
  echo. >> "%~dp0start-journal.log"
  echo === Skipped at %date% %time% — port 3000 already in use === >> "%~dp0start-journal.log"
  endlocal
  exit /b 0
)

echo. >> "%~dp0start-journal.log"
echo === Starting at %date% %time% === >> "%~dp0start-journal.log"

call npm run dev >> "%~dp0start-journal.log" 2>&1

endlocal
