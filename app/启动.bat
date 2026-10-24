@echo off
cd /d "%~dp0"
set "NODE="
if exist "runtime\node.exe" set "NODE=runtime\node.exe"
if not defined NODE (
  node -v >nul 2>nul
  if not errorlevel 1 set "NODE=node"
)
if not defined NODE (
  echo [ERROR] Node.js not found.
  echo Put node.exe into the runtime folder, or install Node.js from https://nodejs.org
  pause
  exit /b 1
)
start "GM-Team Server" /min "%NODE%" server.js
timeout /t 2 /nobreak >nul
start http://127.0.0.1:8787
