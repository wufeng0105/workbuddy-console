@echo off
REM ============================================================
REM  WorkBuddy Console -- double-click launcher
REM
REM  Window open  = server running
REM  Window close  = server stopped
REM
REM  ASCII only on purpose: cmd.exe mangles non-ASCII batch files
REM  under some code pages (verified: Chinese text broke parsing).
REM  All user-facing Chinese text is printed by src\launch.mjs,
REM  which writes UTF-8 and is not affected.
REM ============================================================

setlocal
chcp 65001 >nul 2>&1
title WorkBuddy Console

REM Double-click sets cwd to somewhere else; always switch here first.
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [x] Node.js not found.
  echo.
  echo       This tool needs Node 20+ . No npm install required.
  echo       Download: https://nodejs.org/
  echo.
  pause
  exit /b 2
)

if not exist "src\launch.mjs" (
  echo.
  echo   [x] src\launch.mjs not found.
  echo       Keep this file next to the src folder.
  echo.
  pause
  exit /b 2
)

REM Foreground run: server lifetime == this window's lifetime.
node "src\launch.mjs" %*
set EXITCODE=%errorlevel%

echo.
if not "%EXITCODE%"=="0" echo   [exit %EXITCODE%] See messages above.
echo   You can close this window now.
echo.
pause
endlocal
