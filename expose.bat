@echo off
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found. Install it from https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules\@pinggy\pinggy (
  echo Installing pinggy SDK, please wait...
  call npm install @pinggy/pinggy --no-audit --no-fund
)

echo.
echo Starting public tunnel...
node tunnel.js
pause
