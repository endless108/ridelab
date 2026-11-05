@echo off
title RideLab
cd /d "%~dp0"
echo RideLab wird gestartet ...
start "" "http://localhost:8188/"
python ridelab_server.py
echo.
echo Server beendet oder Port 8188 bereits belegt (laeuft RideLab schon?).
pause
