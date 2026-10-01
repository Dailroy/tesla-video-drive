@echo off
setlocal
cd /d "%~dp0"

rem --- need admin so the server can also bind port 80 (http://<ip> without a port)
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found. Install it from https://nodejs.org
  pause
  exit /b 1
)

rem --- open inbound ports for the Tesla (safe, idempotent)
netsh advfirewall firewall add rule name="Tesla Video 80" dir=in action=allow protocol=TCP localport=80 >nul 2>&1
netsh advfirewall firewall add rule name="Tesla Video 8742" dir=in action=allow protocol=TCP localport=8742 >nul 2>&1

if not exist node_modules (
  echo Installing node modules, please wait...
  call npm install
)

echo.
echo ============================================================
echo  Server is starting. Wait for the lines "Open in Tesla: ..."
echo  Then open that address in the Tesla browser.
echo ============================================================
echo.
node server\server.js
pause
