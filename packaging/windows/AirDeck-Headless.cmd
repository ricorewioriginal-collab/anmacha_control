@echo off
rem AirDeck ohne Fenster starten (24/7-Betrieb, z. B. per Autostart).
cd /d "%~dp0"
start "" /min "%~dp0AirDeck.exe" --headless
