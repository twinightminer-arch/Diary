@echo off
setlocal
title Connect WorkBuddy CLI

set "CLI=%LOCALAPPDATA%\Programs\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy"

if not exist "%CLI%" (
  echo [x] codebuddy CLI not found at:
  echo     %CLI%
  echo     Please make sure the WorkBuddy desktop app is installed.
  pause
  exit /b 1
)

REM WorkBuddy injects SERVER__PORT into every child process. A standalone CLI
REM reads it, tries to bind that very port, collides with the running sidecar,
REM and then hangs forever without printing anything. Clearing these is required.
set "SERVER__PORT="
set "CODEBUDDY_SERVICE_PROXY_URL="
set "CODEBUDDY_SESSION_ID="

REM codebuddy is a Node script with no file extension, so Windows cannot run it
REM directly -- it has to be handed to a node runtime.
set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not exist "%NODE%" set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if not exist "%NODE%" (
  for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do set "NODE=%%D\node.exe"
)
if not exist "%NODE%" (
  echo [x] No node.exe found.
  echo     Install Node.js from https://nodejs.org and run this again.
  pause
  exit /b 1
)

echo.
echo   Using node: %NODE%
echo.
echo   In the codebuddy window that opens, type:
echo.
echo        /login
echo.
echo   Then finish the authorization in your browser.
echo   Once it says you are signed in, close that window.
echo.
pause

"%NODE%" "%CLI%"

echo.
echo codebuddy exited. You can close this window.
pause
