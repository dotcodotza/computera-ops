; Inno Setup script for Computera Ops
; Compile with: ISCC installer.iss

#define MyAppName "Computera Ops"
#define MyAppVersion "1.1.0"
#define MyAppPublisher "Computera Ops"
#define MyAppURL "https://github.com/Skywalkingzulu1/ai-webapp-computera"
#define MyAppExeName "server.js"

[Setup]
AppId={{{{E3A1F2B4-5C6D-4E7F-8A9B-0C1D2E3F4A5B}}}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppURL={#MyAppURL}
DefaultDirName={pf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
LicenseFile=
PrivilegesRequired=admin
Compression=lzma
SolidCompression=yes
OutputDir=output
OutputBaseFilename=ComputeraOpsSetup
SetupIconFile=
UninstallIconFile=

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "quickstarticon"; Description: "Create Quick Start shortcut"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Source: project root files; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "server.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "tasks-db.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "fleet.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "kilo-runs.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "fleet.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "consult.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "consult-server.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "ecosystem.config.cjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "install-computera.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "kilo.jsonc"; DestDir: "{app}"; Flags: ignoreversion
Source: ".env.example"; DestDir: "{app}"; Flags: ignoreversion
Source: "README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "lemogram.html"; DestDir: "{app}"; Flags: ignoreversion

; Public UI files
Source: "public\dashboard.html"; DestDir: "{app}\public"; Flags: ignoreversion
Source: "public\chat.html"; DestDir: "{app}\public"; Flags: ignoreversion
Source: "public\studio.html"; DestDir: "{app}\public"; Flags: ignoreversion
Source: "public\consult.html"; DestDir: "{app}\public"; Flags: ignoreversion
Source: "public\login.html"; DestDir: "{app}\public"; Flags: ignoreversion
Source: "public\app\*"; DestDir: "{app}\public\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs

; Tools (cloudflared.exe)
Source: ".tools\*"; DestDir: "{app}\.tools"; Flags: ignoreversion recursesubdirs createallsubdirs

; Kilo config
Source: ".kilo\*"; DestDir: "{app}\.kilo"; Flags: ignoreversion recursesubdirs createallsubdirs

; Installation scripts
Source: "install-services.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "uninstall-services.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "start-services.ps1"; DestDir: "{app}"; Flags: ignoreversion

; Do NOT install: .env (contains secrets), data/ (runtime DB), memory/, uploads/, node_modules/, .git/

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\server.js"
Name: "{group}\Start All Services"; Filename: "{app}\start-services.ps1"
Name: "{group}\Stop All Services"; Filename: "{app}\uninstall-services.ps1"
Name: "{group}\Uninstall"; Filename: "{uninstallexe}"
Name: "{commondesktop}\{#MyAppName}"; Filename: "{app}\server.js"; Tasks: desktopicon

[Run]
; Run installer script after installation (as admin)
Filename: "{app}\install-services.ps1"; Parameters: "-ExecutionPolicy Bypass -File install-services.ps1"; WorkingDir: "{app}"; Flags: runascurrentuser postinstall skipifsilent; Description: "Configure and start Computera Ops services"

[UninstallDelete]
Type: filesanddirs; Name: "{app}\logs"
Type: filesanddirs; Name: "{app}\.pm2"
Type: filesanddirs; Name: "{app}\tools"

[UninstallRun]
Filename: "{app}\uninstall-services.ps1"; Parameters: "-ExecutionPolicy Bypass -File uninstall-services.ps1"; WorkingDir: "{app}"; Flags: runascurrentuser

[Code]
function InitializeSetup(): Boolean;
begin
  Result := True;
end;

function CurStepChanged(CurStep: TSetupStep): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
  if CurStep = ssInstall then
  begin
    { No additional steps needed here - handled by [Run] section }
  end;
end;
