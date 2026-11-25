@echo off
setlocal EnableExtensions
title Documentary Studio
cd /d "%~dp0"

rem Runs the app inside WSL (Ubuntu on Windows) - no Docker needed.
rem If you have several Linux distros, put the Ubuntu one here, e.g. set "DISTRO=Ubuntu-24.04"
set "DISTRO="
set "PORT=8000"

set "WSL=wsl"
if not "%DISTRO%"=="" set "WSL=wsl -d %DISTRO%"

echo.
echo  ==== Documentary Studio (WSL, no Docker) ====
echo.

where wsl >nul 2>&1
if errorlevel 1 goto no_wsl
%WSL% -e true >nul 2>&1
if errorlevel 1 goto no_wsl

%WSL% -e bash -c "grep -qiE 'ubuntu|debian' /etc/os-release" >nul 2>&1
if errorlevel 1 goto not_ubuntu

rem ---- this folder as a Linux path, e.g. /mnt/d/WebApps/documentaryVideoProject
set "WPATH="
for /f "usebackq delims=" %%p in (`%WSL% -e wslpath -a "%CD%"`) do set "WPATH=%%p"
if "%WPATH%"=="" (
  echo [ERROR] Could not translate this folder to a WSL path.
  pause
  exit /b 1
)

rem ---- scripts must have Linux line endings (in case Git converted them)
%WSL% -e sed -i "s/\r$//" "%WPATH%/install.sh" "%WPATH%/run.sh" "%WPATH%/update.sh"

rem ---- first run: install everything inside Ubuntu (asks for your Linux password once)
%WSL% -e test -f "%WPATH%/.env.native"
if errorlevel 1 (
  echo First run: installing the app inside Ubuntu. This takes 5-15 minutes.
  echo When asked for a password: first your Linux - Ubuntu - password, then a new password for the web app.
  echo.
  %WSL% -e bash "%WPATH%/install.sh"
  if errorlevel 1 (
    echo.
    echo [ERROR] Installation failed - read the messages above.
    pause
    exit /b 1
  )
)

rem ---- open the browser once the app is up, then run the app in this window
start "" /min cmd /c "timeout /t 6 /nobreak >nul & start http://localhost:%PORT%"
echo.
echo  Running at http://localhost:%PORT%   -  close this window or press Ctrl+C to stop.
echo.
%WSL% -e bash "%WPATH%/run.sh"
echo.
echo The app stopped.
pause
exit /b 0

:no_wsl
echo WSL - Ubuntu on Windows - is not installed yet. It's free and built into Windows 10/11.
echo.
choice /m "Install WSL with Ubuntu now (asks for admin rights, then needs a restart)"
if errorlevel 2 exit /b 1
powershell -NoProfile -Command "Start-Process wsl -ArgumentList '--install -d Ubuntu-24.04' -Verb RunAs -Wait"
echo.
echo  Next steps:
echo   1. Restart your PC.
echo   2. Open "Ubuntu" from the Start menu once and create a Linux username and password.
echo   3. Double-click run_app.bat again.
pause
exit /b 1

:not_ubuntu
echo Your default WSL distro is not Ubuntu - Docker Desktop's own distro is sometimes the default.
echo Fix it with these commands in a terminal, then run this again:
echo     wsl --install -d Ubuntu-24.04
echo     wsl --set-default Ubuntu-24.04
echo Or set DISTRO at the top of this file to your Ubuntu distro's name - list them with: wsl -l -v
pause
exit /b 1
