@echo off
setlocal EnableExtensions
title Deploy Documentary Studio
cd /d "%~dp0"
rem Update a copy of the app on your hosting over SSH:   deploy.bat staging    deploy.bat main
rem It runs: git pull, npm install, restart. Settings are kept in deploy.config (not pushed to GitHub).

where ssh >nul 2>&1
if errorlevel 1 (
  echo [ERROR] ssh is missing. Windows: Settings - Apps - Optional features - add "OpenSSH Client".
  pause
  exit /b 1
)

set "SERVER="
set "SSH_PORT=22"
set "RESTART=mkdir -p tmp && touch tmp/restart.txt"
if exist "deploy.config" for /f "usebackq eol=# tokens=1,* delims==" %%a in ("deploy.config") do set "%%a=%%b"
if not "%SERVER%"=="" goto have_server
echo First time: how do you log in to your hosting with SSH?
echo   cPanel: user name @ server, e.g. document1@velocity.yourhost.com  (cPanel - SSH Access shows it)
set /p "SERVER=SSH login: "
if "%SERVER%"=="" exit /b 1
set /p "SSH_PORT=SSH port (press Enter for 22): "
if "%SSH_PORT%"=="" set "SSH_PORT=22"
> "deploy.config" (
  echo # Documentary Studio deploy settings - private, not pushed to GitHub
  echo SERVER=%SERVER%
  echo SSH_PORT=%SSH_PORT%
  echo # Restart command. cPanel Node.js apps: mkdir -p tmp ^&^& touch tmp/restart.txt   VPS with pm2: pm2 restart studio
  echo RESTART=mkdir -p tmp ^&^& touch tmp/restart.txt
)
echo Saved to deploy.config.
:have_server

set "TARGET=%~1"
if not "%TARGET%"=="" goto have_target
echo.
echo Known copies:
findstr /b "APP_" deploy.config 2>nul
set /p "TARGET=Which copy to update (e.g. staging, main): "
if "%TARGET%"=="" exit /b 1
:have_target

rem ---- folder of this copy on the server (asked once, then saved)
set "APP="
call set "APP=%%APP_%TARGET%%%"
if not "%APP%"=="" goto have_app
set "DEF=documentaryAI"
if /i not "%TARGET%"=="main" set "DEF=documentaryAI-%TARGET%"
set /p "APP=Folder of '%TARGET%' in your hosting home folder (Enter for %DEF%): "
if "%APP%"=="" set "APP=%DEF%"
>> "deploy.config" echo APP_%TARGET%=%APP%
:have_app

rem ---- unpushed work? The server only gets what is on GitHub.
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
echo ==== Updating '%TARGET%' (~/%APP%) on %SERVER% ====
ssh -t -p %SSH_PORT% %SERVER% "cd ~/%APP% && git pull --ff-only && for f in ~/nodevenv/%APP%/*/bin/activate; do [ -f $f ] && . $f; done; npm install --omit=dev --no-audit --no-fund && %RESTART% && echo && echo Deployed - the app restarts on its next visit."
if errorlevel 1 (
  echo.
  echo [ERROR] The update reported a problem - read the messages above.
  echo         If git says local changes would be overwritten, don't edit files on the server.
  pause
  exit /b 1
)
echo.
echo  Deployed '%TARGET%'.
pause
