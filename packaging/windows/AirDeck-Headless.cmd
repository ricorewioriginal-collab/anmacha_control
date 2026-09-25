@echo off
rem Nur die AirDeck-Engine starten, ohne Fenster (24/7-Betrieb, z. B. auf einem Sende-PC).
cd /d "%~dp0"
start "" /min "%~dp0airdeck-engine.exe" --headless
