@echo off
setlocal EnableExtensions
title Switch branch
cd /d "%~dp0"
rem develop = work in progress (deploy to staging), main = live channel (deploy to main)

if not exist ".git" (
  echo Run git_push.bat once first to create the repository.
  pause
  exit /b 1
)
set "CUR="
for /f "delims=" %%b in ('git symbolic-ref --short HEAD 2^>nul') do set "CUR=%%b"
echo.
echo  Current branch: %CUR%
echo.
echo   1. develop  - your work in progress, deploy it to staging
echo   2. main     - the live version, deploy it to main
echo   3. another branch, e.g. a new feature
echo.
choice /c 123 /m "Switch to"
if errorlevel 3 goto other
if errorlevel 2 (set "TARGET=main") else (set "TARGET=develop")
goto go

:other
set /p "TARGET=Branch name, e.g. feature-music: "
if "%TARGET%"=="" exit /b 1

:go
git diff --quiet
if errorlevel 1 goto dirty
git diff --cached --quiet
if errorlevel 1 goto dirty
:switch
git show-ref --verify --quiet "refs/heads/%TARGET%"
if not errorlevel 1 (
  git checkout "%TARGET%"
) else (
  git fetch origin "%TARGET%" >nul 2>&1
  git show-ref --verify --quiet "refs/remotes/origin/%TARGET%"
  if not errorlevel 1 (
    git checkout -b "%TARGET%" --track "origin/%TARGET%"
  ) else (
    echo Creating new branch %TARGET% from %CUR%...
    git checkout -b "%TARGET%"
  )
)
if errorlevel 1 (
  echo [ERROR] Could not switch - read the message above.
  pause
  exit /b 1
)
echo.
echo  Now on %TARGET%. Your files in this folder now show that branch.
echo  Push it with git_push.bat.
pause
exit /b 0

:dirty
echo.
echo You have changes that aren't committed yet. They will come with you to %TARGET%.
choice /m "Switch anyway"
if errorlevel 2 exit /b 1
goto switch
