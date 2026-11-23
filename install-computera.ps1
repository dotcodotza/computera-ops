#requires -RunAsAdministrator
<#
.SYNOPSIS
    Complete installer for Computera Ops Windows services.
.DESCRIPTION
    This script:
    1. Checks BitLocker status on C: and warns if enabled
    2. Installs Node.js if missing
    3. Copies project files to target directory
    4. Runs npm install (including pm2)
    5. Registers Ollama, Kilo, Computera as Windows services
    6. Starts all services in correct dependency order
.NOTES
    Must be run as Administrator.
    Usage: .\install-computera.ps1 -TargetDir "C:\Path\To\Install"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [string]$TargetDir = (Get-Location).Path,
    
    [Parameter(Mandatory=$false)]
    [switch]$SkipNodeInstall,
    
    [Parameter(Mandatory=$false)]
    [switch]$SkipNpmInstall,
    
    [Parameter(Mandatory=$false)]
    [switch]$SkipServiceInstall,
    
    [Parameter(Mandatory=$false)]
    [switch]$StartServices
)

$ErrorActionPreference = 'Stop'
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Definition
$LOG_FILE = Join-Path $TargetDir "logs\install.log"

# Ensure log directory exists
New-Item -ItemType Directory -Force -Path (Split-Path $LOG_FILE) | Out-Null

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] [$Level] $Message"
    Write-Host $line
    Add-Content -Path $LOG_FILE -Value $line
}

function Test-Admin {
    $currentUser = [Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
    return $currentUser.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Check-BitLocker {
    Write-Log "Checking BitLocker status on C:..."
    try {
        $output = manage-bde -status C: 2>&1
        if ($output -match "Conversion Status:\s*Fully\s*Encrypted") {
            Write-Log "BitLocker is ENABLED on C: (fully encrypted)." "WARN"
            Write-Log "WARNING: Installing services may trigger BitLocker recovery on reboot." "WARN"
            Write-Log "Consider suspending BitLocker before installing: manage-bde -protectors -disable C: -rc <recovery-key>" "WARN"
            return "Enabled"
        } elseif ($output -match "Conversion Status:\s*Encryption\s*in\s*progress") {
            Write-Log "BitLocker is in progress on C:." "WARN"
            return "InProgress"
        } elseif ($output -match "Volume Status:\s*Fully\s*Decrypted") {
            Write-Log "BitLocker is OFF on C:."
            return "Off"
        }
        Write-Log "BitLocker status unclear." "WARN"
        return "Unknown"
    } catch {
        Write-Log "Could not check BitLocker status: $($_.Exception.Message)" "WARN"
        return "Unknown"
    }
}

function Install-NodeJs {
    Write-Log "Checking for Node.js..."
    $nodePath = Get-Command node -ErrorAction SilentlyContinue
    if ($nodePath) {
        $version = node --version 2>&1
        Write-Log "Node.js found: $version"
        return $true
    }

    if ($SkipNodeInstall) {
        Write-Log "Skipping Node.js installation (requested)." "WARN"
        return $false
    }

    Write-Log "Node.js not found. Downloading Node.js LTS..."
    $tempDir = Join-Path $env:TEMP "computera-install"
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
    $msiPath = Join-Path $tempDir "nodejs-lts.msi"

    $url = "https://nodejs.org/dist/latest-v20.x/node-v20.18.1-x64.msi"
    try {
        Invoke-WebRequest -Uri $url -OutFile $msiPath -TimeoutSec 300
        Write-Log "Downloaded Node.js installer to $msiPath"
    } catch {
        Write-Log "Failed to download Node.js: $($_.Exception.Message)" "ERROR"
        return $false
    }

    Write-Log "Installing Node.js..."
    $installArgs = "/i `"$msiPath`" /quiet /norestart ACCEPTULA=1"
    $process = Start-Process -FilePath "msiexec.exe" -ArgumentList $installArgs -Wait -Passthru
    if ($process.ExitCode -eq 0 -or $process.ExitCode -eq 3010) {
        Write-Log "Node.js installed successfully."
        return $true
    } else {
        Write-Log "Node.js installation failed with exit code $($process.ExitCode)" "ERROR"
        return $false
    }
}

function Copy-ProjectFiles {
    Write-Log "Copying project files to $TargetDir..."
    
    $excludePatterns = @(
        "node_modules", ".git", ".env", "data/app.db", "data/app.db-shm",
        "data/app.db-wal", "logs", ".pm2", "output", "*.ps1", "*.SED", "*.iss"
    )
    
    $sourceFiles = Get-ChildItem -Path $SCRIPT_DIR -Exclude "node_modules", ".git", "logs", ".pm2", "output" -File
    foreach ($file in $sourceFiles) {
        $dest = Join-Path $TargetDir $file.Name
        if ($file.Name -match "^\.env$") {
            # Skip .env (contains secrets), but copy .env.example
            continue
        }
        Copy-Item -Path $file.FullName -Destination $dest -Force
        Write-Log "  Copied: $($file.Name)"
    }
    
    # Copy directories
    $dirsToCopy = @("public", ".tools", ".kilo")
    foreach ($dirName in $dirsToCopy) {
        $srcDir = Join-Path $SCRIPT_DIR $dirName
        $destDir = Join-Path $TargetDir $dirName
        if (Test-Path $srcDir) {
            Copy-Item -Path $srcDir -Destination $destDir -Recurse -Force
            Write-Log "  Copied directory: $dirName/"
        }
    }
    
    # Copy package files
    foreach ($pkgFile in @("package.json", "package-lock.json")) {
        $src = Join-Path $SCRIPT_DIR $pkgFile
        $dest = Join-Path $TargetDir $pkgFile
        if (Test-Path $src) {
            Copy-Item -Path $src -Destination $dest -Force
            Write-Log "  Copied: $pkgFile"
        }
    }
    
    Write-Log "Project files copied."
}

function Install-NpmPackages {
    Write-Log "Installing npm packages (pm2)..."
    if ($SkipNpmInstall) {
        Write-Log "Skipping npm install (requested)." "WARN"
        return $true
    }
    
    Push-Location $TargetDir
    try {
        $npmInstall = npm install 2>&1
        Write-Log $npmInstall
        Write-Log "npm packages installed."
    } catch {
        Write-Log "npm install failed: $($_.Exception.Message)" "ERROR"
        return $false
    } finally {
        Pop-Location
    }
    return $true
}

function Install-Nssm {
    Write-Log "Checking for nssm..."
    $nssmPath = Get-Command nssm -ErrorAction SilentlyContinue
    if ($nssmPath) {
        Write-Log "nssm found."
        return $true
    }

    Write-Log "Downloading nssm..."
    $tempDir = Join-Path $env:TEMP "computera-install"
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
    $zipPath = Join-Path $tempDir "nssm.zip"

    try {
        $url = "https://nssm.cc/release/nssm-2.24-101-g897ce78.zip"
        Invoke-WebRequest -Uri $url -OutFile $zipPath -TimeoutSec 120
        Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force
        $nssmExe = Get-ChildItem -Path $tempDir -Filter "nssm.exe" -Recurse | Select-Object -First 1
        if ($nssmExe) {
            $dest = Join-Path $TargetDir "tools\nssm.exe"
            New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
            Copy-Item -Path $nssmExe.FullName -Destination $dest -Force
            Write-Log "nssm installed to $dest"
            return $true
        }
    } catch {
        Write-Log "Failed to download nssm: $($_.Exception.Message). Will use sc.exe instead." "WARN"
    }
    return $false
}

function Register-Service {
    param(
        [string]$ServiceName,
        [string]$DisplayName,
        [string]$BinaryPath,
        [string]$Arguments,
        [string[]]$Dependencies = @(),
        [string]$Description
    )

    Write-Log "Registering service: $ServiceName..."

    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Log "Service $ServiceName already exists. Removing..."
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        sc.exe delete $ServiceName 2>&1 | Out-Null
        Start-Sleep -Seconds 2
    }

    $nssmPath = Join-Path $TargetDir "tools\nssm.exe"
    if (Test-Path $nssmPath) {
        & $nssmPath install $ServiceName $BinaryPath $Arguments 2>&1 | Out-Null
        & $nssmPath set $ServiceName DisplayName $DisplayName 2>&1 | Out-Null
        & $nssmPath set $ServiceName Description $Description 2>&1 | Out-Null
        & $nssmPath set $ServiceName Start SERVICE_AUTO_START 2>&1 | Out-Null
        & $nssmPath set $ServiceName Restart 1 2>&1 | Out-Null
        & $nssmPath set $ServiceName RestartDelay 5000 2>&1 | Out-Null
        if ($Dependencies.Count -gt 0) {
            $depStr = $Dependencies -join "/"
            & $nssmPath set $ServiceName DependOnService $depStr 2>&1 | Out-Null
        }
    } else {
        $binPath = "$BinaryPath $Arguments"
        $depArg = ""
        if ($Dependencies.Count -gt 0) {
            $depArg = " depend= " + ($Dependencies -join "/")
        }
        sc.exe create $ServiceName binPath= "$binPath" start= auto $depArg 2>&1 | Out-Null
        sc.exe description $ServiceName $Description 2>&1 | Out-Null
        sc.exe failure $ServiceName actions= restart/5000 restart/5000 restart/5000 reset= 86400 2>&1 | Out-Null
    }

    Write-Log "Service $ServiceName registered."
}

function Wait-ForPort {
    param([int]$Port, [int]$TimeoutSeconds = 60)
    Write-Log "Waiting for port $Port to become available..."
    $start = Get-Date
    while ((Get-Date) - $start -lt (New-TimeSpan -Seconds $TimeoutSeconds)) {
        try {
            $test = Test-NetConnection -Port $Port -ComputerName 127.0.0.1 -InformationLevel Quiet -ErrorAction SilentlyContinue
            if ($test) {
                Write-Log "Port $Port is available."
                return $true
            }
        } catch {}
        Start-Sleep -Seconds 2
    }
    Write-Log "Timeout waiting for port $Port." "WARN"
    return $false
}

# ============================================================================
# Main
# ============================================================================

if (-not (Test-Admin)) {
    Write-Log "ERROR: This script must be run as Administrator." "ERROR"
    Write-Log "Right-click PowerShell and select 'Run as Administrator'."
    exit 1
}

Write-Log "========================================"
Write-Log "Computera Ops Installer"
Write-Log "Target: $TargetDir"
Write-Log "========================================"

# Step 1: Check BitLocker
$bitlockerStatus = Check-BitLocker
if ($bitlockerStatus -eq "Enabled") {
    Write-Log "BitLocker is enabled. Installation may trigger recovery mode on reboot." "WARN"
}

# Step 2: Install Node.js if missing
if (-not (Install-NodeJs)) {
    Write-Log "Node.js is required but could not be installed. Aborting." "ERROR"
    exit 1
}

# Refresh PATH
$env:PATH = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")

# Step 3: Copy project files
Copy-ProjectFiles

# Step 4: Install npm packages
if (-not (Install-NpmPackages)) {
    Write-Log "npm install failed. Aborting." "ERROR"
    exit 1
}

# Step 5: Download nssm (optional)
Install-Nssm | Out-Null

# Step 6: Register services
if (-not $SkipServiceInstall) {
    $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
    $ollamaExe = Get-Command ollama -ErrorAction SilentlyContinue
    if (-not $ollamaExe) {
        $candidates = @(
            "C:\Program Files\Ollama\ollama.exe",
            "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"
        )
        $ollamaExe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
        if (-not $ollamaExe) {
            $ollamaExe = "ollama"
        }
    }
    $kiloCandidates = @(
        Join-Path $env:APPDATA "npm\kilo.cmd",
        Join-Path $env:LOCALAPPDATA "npm\kilo.cmd",
        Join-Path $env:APPDATA "npm\node_modules\@kilocode\cli\bin\kilo",
        Join-Path $env:LOCALAPPDATA "npm\node_modules\@kilocode\cli\bin\kilo"
    )
    $kiloExe = $kiloCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $kiloExe) {
        $kiloExe = "kilo"
    }

    Register-Service -ServiceName "computera-ollama" `
        -DisplayName "Computera Ops - Ollama" `
        -BinaryPath $ollamaExe.Source `
        -Arguments "serve" `
        -Description "Ollama LLM server for Computera Ops"

    Register-Service -ServiceName "computera-kilo" `
        -DisplayName "Computera Ops - Kilo Gateway" `
        -BinaryPath $nodeExe `
        -Arguments """$kiloExe"" serve --port 7777 --hostname 127.0.0.1" `
        -Description "Kilo Gateway server for Computera Ops"

    Register-Service -ServiceName "computera-app" `
        -DisplayName "Computera Ops - Main App" `
        -BinaryPath $nodeExe `
        -Arguments """$TargetDir\server.js""" `
        -Dependencies @("computera-ollama", "computera-kilo") `
        -Description "Computera Ops main application server"
}

# Step 7: Start services
if ($StartServices) {
    Write-Log "Starting services..."
    Start-Service -Name "computera-ollama" -ErrorAction SilentlyContinue
    Wait-ForPort -Port 11434 -TimeoutSeconds 120
    
    Start-Service -Name "computera-kilo" -ErrorAction SilentlyContinue
    Wait-ForPort -Port 7777 -TimeoutSeconds 60
    
    Start-Service -Name "computera-app" -ErrorAction SilentlyContinue
    Wait-ForPort -Port 3001 -TimeoutSeconds 60
    
    Write-Log "All services started!"
    Write-Log "Computera: http://localhost:3001"
    Write-Log "Kilo:      http://127.0.0.1:7777"
    Write-Log "Ollama:    http://localhost:11434"
}

if ($bitlockerStatus -eq "Enabled") {
    Write-Log "Remember to re-enable BitLocker: manage-bde -protectors -enable C:" "WARN"
}

Write-Log "========================================"
Write-Log "Installation complete!"
Write-Log "========================================"
