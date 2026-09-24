@echo off
rem AirDeck im lokalen Netzwerk freigeben (z. B. für die Android-App).
rem Windows fragt beim ersten Start nach der Firewall-Freigabe: "Private Netzwerke" erlauben.
cd /d "%~dp0"
set AIRDECK_HOST=0.0.0.0
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo Adresse fuer die App: http:%%a:8750
start "" "%~dp0AirDeck.exe"
