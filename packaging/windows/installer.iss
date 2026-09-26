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
AppPublisher=AnMaCha Radioproduktion & RicoReWi
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
Name: "{group}\{cm:IconServer}"; Filename: "{app}\airdeck-engine.exe"; Parameters: "--headless"; WorkingDir: "{app}"; IconFilename: "{app}\icons\airdeck-server.ico"
Name: "{group}\{cm:IconStop}"; Filename: "{app}\airdeck-engine.exe"; Parameters: "--stop"; WorkingDir: "{app}"; IconFilename: "{app}\icons\airdeck-server.ico"
Name: "{group}\{cm:IconManual}"; Filename: "{app}\studio\handbuch.html"
Name: "{group}\{cm:UninstallProgram,AirDeck}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\AirDeck"; Filename: "{app}\AirDeck.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "AirDeck"; ValueData: """{app}\AirDeck.exe"" --minimized"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
; Firewall-Freigabe für das lokale Netz (nur bei Installation für alle Benutzer mit Adminrechten)
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""AirDeck"" dir=in action=allow program=""{app}\airdeck-engine.exe"" profile=private,domain enable=yes"; Flags: runhidden; Tasks: lan; Check: IsAdminInstallMode
Filename: "{app}\AirDeck.exe"; Description: "{cm:RunNow}"; Flags: nowait postinstall skipifsilent
Filename: "{app}\studio\handbuch.html"; Description: "{cm:RunManual}"; Flags: shellexec postinstall skipifsilent unchecked nowait

; Nach einem automatischen Update (Aufruf mit /UPDATE=1) AirDeck wieder starten
Filename: "{app}\{code:RelaunchExe}"; Parameters: "{code:RelaunchParams}"; Flags: nowait; Check: IsUpdate

[UninstallRun]
Filename: "{app}\airdeck-engine.exe"; Parameters: "--stop"; Flags: runhidden waituntilterminated; RunOnceId: "QuitAirDeck"
Filename: "{cmd}"; Parameters: "/c taskkill /IM AirDeck.exe /F & taskkill /IM airdeck-engine.exe /F"; Flags: runhidden; RunOnceId: "StopAirDeck"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""AirDeck"""; Flags: runhidden; RunOnceId: "FirewallAirDeck"; Check: IsAdminInstallMode

[Messages]
de.WelcomeLabel2=AirDeck wird auf diesem Computer installiert.%n%nAirDeck läuft komplett lokal im Hintergrund (Symbol im Infobereich) – kein eigener Server nötig. Deine Daten (Musik, Einstellungen, verschlüsselte Passwörter) liegen unter %LOCALAPPDATA%\AirDeck und bleiben bei einer Deinstallation erhalten.%n%nAirDeck ist ein Hobbyprojekt – bitte den Haftungsausschluss auf der nächsten Seite lesen.
en.WelcomeLabel2=This will install AirDeck on your computer.%n%nAirDeck runs fully locally in the background (tray icon) – no server required. Your data stays in %LOCALAPPDATA%\AirDeck and is kept when uninstalling.%n%nAirDeck is a hobby project – please read the disclaimer on the next page.

[Code]
{ Moderner Einrichtungsdialog: Betriebsart/Port/LAN, eigener Admin, Komponentenuebersicht,
  Datenspeicher und abschliessende Y/N-Bestaetigung. Kennwoerter werden nur als einmalige
  Bootstrap-Datei abgelegt, beim ersten Start gehasht und sofort geloescht. }

var
  BrandPage: TOutputMsgMemoWizardPage;
  ServerModePage: TInputOptionWizardPage;
  NetworkPage: TInputQueryWizardPage;
  LanPage: TInputOptionWizardPage;
  AdminChoicePage: TInputOptionWizardPage;
  AdminPage: TInputQueryWizardPage;
  ThirdPartyPage: TOutputMsgMemoWizardPage;
  ConfirmPage: TInputOptionWizardPage;
  StoragePage: TInputOptionWizardPage;
  MysqlPage: TInputQueryWizardPage;
  FirebasePage: TInputFileWizardPage;
  FirstSyncPage: TInputOptionWizardPage;

function IsUpdate: Boolean;
begin
  Result := ExpandConstant('{param:UPDATE|0}') = '1';
end;

{ Nach dem Update: lief nur die Engine (24/7 ohne Fenster), wieder nur die Engine starten, sonst das Programm }
function RelaunchExe(Param: String): String;
begin
  if ExpandConstant('{param:HEADLESSRUN|0}') = '1' then Result := 'airdeck-engine.exe' else Result := 'AirDeck.exe';
end;

function RelaunchParams(Param: String): String;
begin
  if ExpandConstant('{param:HEADLESSRUN|0}') = '1' then Result := '--headless' else Result := '';
end;

procedure InitializeWizard;
begin
  BrandPage := CreateOutputMsgMemoPage(wpSelectTasks,
    '◉ AIRDECK', 'Radio Automation & Broadcast',
    'Willkommen beim AirDeck Setup',
    '╔══════════════════════════════════════════════╗' + #13#10 +
    '║   ◉  A I R D E C K                          ║' + #13#10 +
    '║   Radio Automation & Live Broadcast         ║' + #13#10 +
    '╚══════════════════════════════════════════════╝' + #13#10#13#10 +
    'Dieser Assistent richtet AirDeck so ein, dass nach der Installation möglichst keine Konsole nötig ist.' + #13#10 +
    'Du wählst Betriebsart, Port, Netzwerkzugriff, optional einen eigenen Administrator und den Datenspeicher.');

  ServerModePage := CreateInputOptionPage(BrandPage.ID,
    'Betriebsart', 'Wie soll AirDeck auf diesem Computer laufen?',
    'Die Einstellung kann später im AirDeck-Setup-Assistenten geändert werden.', True, False);
  ServerModePage.Add('LOCAL – Studio und Automation auf diesem PC');
  ServerModePage.Add('SERVER – 24/7-Server, Bedienung per Browser/App');
  ServerModePage.Add('HYBRID – lokales Studio mit Server-/Netzwerkfunktionen');
  ServerModePage.SelectedValueIndex := 0;

  NetworkPage := CreateInputQueryPage(ServerModePage.ID,
    'Server & Port', 'Netzwerkeinstellungen',
    'Standard ist Port 8750. Bitte nur ändern, wenn der Port bereits belegt ist oder du bewusst einen anderen Port verwenden willst.');
  NetworkPage.Add('AirDeck-Port:', False);
  NetworkPage.Values[0] := '8750';

  LanPage := CreateInputOptionPage(NetworkPage.ID,
    'Netzwerkzugriff', 'Soll AirDeck im lokalen Netzwerk erreichbar sein?',
    'Y erlaubt Android-App und andere PCs im LAN. N bindet AirDeck nur an diesen Computer.', True, False);
  LanPage.Add('Y (Yes) – im LAN erreichbar');
  LanPage.Add('N (No) – nur auf diesem Computer');
  LanPage.SelectedValueIndex := 1;

  AdminChoicePage := CreateInputOptionPage(LanPage.ID,
    'Administrator', 'Eigenen AirDeck-Admin jetzt anlegen?',
    'Empfohlen für Server-/LAN-Betrieb. Das Kennwort wird beim ersten Start gehasht und die Bootstrap-Datei danach gelöscht.', True, False);
  AdminChoicePage.Add('Y (Yes) – eigenen Admin-Zugang einrichten');
  AdminChoicePage.Add('N (No) – später im AirDeck-Setup einrichten');
  AdminChoicePage.SelectedValueIndex := 0;

  AdminPage := CreateInputQueryPage(AdminChoicePage.ID,
    'Administrator', 'Eigener AirDeck-Zugang',
    'Benutzername 2–40 Zeichen. Passwort mindestens 10 Zeichen mit Buchstaben und mindestens einer Ziffer oder einem Sonderzeichen.');
  AdminPage.Add('Benutzername:', False);
  AdminPage.Add('Anzeigename:', False);
  AdminPage.Add('Passwort:', True);
  AdminPage.Add('Passwort wiederholen:', True);
  AdminPage.Values[0] := 'admin';
  AdminPage.Values[1] := 'Administrator';

  ThirdPartyPage := CreateOutputMsgMemoPage(AdminPage.ID,
    'Komponenten', 'Was AirDeck installiert bzw. verwendet',
    'Komponentenübersicht',
    'AirDeck Core / Studio                 – RicoReWi / AirDeck' + #13#10 +
    'AirDeck Encoder / Relay / Failover    – eigener AirDeck-Kern' + #13#10 +
    'FFmpeg + FFprobe + FFplay             – Audio-Engine (bei Komponente „Audio-Engine“)' + #13#10 +
    'LAME MP3 / AAC / Opus                 – Encoder über den mitgelieferten FFmpeg-Build' + #13#10 +
    'Node.js Laufzeit / SEA                – Laufzeit der AirDeck-Engine' + #13#10 +
    'SQLite                                – lokale Standarddatenbank' + #13#10 +
    'Android APK                           – optionales Installationspaket für Handys' + #13#10#13#10 +
    'Icecast/SHOUTcast/laut.fm             – externe Streaming-Ziele; Zugangsdaten werden nicht mitgeliefert.' + #13#10 +
    'AirDeckCast/HLS                       – AirDeck-eigene Streaming-/Profilfunktionen.' + #13#10#13#10 +
    'Exakte Versionen, Quellen und Lizenzen stehen in THIRD_PARTY_COMPONENTS.md und im Handbuch.');

  StoragePage := CreateInputOptionPage(ThirdPartyPage.ID,
    'Datenspeicher', 'Wo sollen die Senderdaten gespeichert werden?',
    'AirDeck läuft immer lokal. Optional kann der Senderzustand mit einer Datenbank synchronisiert werden. Musikdateien bleiben lokal.',
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

  ConfirmPage := CreateInputOptionPage(FirstSyncPage.ID,
    'Bestätigung', 'AirDeck mit diesen Einstellungen installieren?',
    'Y übernimmt die gewählten Einstellungen. N geht nicht weiter – du kannst mit „Zurück“ Änderungen vornehmen.', True, False);
  ConfirmPage.Add('Y (Yes) – Einstellungen übernehmen und installieren');
  ConfirmPage.Add('N (No) – noch nicht installieren');
  ConfirmPage.SelectedValueIndex := 0;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if IsUpdate then
  begin
    if (PageID = BrandPage.ID) or (PageID = ServerModePage.ID) or (PageID = NetworkPage.ID) or
       (PageID = LanPage.ID) or (PageID = AdminChoicePage.ID) or (PageID = AdminPage.ID) or
       (PageID = ThirdPartyPage.ID) or (PageID = StoragePage.ID) or (PageID = MysqlPage.ID) or
       (PageID = FirebasePage.ID) or (PageID = FirstSyncPage.ID) or (PageID = ConfirmPage.ID) then
    begin
      Result := True;
      Exit;
    end;
  end;
  if PageID = AdminPage.ID then Result := AdminChoicePage.SelectedValueIndex <> 0;
  if PageID = MysqlPage.ID then Result := StoragePage.SelectedValueIndex <> 1;
  if PageID = FirebasePage.ID then Result := StoragePage.SelectedValueIndex <> 2;
  if PageID = FirstSyncPage.ID then Result := StoragePage.SelectedValueIndex = 0;
end;

function ValidAdminUsername(const S: String): Boolean;
var
  I: Integer;
  C: Char;
begin
  Result := (Length(S) >= 2) and (Length(S) <= 40);
  if not Result then Exit;
  for I := 1 to Length(S) do
  begin
    C := S[I];
    if Pos(Lowercase(C), 'abcdefghijklmnopqrstuvwxyz0123456789._-') = 0 then
    begin
      Result := False;
      Exit;
    end;
  end;
end;

function PasswordHasLetter(const S: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to Length(S) do
    if Pos(Lowercase(S[I]), 'abcdefghijklmnopqrstuvwxyz') > 0 then begin Result := True; Exit; end;
end;

function PasswordHasExtra(const S: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to Length(S) do
    if Pos(S[I], '0123456789') > 0 then begin Result := True; Exit; end;
  if not Result then
    for I := 1 to Length(S) do
      if Pos(Lowercase(S[I]), 'abcdefghijklmnopqrstuvwxyz') = 0 then begin Result := True; Exit; end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  PortNum: Integer;
begin
  Result := True;

  if CurPageID = NetworkPage.ID then
  begin
    PortNum := StrToIntDef(Trim(NetworkPage.Values[0]), 0);
    if (PortNum < 1024) or (PortNum > 65535) then
    begin
      MsgBox('Bitte einen Port zwischen 1024 und 65535 angeben.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
  end;

  if (CurPageID = AdminPage.ID) and (AdminChoicePage.SelectedValueIndex = 0) then
  begin
    if not ValidAdminUsername(Trim(AdminPage.Values[0])) then
    begin
      MsgBox('Benutzername: 2–40 Zeichen, nur a–z, 0–9, Punkt, Minus und Unterstrich.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if (Length(AdminPage.Values[2]) < 10) or not PasswordHasLetter(AdminPage.Values[2]) or not PasswordHasExtra(AdminPage.Values[2]) then
    begin
      MsgBox('Passwort: mindestens 10 Zeichen, mit Buchstaben und mindestens einer Ziffer oder einem Sonderzeichen.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if AdminPage.Values[2] <> AdminPage.Values[3] then
    begin
      MsgBox('Die beiden Passwörter stimmen nicht überein.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
  end;

  if (CurPageID = MysqlPage.ID) and ((Trim(MysqlPage.Values[0]) = '') or (Trim(MysqlPage.Values[2]) = '') or (Trim(MysqlPage.Values[4]) = '')) then
  begin
    MsgBox('Bitte Server, Benutzer und Datenbank angeben.', mbError, MB_OK);
    Result := False;
    Exit;
  end;
  if (CurPageID = FirebasePage.ID) and not FileExists(FirebasePage.Values[0]) then
  begin
    MsgBox('Bitte die Service-Account-JSON-Datei auswählen.', mbError, MB_OK);
    Result := False;
    Exit;
  end;
  if (CurPageID = ConfirmPage.ID) and (ConfirmPage.SelectedValueIndex <> 0) then
  begin
    MsgBox('Installation noch nicht bestätigt. Wähle Y (Yes) oder gehe mit „Zurück“ zu den Einstellungen.', mbInformation, MB_OK);
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
  DataDir, ConfigDir, Json, FirstSync, ModeName, BindName, AdminJson: String;
  Lines: TArrayOfString;
begin
  if CurStep <> ssPostInstall then Exit;
  if IsUpdate then Exit;

  DataDir := ExpandConstant('{localappdata}\AirDeck\data');
  ConfigDir := DataDir + '\config';
  ForceDirectories(DataDir);
  ForceDirectories(ConfigDir);

  if ServerModePage.SelectedValueIndex = 1 then ModeName := 'server'
  else if ServerModePage.SelectedValueIndex = 2 then ModeName := 'hybrid'
  else ModeName := 'local';

  if LanPage.SelectedValueIndex = 0 then BindName := 'lan' else BindName := 'local';

  SetArrayLength(Lines, 6);
  Lines[0] := '# AirDeck – vom Windows-Installer angelegte Grundeinstellungen.';
  Lines[1] := 'mode = ' + ModeName;
  Lines[2] := '';
  Lines[3] := '[network]';
  Lines[4] := 'port = ' + Trim(NetworkPage.Values[0]);
  Lines[5] := 'bind = ' + BindName;
  SaveStringsToUTF8File(ConfigDir + '\airdeck.conf', Lines, False);

  SetArrayLength(Lines, 1);
  if LanPage.SelectedValueIndex = 0 then Lines[0] := '{"lan":true}' else Lines[0] := '{"lan":false}';
  SaveStringsToUTF8File(DataDir + '\network.json', Lines, False);

  if AdminChoicePage.SelectedValueIndex = 0 then
  begin
    AdminJson := '{"username":"' + JsonEscape(Lowercase(Trim(AdminPage.Values[0]))) +
      '","name":"' + JsonEscape(Trim(AdminPage.Values[1])) +
      '","password":"' + JsonEscape(AdminPage.Values[2]) + '"}';
    SetArrayLength(Lines, 1);
    Lines[0] := AdminJson;
    SaveStringsToUTF8File(DataDir + '\installer-bootstrap.json', Lines, False);
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

