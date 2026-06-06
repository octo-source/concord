@echo off
cd /d %~dp0
if not exist node_modules call npm install
start http://localhost:7341
node server/index.js
echo.
echo Concord stopped. If the line above shows an error, read it before closing.
pause
