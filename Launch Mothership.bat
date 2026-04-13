@echo off
cd /d "%~dp0"
echo Starting Mothership server...
start "Mothership Server" cmd /k "node server.js"
timeout /t 3 /nobreak >nul
echo Server running at http://localhost:3000
echo Launching Claude Code...
claude
