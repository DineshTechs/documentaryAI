@echo off
setlocal EnableExtensions
title Push to GitHub - documentaryAI
cd /d "%~dp0"

set "REPO_URL=https://github.com/DineshTechs/documentaryAI.git"

where git >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Git is not installed. Download it from https://git-scm.com/download/win
  pause
  exit /b 1
)

rem ---- first run: create the repository on branch main
if not exist ".git" (
  echo Creating git repository...
  git init
  if errorlevel 1 goto fail
  git symbolic-ref HEAD refs/heads/main
)

rem ---- push whichever branch you are on - develop for testing, main for the live site
set "BRANCH="
for /f "delims=" %%b in ('git symbolic-ref --short HEAD 2^>nul') do set "BRANCH=%%b"
if "%BRANCH%"=="" (
  echo [ERROR] Not on a branch. Run switch_branch.bat first.
  pause
  exit /b 1
)

echo.
echo  ==== Push to GitHub ====
echo  Repo  : %REPO_URL%
echo  Branch: %BRANCH%
if /i "%BRANCH%"=="main" echo  NOTE  : main is the LIVE branch. For work in progress use switch_branch.bat - develop.
echo.

rem ---- point "origin" at GitHub
git remote get-url origin >nul 2>&1
if errorlevel 1 (
  git remote add origin %REPO_URL%
) else (
  git remote set-url origin %REPO_URL%
)

rem ---- make sure git knows who you are
git config user.name >nul 2>&1
if errorlevel 1 goto ask_name
:name_ok
git config user.email >nul 2>&1
if errorlevel 1 goto ask_email
:email_ok

rem ---- commit message: from the command line, or ask
set "MSG=%~1"
if "%MSG%"=="" set /p "MSG=Commit message (press Enter for an automatic one): "
if "%MSG%"=="" set "MSG=Update %date% %time:~0,5%"

rem ---- stage everything (.gitignore keeps .env, .env.local, .env.native, deploy.config and data out)
git add -A
if errorlevel 1 goto fail
rem keep the Linux scripts executable for the server (Windows doesn't track this)
git update-index --chmod=+x install.sh run.sh update.sh studio.sh >nul 2>&1

rem ---- safety net: never push secrets
git diff --cached --name-only | findstr /r /i /c:"^\.env$" /c:"^\.env\.local$" /c:"^\.env\.native$" /c:"^deploy\.config$" /c:"\.db$" >nul
if not errorlevel 1 (
  echo.
  echo [STOP] A secrets or settings file is staged: .env / .env.local / .env.native / deploy.config / a database.
  echo        Check .gitignore, then run this again. Nothing was pushed.
  git reset -q
  pause
  exit /b 1
)

git diff --cached --quiet
if errorlevel 1 (
  git commit -m "%MSG%"
  if errorlevel 1 goto fail
) else (
  echo Nothing new to commit - pushing existing commits.
)

rem ---- push (the first time a GitHub login window may open)
echo.
echo Pushing %BRANCH%...
git push -u origin %BRANCH%
if not errorlevel 1 goto done

echo.
echo GitHub has commits you don't have locally. Merging them in, then pushing again...
git pull origin %BRANCH% --allow-unrelated-histories --no-edit
if errorlevel 1 goto conflict
git push -u origin %BRANCH%
if errorlevel 1 goto fail

:done
echo.
echo  Done: %BRANCH% is on GitHub. Deploy it with deploy.bat
echo.
if "%~2"=="nopause" exit /b 0
pause
exit /b 0

:ask_name
set /p "GNAME=Your name for commits: "
git config user.name "%GNAME%"
goto name_ok

:ask_email
set /p "GEMAIL=Your GitHub email: "
git config user.email "%GEMAIL%"
goto email_ok

:conflict
echo.
echo [ERROR] The merge has conflicts. Open the conflicted files, fix them, then run:
echo         git add -A ^&^& git commit --no-edit ^&^& git push -u origin %BRANCH%
pause
exit /b 1

:fail
echo.
echo [ERROR] Something went wrong - read the message above.
pause
exit /b 1
