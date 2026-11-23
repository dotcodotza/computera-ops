[Version]
Class=IEXPRESS
SEDVersion=3

[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
RebootMode=N
TargetName=%TEMP%\ComputeraOpsSetup.exe
FriendlyName="Computera Ops Installer"
AppLaunched=setup.cmd
PostInstallCmd=<None>
SourceFiles=SourceFiles

[Strings]
FriendlyName="Computera Ops Installer"

[SourceFiles]
SourceFiles=1,"install-services.ps1"
SourceFiles=2,"uninstall-services.ps1"
SourceFiles=3,"start-services.ps1"
SourceFiles=4,"setup.cmd"

; SourceFiles for project files will be added dynamically

[SourceFiles0]
; Placeholder
