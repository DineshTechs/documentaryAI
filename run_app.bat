@echo off
setlocal EnableExtensions
title Documentary Studio
cd /d "%~dp0"
rem Runs Documentary Studio on this PC (Windows). Needs Node.js 18+ from https://nodejs.org

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from nodejs.org, then run this again.
  start "" https://nodejs.org/
  pause
  exit /b 1
)

set "NEED_INSTALL="
if not exist "node_modules\@napi-rs\canvas" set "NEED_INSTALL=1"
if not exist "node_modules\mongodb" set "NEED_INSTALL=1"
if defined NEED_INSTALL (
  echo Installing packages - takes a minute...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] npm install failed - read the messages above.
    pause
    exit /b 1
  )
)

if exist ".env" goto env_ok
:ask_pw
set "PW="
set /p "PW=Choose a login password for the app (letters and numbers): "
if "%PW%"=="" goto ask_pw
for /f "delims=" %%k in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N')"') do set "SK=%%k"
> ".env" (
  echo # Local settings - private, not pushed to GitHub
  echo APP_PASSWORD=%PW%
  echo SECRET_KEY=%SK%
  echo PORT=3000
)
:env_ok

rem ---- port from .env (default 3000)
set "PORT=3000"
for /f "usebackq tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="PORT" set "PORT=%%b"
set "PORT=%PORT: =%"

rem ---- is something already using the port?
set "OLDPID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do if not defined OLDPID set "OLDPID=%%p"
if not defined OLDPID goto port_free
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -TimeoutSec 3 http://127.0.0.1:%PORT%/api/health; if ($r.app -eq 'documentary-studio' -or $r.PSObject.Properties.Name -contains 'logged_in') { exit 0 } else { exit 1 } } catch { exit 1 }"
if errorlevel 1 goto port_other
echo An older copy of Documentary Studio is still running on port %PORT% - stopping it...
taskkill /PID %OLDPID% /T /F >nul 2>&1
timeout /t 2 /nobreak >nul
goto port_free
:port_other
echo.
echo [!] Port %PORT% is used by another program (process ID %OLDPID%).
tasklist /FI "PID eq %OLDPID%" /NH
echo Close that program, or put a different port in .env, e.g.  PORT=3001
echo.
pause
exit /b 1
:port_free

start "" /min cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:%PORT%"
echo.
echo  Documentary Studio: http://localhost:%PORT%   -  close this window to stop it.
echo.
node app.js
pause
