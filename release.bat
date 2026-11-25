@echo off
setlocal EnableExtensions
title Release develop to main
cd /d "%~dp0"
rem Merges develop (tested on staging) into main (live) and pushes main to GitHub.

echo.
echo  ==== Release: develop -^> main ====
echo  Do this after you have tested develop on your staging site.
echo.
git diff --quiet
if errorlevel 1 goto dirty
git diff --cached --quiet
if errorlevel 1 goto dirty

git fetch origin
if errorlevel 1 goto fail
git show-ref --verify --quiet refs/remotes/origin/develop
if errorlevel 1 (
  echo [ERROR] There is no develop branch on GitHub yet. Push develop first.
  pause
  exit /b 1
)

echo Changes that will go live:
git log --oneline origin/main..origin/develop 2>nul
echo.
choice /m "Release these to main"
if errorlevel 2 exit /b 1

git checkout main
if errorlevel 1 goto fail
git pull --ff-only origin main
if errorlevel 1 goto fail
git merge --no-ff origin/develop -m "Release %date% %time:~0,5%"
if errorlevel 1 goto conflict
git push origin main
if errorlevel 1 goto fail

rem keep develop up to date with main and go back to it
git checkout develop
git merge --ff-only main >nul 2>&1
git push origin develop >nul 2>&1

echo.
echo  Released. main is updated on GitHub.
choice /m "Deploy main to the server now"
if errorlevel 2 goto end
call "%~dp0deploy.bat" main
:end
pause
exit /b 0

:dirty
echo [STOP] You have uncommitted changes. Push them with git_push.bat first, then release.
pause
exit /b 1
:conflict
echo.
echo [ERROR] develop and main conflict. Fix the files git lists, then: git add -A ^&^& git commit
echo         Afterwards run: git push origin main ^&^& git checkout develop
pause
exit /b 1
:fail
echo [ERROR] Something went wrong - read the message above.
pause
exit /b 1
