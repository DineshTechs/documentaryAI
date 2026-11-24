@echo off
title Stop Documentary Studio
echo Stopping Documentary Studio...
docker stop documentary-studio >nul 2>&1 && (echo Stopped. Your films and settings are kept.) || (echo It was not running.)
timeout /t 3 >nul
