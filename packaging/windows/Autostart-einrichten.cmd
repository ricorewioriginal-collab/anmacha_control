@echo off
rem Richtet AirDeck als Autostart bei der Anmeldung ein (24/7-Automation nach Neustart).
rem Entfernen: schtasks /Delete /TN "AirDeck" /F
schtasks /Create /TN "AirDeck" /SC ONLOGON /RL LIMITED /F /TR "\"%~dp0AirDeck.exe\" --minimized"
if %errorlevel%==0 (echo Autostart eingerichtet.) else (echo Autostart konnte nicht eingerichtet werden.)
pause
