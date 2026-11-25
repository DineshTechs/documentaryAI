@echo off
setlocal EnableExtensions
title Update Documentary Studio
cd /d "%~dp0"
set "DISTRO="
set "WSL=wsl"
if not "%DISTRO%"=="" set "WSL=wsl -d %DISTRO%"
set "WPATH="
for /f "usebackq delims=" %%p in (`%WSL% -e wslpath -a "%CD%"`) do set "WPATH=%%p"
%WSL% -e sed -i "s/\r$//" "%WPATH%/install.sh" "%WPATH%/run.sh" "%WPATH%/update.sh"
%WSL% -e bash "%WPATH%/update.sh"
pause
