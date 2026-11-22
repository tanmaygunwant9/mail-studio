@echo off
cd /d "%~dp0"
call npm ci --no-fund --no-audit
if errorlevel 1 (
  echo Installation failed. Install Node.js 22 or newer and check your connection.
) else (
  echo Ready. Double-click Start Mail Studio.vbs to open the website.
)
pause
