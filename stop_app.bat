@echo off
title Stop Documentary Studio
echo Stopping Documentary Studio...
wsl -e pkill -f "gunicorn.*app.main" >nul 2>&1 && echo Stopped the WSL app.
docker stop documentary-studio >nul 2>&1 && echo Stopped the Docker app.
echo Done. Your films and settings are kept.
timeout /t 3 >nul
