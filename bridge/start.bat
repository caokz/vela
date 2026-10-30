@echo off
rem Start Vela agent bridge (double-click).
rem Token file: %USERPROFILE%\.vela-bridge\token.json (paste once in extension settings).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found. Install Node.js 18+ first.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies (first run)...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)
echo Starting bridge (Ctrl+C to stop)...
node index.js
pause
