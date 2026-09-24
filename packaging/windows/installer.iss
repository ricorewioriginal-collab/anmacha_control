; AirDeck – Windows-Installer (Inno Setup 6)
; Baut aus dist\AirDeck\ eine Setup.exe. Installation pro Benutzer, keine Administratorrechte nötig.
; Aufruf: iscc /DAppVersion=0.3.0 packaging\windows\installer.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6F1B2C84-5A3E-4E7C-9C1D-7A0D2B8E4F11}
AppName=AirDeck
AppVersion={#AppVersion}
AppVerName=AirDeck {#AppVersion}
AppPublisher=AirDeck
DefaultDirName={localappdata}\Programs\AirDeck
DefaultGroupName=AirDeck
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\..\dist
OutputBaseFilename=AirDeck-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\AirDeck.exe
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "de"; MessagesFile: "compiler:Languages\German.isl"

[Tasks]
Name: "desktopicon"; Description: "Desktop-Verknüpfung anlegen"; GroupDescription: "Zusätzlich:"
Name: "autostart"; Description: "AirDeck bei der Anmeldung im Hintergrund starten (24/7-Automation)"; GroupDescription: "Zusätzlich:"; Flags: unchecked

[Files]
Source: "..\..\dist\AirDeck\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\AirDeck"; Filename: "{app}\AirDeck.exe"; WorkingDir: "{app}"
Name: "{group}\AirDeck (ohne Fenster, 24/7)"; Filename: "{app}\AirDeck.exe"; Parameters: "--headless"; WorkingDir: "{app}"
Name: "{group}\AirDeck deinstallieren"; Filename: "{uninstallexe}"
Name: "{autodesktop}\AirDeck"; Filename: "{app}\AirDeck.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "AirDeck"; ValueData: """{app}\AirDeck.exe"" --headless"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\AirDeck.exe"; Description: "AirDeck jetzt starten"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{cmd}"; Parameters: "/c taskkill /IM AirDeck.exe /F"; Flags: runhidden; RunOnceId: "StopAirDeck"

[Messages]
de.WelcomeLabel2=AirDeck wird auf diesem Computer installiert.%n%nAirDeck läuft komplett lokal – kein eigener Server nötig. Deine Daten (Musik, Einstellungen, verschlüsselte Passwörter) liegen unter %LOCALAPPDATA%\AirDeck und bleiben bei einer Deinstallation erhalten.
