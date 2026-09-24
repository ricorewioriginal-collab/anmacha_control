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
SetupIconFile=..\..\assets\icons\airdeck-windows.ico
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
Name: "{group}\AirDeck Server (ohne Fenster, 24/7)"; Filename: "{app}\AirDeck.exe"; Parameters: "--headless"; WorkingDir: "{app}"; IconFilename: "{app}\icons\airdeck-server.ico"
Name: "{group}\AirDeck deinstallieren"; Filename: "{uninstallexe}"
Name: "{autodesktop}\AirDeck"; Filename: "{app}\AirDeck.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "AirDeck"; ValueData: """{app}\AirDeck.exe"" --headless"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\AirDeck.exe"; Description: "AirDeck jetzt starten"; Flags: nowait postinstall skipifsilent

; Nach einem automatischen Update (Aufruf mit /UPDATE=1) AirDeck wieder starten
Filename: "{app}\AirDeck.exe"; Parameters: "{code:RelaunchParams}"; Flags: nowait; Check: IsUpdate

[UninstallRun]
Filename: "{cmd}"; Parameters: "/c taskkill /IM AirDeck.exe /F"; Flags: runhidden; RunOnceId: "StopAirDeck"

[Messages]
de.WelcomeLabel2=AirDeck wird auf diesem Computer installiert.%n%nAirDeck läuft komplett lokal – kein eigener Server nötig. Deine Daten (Musik, Einstellungen, verschlüsselte Passwörter) liegen unter %LOCALAPPDATA%\AirDeck und bleiben bei einer Deinstallation erhalten.

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
  if (CurStep <> ssPostInstall) or (StoragePage.SelectedValueIndex = 0) then Exit;
  DataDir := ExpandConstant('{localappdata}\AirDeck\data');
  ForceDirectories(DataDir);
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
