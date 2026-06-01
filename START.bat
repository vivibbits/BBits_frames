@echo off
title BBits frames
echo.
echo  ◆ Starting BBits frames...
echo.
cd /d "%~dp0"
if not exist node_modules (
    echo  Installing dependencies...
    call npm install
    echo.
)
node bbits-studio.js
pause
