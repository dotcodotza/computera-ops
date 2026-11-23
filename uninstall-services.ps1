#requires -RunAsAdministrator
<#
.SYNOPSIS
    Uninstalls Computera Ops Windows services.
.DESCRIPTION
    This script:
    1. Stops all Computera Ops services
    2. Removes service registrations
    3. Removes PM2 process list
    4. Optionally removes Node.js and npm packages
.NOTES
    Must be run as Administrator.
#>

$ErrorActionPreference = 'Stop'
$APP_DIR = Split-Path -Parent $MyInvocation.MyCommand.Definition
$LOG_FILE = Join-Path $APP_DIR "logs\uninstall.log"

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

function Remove-ServiceIfExists {
    param([string]$ServiceName)
    Write-Log "Checking service: $ServiceName..."
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc) {
        Write-Log "Stopping $ServiceName..."
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Write-Log "Removing $ServiceName..."
        sc.exe delete $ServiceName 2>&1 | Out-Null
        Write-Log "Service $ServiceName removed."
    } else {
        Write-Log "Service $ServiceName not found (skipping)."
    }
}

# ============================================================================
# Main
# ============================================================================

if (-not (Test-Admin)) {
    Write-Log "ERROR: This script must be run as Administrator." "ERROR"
    exit 1
}

Write-Log "========================================"
Write-Log "Uninstalling Computera Ops Windows Services"
Write-Log "========================================"

# Stop and remove services in reverse dependency order
Remove-ServiceIfExists -ServiceName "computera-app"
Remove-ServiceIfExists -ServiceName "computera-kilo"
Remove-ServiceIfExists -ServiceName "computera-ollama"

# Delete PM2 process list
$pm2Dir = Join-Path $APP_DIR ".pm2"
if (Test-Path $pm2Dir) {
    Write-Log "Removing PM2 data directory..."
    Remove-Item -Path $pm2Dir -Recurse -Force -ErrorAction SilentlyContinue
}

# Delete logs directory
$logsDir = Join-Path $APP_DIR "logs"
if (Test-Path $logsDir) {
    Write-Log "Removing logs directory..."
    Remove-Item -Path $logsDir -Recurse -Force -ErrorAction SilentlyContinue
}

# Delete tools directory (nssm)
$toolsDir = Join-Path $APP_DIR "tools"
if (Test-Path $toolsDir) {
    Write-Log "Removing tools directory..."
    Remove-Item -Path $toolsDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Log "========================================"
Write-Log "Uninstallation complete."
Write-Log "Note: Node.js and project files are NOT removed."
Write-Log "========================================"
