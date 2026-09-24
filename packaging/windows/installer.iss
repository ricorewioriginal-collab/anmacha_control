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
AppPublisher=AirDeck (Hobbyprojekt von RicoReWi, powered by AnMaCha)
AppPublisherURL=https://github.com/ricorewioriginal-collab/anmacha_control
AppComments=Radio-Automation & Live-Broadcast
VersionInfoDescription=AirDeck Setup
VersionInfoProductName=AirDeck
DefaultDirName={autopf}\AirDeck
DefaultGroupName=AirDeck
DisableProgramGroupPage=yes
; Standard: nur für mich (ohne Adminrechte) – im Dialog wählbar: für alle Benutzer (mit Firewall-Freigabe)
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UsedUserAreasWarning=no
OutputDir=..\..\dist
OutputBaseFilename=AirDeck-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
WizardSizePercent=110,110
WizardImageFile=installer\wizard-164.bmp,installer\wizard-328.bmp
WizardSmallImageFile=installer\small-55.bmp,installer\small-110.bmp
LicenseFile=installer\haftung.txt
ShowLanguageDialog=auto
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\AirDeck.exe
UninstallDisplayName=AirDeck
SetupIconFile=..\..\assets\icons\airdeck-windows.ico
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "de"; MessagesFile: "compiler:Languages\German.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
de.TasksExtra=Zusätzlich:
en.TasksExtra=Additional:
de.TaskDesktop=Desktop-Verknüpfung anlegen
en.TaskDesktop=Create a desktop shortcut
de.TaskAutostart=Bei der Anmeldung im Hintergrund starten (24/7-Automation, Symbol im Infobereich)
en.TaskAutostart=Start in the background at sign-in (24/7 automation, tray icon)
de.TaskLan=Im Netzwerk erreichbar (Android-App, weitere PCs im WLAN)
en.TaskLan=Reachable on the network (Android app, other PCs)
de.CompCore=AirDeck Studio & Server (Pflicht)
en.CompCore=AirDeck studio & server (required)
de.CompFfmpeg=Audio-Engine ffmpeg mit LAME/AAC/Opus (für 24/7-Automation, Encoder, Recorder)
en.CompFfmpeg=Audio engine ffmpeg with LAME/AAC/Opus (24/7 automation, encoders, recorder)
de.CompAndroid=Android-App (APK) zum Verteilen an Handys im WLAN
en.CompAndroid=Android app (APK) for phones on your network
de.TypeFull=Vollständig (empfohlen)
en.TypeFull=Full (recommended)
de.TypeCompact=Nur Studio (ohne Audio-Engine, z. B. als Fernbedienung)
en.TypeCompact=Studio only (no audio engine, e.g. as remote control)
de.TypeCustom=Benutzerdefiniert
en.TypeCustom=Custom
de.IconStop=AirDeck beenden
en.IconStop=Quit AirDeck
de.IconServer=AirDeck im Hintergrund (24/7, ohne Fenster)
en.IconServer=AirDeck in the background (24/7, no window)
de.IconManual=AirDeck Handbuch
en.IconManual=AirDeck manual
de.RunManual=Handbuch öffnen
en.RunManual=Open the manual
de.RunNow=AirDeck jetzt starten
en.RunNow=Launch AirDeck now

[Types]
Name: "full"; Description: "{cm:TypeFull}"
Name: "compact"; Description: "{cm:TypeCompact}"
Name: "custom"; Description: "{cm:TypeCustom}"; Flags: iscustom

[Components]
Name: "core"; Description: "{cm:CompCore}"; Types: full compact custom; Flags: fixed
Name: "ffmpeg"; Description: "{cm:CompFfmpeg}"; Types: full custom
Name: "android"; Description: "{cm:CompAndroid}"; Types: full custom

[Tasks]
Name: "desktopicon"; Description: "{cm:TaskDesktop}"; GroupDescription: "{cm:TasksExtra}"
Name: "autostart"; Description: "{cm:TaskAutostart}"; GroupDescription: "{cm:TasksExtra}"; Flags: unchecked
Name: "lan"; Description: "{cm:TaskLan}"; GroupDescription: "{cm:TasksExtra}"; Flags: unchecked

[Files]
Source: "..\..\dist\AirDeck\*"; DestDir: "{app}"; Excludes: "\ffmpeg\*,\android\*"; Flags: ignoreversion recursesubdirs createallsubdirs; Components: core
Source: "..\..\dist\AirDeck\ffmpeg\*"; DestDir: "{app}\ffmpeg"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist; Components: ffmpeg
Source: "..\..\dist\AirDeck\android\*"; DestDir: "{app}\android"; Flags: ignoreversion skipifsourcedoesntexist; Components: android
Source: "installer\haftung.txt"; DestDir: "{app}"; DestName: "HAFTUNGSAUSSCHLUSS.txt"; Flags: ignoreversion; Components: core

[Icons]
Name: "{group}\AirDeck"; Filename: "{app}\AirDeck.exe"; WorkingDir: "{app}"
Name: "{group}\{cm:IconServer}"; Filename: "{app}\AirDeck.exe"; Parameters: "--headless"; WorkingDir: "{app}"; IconFilename: "{app}\icons\airdeck-server.ico"
Name: "{group}\{cm:IconStop}"; Filename: "{app}\AirDeck.exe"; Parameters: "--stop"; WorkingDir: "{app}"; IconFilename: "{app}\icons\airdeck-server.ico"
Name: "{group}\{cm:IconManual}"; Filename: "{app}\studio\handbuch.html"
Name: "{group}\{cm:UninstallProgram,AirDeck}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\AirDeck"; Filename: "{app}\AirDeck.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "AirDeck"; ValueData: """{app}\AirDeck.exe"" --headless"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
; Firewall-Freigabe für das lokale Netz (nur bei Installation für alle Benutzer mit Adminrechten)
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""AirDeck"" dir=in action=allow program=""{app}\AirDeck.exe"" profile=private,domain enable=yes"; Flags: runhidden; Tasks: lan; Check: IsAdminInstallMode
Filename: "{app}\AirDeck.exe"; Description: "{cm:RunNow}"; Flags: nowait postinstall skipifsilent
Filename: "{app}\studio\handbuch.html"; Description: "{cm:RunManual}"; Flags: shellexec postinstall skipifsilent unchecked nowait

; Nach einem automatischen Update (Aufruf mit /UPDATE=1) AirDeck wieder starten
Filename: "{app}\AirDeck.exe"; Parameters: "{code:RelaunchParams}"; Flags: nowait; Check: IsUpdate

[UninstallRun]
Filename: "{app}\AirDeck.exe"; Parameters: "--stop"; Flags: runhidden waituntilterminated; RunOnceId: "QuitAirDeck"
Filename: "{cmd}"; Parameters: "/c taskkill /IM AirDeck.exe /F"; Flags: runhidden; RunOnceId: "StopAirDeck"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""AirDeck"""; Flags: runhidden; RunOnceId: "FirewallAirDeck"; Check: IsAdminInstallMode

[Messages]
de.WelcomeLabel2=AirDeck wird auf diesem Computer installiert.%n%nAirDeck läuft komplett lokal im Hintergrund (Symbol im Infobereich) – kein eigener Server nötig. Deine Daten (Musik, Einstellungen, verschlüsselte Passwörter) liegen unter %LOCALAPPDATA%\AirDeck und bleiben bei einer Deinstallation erhalten.%n%nAirDeck ist ein Hobbyprojekt – bitte den Haftungsausschluss auf der nächsten Seite lesen.
en.WelcomeLabel2=This will install AirDeck on your computer.%n%nAirDeck runs fully locally in the background (tray icon) – no server required. Your data stays in %LOCALAPPDATA%\AirDeck and is kept when uninstalling.%n%nAirDeck is a hobby project – please read the disclaimer on the next page.

[Code]
{ Seite "Datenspeicher": Lokal (Standard) / MySQL-MariaDB / Firebase.
  Die Angaben werden als einmalige Einrichtungsdatei abgelegt; AirDeck importiert sie beim ersten Start
  verschlüsselt in den eigenen Secret-Store und löscht die Datei sofort. }

var
  StoragePage: TInputOptionWizardPage;
  MysqlPage: TInputQueryWizardPage;
  FirebasePage: TInputFileWizardPage;
  FirstSyncPage: TInputOptionWizardPage;

function IsUpdate: Boolean;
begin
  Result := ExpandConstant('{param:UPDATE|0}') = '1';
end;

function RelaunchParams(Param: String): String;
begin
  if ExpandConstant('{param:HEADLESSRUN|0}') = '1' then Result := '--headless' else Result := '';
end;

procedure InitializeWizard;
begin
  StoragePage := CreateInputOptionPage(wpSelectTasks,
    'Datenspeicher', 'Wo sollen die Senderdaten gespeichert werden?',
    'AirDeck läuft immer lokal und offline. Optional kann der Senderzustand (Sender, Quellen, Ausgänge, Bibliothek, Playlists, Planung) mit einer Datenbank synchronisiert werden – z. B. für mehrere Studios. Musikdateien bleiben lokal.',
    True, False);
  StoragePage.Add('Nur lokal (empfohlen, keine Einrichtung nötig)');
  StoragePage.Add('MySQL / MariaDB (eigener Server, mehrere Standorte)');
  StoragePage.Add('Firebase (Google Cloud Firestore)');
  StoragePage.SelectedValueIndex := 0;

  MysqlPage := CreateInputQueryPage(StoragePage.ID,
    'MySQL / MariaDB', 'Zugangsdaten zur Datenbank',
    'Die Datenbank muss bereits existieren; AirDeck legt seine Tabelle selbst an. Das Passwort wird beim ersten Start verschlüsselt gespeichert.');
  MysqlPage.Add('Server (Host):', False);
  MysqlPage.Add('Port:', False);
  MysqlPage.Add('Benutzer:', False);
  MysqlPage.Add('Passwort:', True);
  MysqlPage.Add('Datenbank:', False);
  MysqlPage.Values[0] := 'localhost';
  MysqlPage.Values[1] := '3306';
  MysqlPage.Values[4] := 'airdeck';

  FirebasePage := CreateInputFilePage(MysqlPage.ID,
    'Firebase', 'Service-Account-Schlüssel auswählen',
    'Firebase-Konsole → Projekteinstellungen → Dienstkonten → „Neuen privaten Schlüssel generieren“. Die Projekt-ID wird aus der Datei gelesen.');
  FirebasePage.Add('Service-Account-JSON:', 'JSON-Dateien|*.json|Alle Dateien|*.*', '.json');

  FirstSyncPage := CreateInputOptionPage(FirebasePage.ID,
    'Erster Abgleich', 'Welcher Stand gilt beim ersten Verbinden?', '', True, False);
  FirstSyncPage.Add('Stand aus der Datenbank übernehmen (weiterer Standort / Neuinstallation)');
  FirstSyncPage.Add('Diesen PC als Quelle verwenden (erster Standort)');
  FirstSyncPage.SelectedValueIndex := 0;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if PageID = MysqlPage.ID then Result := StoragePage.SelectedValueIndex <> 1;
  if PageID = FirebasePage.ID then Result := StoragePage.SelectedValueIndex <> 2;
  if PageID = FirstSyncPage.ID then Result := StoragePage.SelectedValueIndex = 0;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = MysqlPage.ID) and ((Trim(MysqlPage.Values[0]) = '') or (Trim(MysqlPage.Values[2]) = '') or (Trim(MysqlPage.Values[4]) = '')) then
  begin
    MsgBox('Bitte Server, Benutzer und Datenbank angeben.', mbError, MB_OK);
    Result := False;
  end;
  if (CurPageID = FirebasePage.ID) and not FileExists(FirebasePage.Values[0]) then
  begin
    MsgBox('Bitte die Service-Account-JSON-Datei auswählen.', mbError, MB_OK);
    Result := False;
  end;
end;

function JsonEscape(const S: String): String;
var
  I: Integer;
  C: Char;
begin
  Result := '';
  for I := 1 to Length(S) do
  begin
    C := S[I];
    if C = '\' then Result := Result + '\\'
    else if C = '"' then Result := Result + '\"'
    else if Ord(C) < 32 then Result := Result + ' '
    else Result := Result + C;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  DataDir, Json, FirstSync: String;
  Lines: TArrayOfString;
begin
  if CurStep <> ssPostInstall then Exit;
  DataDir := ExpandConstant('{localappdata}\AirDeck\data');
  ForceDirectories(DataDir);
  if WizardIsTaskSelected('lan') then
  begin
    SetArrayLength(Lines, 1);
    Lines[0] := '{"lan":true}';
    SaveStringsToUTF8File(DataDir + '\network.json', Lines, False);
  end;
  if StoragePage.SelectedValueIndex = 0 then Exit;
  if FirstSyncPage.SelectedValueIndex = 1 then FirstSync := 'push' else FirstSync := 'pull';
  if StoragePage.SelectedValueIndex = 1 then
    Json := '{"backend":"mysql","firstSync":"' + FirstSync + '","mysql":{"host":"' + JsonEscape(Trim(MysqlPage.Values[0])) +
      '","port":"' + JsonEscape(Trim(MysqlPage.Values[1])) + '","user":"' + JsonEscape(Trim(MysqlPage.Values[2])) +
      '","password":"' + JsonEscape(MysqlPage.Values[3]) + '","database":"' + JsonEscape(Trim(MysqlPage.Values[4])) + '"}}'
  else
    Json := '{"backend":"firebase","firstSync":"' + FirstSync + '","firebase":{"credentialsFile":"' + JsonEscape(FirebasePage.Values[0]) + '"}}';
  SetArrayLength(Lines, 1);
  Lines[0] := Json;
  SaveStringsToUTF8File(DataDir + '\storage-setup.json', Lines, False);
end;
