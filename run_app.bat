@echo off
setlocal EnableExtensions
title Documentary Studio
cd /d "%~dp0"

set "IMAGE=documentary-studio"
set "CONTAINER=documentary-studio"
set "VOLUME=documentary-studio-data"
set "PORT=8000"

echo.
echo  ==== Documentary Studio (local) ====
echo.

rem ---- Docker Desktop is needed: the app relies on Linux tools (ffmpeg, espeak-ng, skia, bash)
where docker >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Docker Desktop is not installed.
  echo         Install it from https://www.docker.com/products/docker-desktop/ then run this again.
  start "" https://www.docker.com/products/docker-desktop/
  pause
  exit /b 1
)

docker info >nul 2>&1
if not errorlevel 1 goto docker_ok
echo Starting Docker Desktop...
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
for /l %%i in (1,1,90) do (
  docker info >nul 2>&1 && goto docker_ok
  timeout /t 2 /nobreak >nul
)
echo [ERROR] Docker did not start. Open Docker Desktop yourself, wait until it says "running", then try again.
pause
exit /b 1
:docker_ok

rem ---- first run: create local settings (.env.local is never pushed to GitHub)
if exist ".env.local" goto env_ok
echo First run: let's create your local settings.
:ask_pw
set "PW="
set /p "PW=Choose a login password for the app (letters and numbers only): "
if "%PW%"=="" goto ask_pw
for /f "delims=" %%k in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N')"') do set "SK=%%k"
> ".env.local" (
  echo # Local settings for run_app.bat - keep private
  echo APP_PASSWORD=%PW%
  echo SECRET_KEY=%SK%
)
echo Saved to .env.local - edit that file to change the password.
echo.
:env_ok

rem ---- build: the first build downloads ffmpeg + cinematic-skill and takes 5-15 minutes, later builds are quick
echo Building the app image...
docker build -t %IMAGE% .
if errorlevel 1 (
  echo [ERROR] Build failed - read the message above.
  pause
  exit /b 1
)

rem ---- restart the container (your films and settings live in the "%VOLUME%" volume and are kept)
docker rm -f %CONTAINER% >nul 2>&1
docker run -d --name %CONTAINER% --restart unless-stopped -p %PORT%:8000 --env-file .env.local -v %VOLUME%:/data %IMAGE% >nul
if errorlevel 1 (
  echo [ERROR] Could not start the app. Is port %PORT% already used? Change PORT at the top of this file.
  pause
  exit /b 1
)

echo Waiting for the app to start...
for /l %%i in (1,1,30) do (
  curl -s -o nul http://localhost:%PORT%/api/health && goto up
  timeout /t 1 /nobreak >nul
)
echo [WARN] The app is slow to respond; showing its log below.
:up
echo.
echo  Running at  http://localhost:%PORT%
echo  The app keeps running in the background. Use stop_app.bat to stop it.
echo  Closing this window or pressing Ctrl+C only stops the log view.
echo.
start "" http://localhost:%PORT%
docker logs -f --tail 30 %CONTAINER%
