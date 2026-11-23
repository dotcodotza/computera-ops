#requires -RunAsAdministrator
<#
.SYNOPSIS
    Installs Computera Ops services as Windows services with crash auto-restart.
.DESCRIPTION
    This script:
    1. Checks BitLocker status on C: and warns if enabled
    2. Installs Node.js if missing
    3. Runs npm install (including pm2)
    4. Registers Ollama, Kilo, Computera as Windows services via sc.exe
    5. Starts all services in correct dependency order
.NOTES
    Must be run as Administrator.
#>

$ErrorActionPreference = 'Stop'
$APP_NAME = "Computera Ops"
$APP_DIR = Split-Path -Parent $MyInvocation.MyCommand.Definition
$LOG_FILE = Join-Path $APP_DIR "logs\install.log"
$PM2_HOME = Join-Path $APP_DIR ".pm2"

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
        if ($output -match "Encryption percentage:\s*(\d+)%") {
            $pct = [int]$Matches[1]
            if ($output -match "Conversion Status:\s*Fully\s*Encrypted" -or $pct -eq 100) {
                Write-Log "BitLocker is ENABLED on C: (fully encrypted)." "WARN"
                Write-Log "WARNING: Installing services may trigger BitLocker recovery on reboot." "WARN"
                Write-Log "Consider suspending BitLocker before installing: manage-bde -protectors -disable C: -rc <recovery-key>" "WARN"
                return "Enabled"
            } elseif ($pct -gt 0) {
                Write-Log "BitLocker is in progress on C: ($pct%)." "WARN"
                return "InProgress"
            }
        }
        if ($output -match "Volume Status:\s*Fully\s*Decrypted") {
            Write-Log "BitLocker is OFF on C:."
            return "Off"
        }
        Write-Log "BitLocker status unclear. Output: $output" "WARN"
        return "Unknown"
    } catch {
        Write-Log "Could not check BitLocker status: $($_.Exception.Message)" "WARN"
        return "Unknown"
    }
}

function Suspend-BitLocker {
    param([string]$RecoveryKey)
    Write-Log "Suspending BitLocker on C:..."
    if ($RecoveryKey) {
        manage-bde -protectors -disable C: -rc $RecoveryKey 2>&1 | Out-Null
    } else {
        manage-bde -protectors -disable C: 2>&1 | Out-Null
    }
    Write-Log "BitLocker suspended. Remember to re-enable after install: manage-bde -protectors -enable C:" "WARN"
}

function Resume-BitLocker {
    Write-Log "Re-enabling BitLocker on C:..."
    manage-bde -protectors -enable C: 2>&1 | Out-Null
    Write-Log "BitLocker re-enabled."
}

function Install-NodeJs {
    Write-Log "Checking for Node.js..."
    $nodePath = Get-Command node -ErrorAction SilentlyContinue
    if ($nodePath) {
        $version = node --version 2>&1
        Write-Log "Node.js found: $version"
        return $true
    }

    Write-Log "Node.js not found. Downloading Node.js LTS..."
    $tempDir = Join-Path $env:TEMP "computera-install"
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
    $msiPath = Join-Path $tempDir "nodejs-lts.msi"

    # Download Node.js LTS MSI
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

function Install-NpmPackages {
    Write-Log "Installing npm packages (pm2)..."
    Push-Location $APP_DIR
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
        # nssm 2.24 for 64-bit Windows
        $url = "https://nssm.cc/release/nssm-2.24-101-g897ce78.zip"
        Invoke-WebRequest -Uri $url -OutFile $zipPath -TimeoutSec 120
        Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force
        $nssmExe = Get-ChildItem -Path $tempDir -Filter "nssm.exe" -Recurse | Select-Object -First 1
        if ($nssmExe) {
            # Copy nssm to app directory
            $dest = Join-Path $APP_DIR "tools\nssm.exe"
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

    # Check if service already exists
    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Log "Service $ServiceName already exists. Removing..."
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        sc.exe delete $ServiceName 2>&1 | Out-Null
        Start-Sleep -Seconds 2
    }

    # Build the full command for nssm or sc.exe
    $nssmPath = Join-Path $APP_DIR "tools\nssm.exe"
    if (Test-Path $nssmPath) {
        # Use nssm for better service management
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
        # Fallback to sc.exe
        $binPath = "$BinaryPath $Arguments"
        $depArg = ""
        if ($Dependencies.Count -gt 0) {
            $depArg = " depend= " + ($Dependencies -join "/")
        }
        sc.exe create $ServiceName binPath= "$binPath" start= auto $depArg 2>&1 | Out-Null
        sc.exe description $ServiceName $Description 2>&1 | Out-Null
        # Enable failure actions (restart on crash)
        sc.exe failure $ServiceName actions= restart/5000 restart/5000 restart/5000 reset= 86400 2>&1 | Out-Null
    }

    Write-Log "Service $ServiceName registered."
}

function Start-ServiceOrdered {
    param([string[]]$ServiceNames)

    foreach ($name in $ServiceNames) {
        Write-Log "Starting service: $name..."
        try {
            Start-Service -Name $name -ErrorAction Stop
            Write-Log "Service $name started."
        } catch {
            Write-Log "Failed to start ${name}: $($_.Exception.Message)" "WARN"
        }
        # Wait a moment between starts for dependency ordering
        Start-Sleep -Seconds 3
    }
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
Write-Log "Installing $APP_NAME Windows Services"
Write-Log "========================================"

# Step 1: Check BitLocker
$bitlockerStatus = Check-BitLocker
if ($bitlockerStatus -eq "Enabled") {
    Write-Log "BitLocker is enabled. Installation may trigger recovery mode on reboot." "WARN"
    Write-Log "Press Enter to continue, or Ctrl+C to suspend BitLocker first."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}

# Step 2: Install Node.js if missing
if (-not (Install-NodeJs)) {
    Write-Log "Failed to install Node.js. Aborting." "ERROR"
    exit 1
}

# Refresh PATH for newly installed Node.js
$env:PATH = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")

# Step 3: Install npm packages
if (-not (Install-NpmPackages)) {
    Write-Log "Failed to install npm packages. Aborting." "ERROR"
    exit 1
}

# Step 4: Download nssm (optional, falls back to sc.exe)
Install-Nssm | Out-Null

# Step 5: Register services
# Paths to executables
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
$ollamaExe = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollamaExe) {
    $ollamaExe = "C:\Program Files\Ollama\ollama.exe"
}
$kiloExe = Get-Command kilo -ErrorAction SilentlyContinue
if (-not $kiloExe) {
    $kiloExe = Join-Path $env:APPDATA "npm\kilo.cmd"
}

# Register Ollama (no dependencies)
Register-Service -ServiceName "computera-ollama" `
    -DisplayName "Computera Ops - Ollama" `
    -BinaryPath $ollamaExe.Source `
    -Arguments "serve" `
    -Description "Ollama LLM server for Computera Ops"

# Register Kilo (no dependencies)
Register-Service -ServiceName "computera-kilo" `
    -DisplayName "Computera Ops - Kilo Gateway" `
    -BinaryPath $nodeExe `
    -Arguments """$kiloExe"" serve --port 7777 --hostname 127.0.0.1" `
    -Description "Kilo Gateway server for Computera Ops"

# Register Computera (depends on Ollama and Kilo)
Register-Service -ServiceName "computera-app" `
    -DisplayName "Computera Ops - Main App" `
    -BinaryPath $nodeExe `
    -Arguments """$APP_DIR\server.js""" `
    -Dependencies @("computera-ollama", "computera-kilo") `
    -Description "Computera Ops main application server"

# Step 6: Start services in order
Write-Log "Starting services..."
Start-ServiceOrdered -ServiceNames @("computera-ollama")
Wait-ForPort -Port 11434 -TimeoutSeconds 120

Start-ServiceOrdered -ServiceNames @("computera-kilo")
Wait-ForPort -Port 7777 -TimeoutSeconds 60

Start-ServiceOrdered -ServiceNames @("computera-app")
Wait-ForPort -Port 3001 -TimeoutSeconds 60

# Step 7: Re-enable BitLocker if it was suspended
if ($bitlockerStatus -eq "Enabled") {
    Write-Log "BitLocker was enabled. Consider re-enabling: manage-bde -protectors -enable C:" "WARN"
}

Write-Log "========================================"
Write-Log "Installation complete!"
Write-Log "Services: computera-ollama, computera-kilo, computera-app"
Write-Log "========================================"
