@echo off
setlocal EnableExtensions
title Deploy Documentary Studio
cd /d "%~dp0"
rem Updates a copy on your server from GitHub:   deploy.bat staging    deploy.bat main    deploy.bat all

where ssh >nul 2>&1
if errorlevel 1 (
  echo [ERROR] ssh is missing. Windows: Settings - Apps - Optional features - add "OpenSSH Client".
  pause
  exit /b 1
)

rem ---- server details, saved in deploy.config - not pushed to GitHub
set "SERVER="
set "APP_DIR=/opt/documentary-studio"
if exist "deploy.config" for /f "usebackq tokens=1,* delims==" %%a in ("deploy.config") do set "%%a=%%b"
if not "%SERVER%"=="" goto have_server
echo First time: where is your server?
set /p "SERVER=SSH login, e.g. root@123.45.67.89: "
if "%SERVER%"=="" exit /b 1
> "deploy.config" (
  echo SERVER=%SERVER%
  echo APP_DIR=%APP_DIR%
)
echo Saved to deploy.config.
:have_server

set "TARGET=%~1"
if not "%TARGET%"=="" goto have_target
echo.
echo Copies on %SERVER%:
ssh -t %SERVER% "sudo bash %APP_DIR%/studio.sh list"
echo.
set /p "TARGET=Which copy to update (e.g. staging, main, all): "
if "%TARGET%"=="" exit /b 1
:have_target

rem ---- unpushed work? Deploying only takes what is on GitHub.
set "DIRTY="
for /f %%s in ('git status --porcelain 2^>nul') do set "DIRTY=1"
set "AHEAD=0"
for /f %%n in ('git rev-list --count @{u}..HEAD 2^>nul') do set "AHEAD=%%n"
if defined DIRTY goto ask_push
if not "%AHEAD%"=="0" goto ask_push
goto deploy

:ask_push
echo.
echo You have changes on this PC that aren't on GitHub yet, so the server won't get them.
choice /m "Push them first with git_push.bat"
if errorlevel 2 goto deploy
call "%~dp0git_push.bat" "" nopause
if errorlevel 1 exit /b 1

:deploy
if /i "%TARGET%"=="main" (
  echo.
  echo  main is your LIVE site.
  choice /m "Deploy to main now"
  if errorlevel 2 exit /b 1
)
echo.
echo ==== Updating '%TARGET%' on %SERVER% ====
ssh -t %SERVER% "sudo bash %APP_DIR%/studio.sh update %TARGET%"
if errorlevel 1 (
  echo.
  echo [ERROR] The update reported a problem - read the messages above.
  echo         Logs: ssh %SERVER% "sudo bash %APP_DIR%/studio.sh logs %TARGET%"
  pause
  exit /b 1
)
echo.
echo  Deployed '%TARGET%'.
pause
