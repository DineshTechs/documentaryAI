@echo off
title Documentary Studio - internet link
cd /d "%~dp0"
rem Puts the app running on this PC on the internet (free Cloudflare Tunnel). Close this window to go offline.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\tunnel.ps1"
pause
