<#
.SYNOPSIS
    Starts Computera Ops services in dependency order.
.DESCRIPTION
    Starts Ollama, then Kilo, then Computera app.
    Waits for each port to become available before starting the next.
.NOTES
    Can be run as a normal user or as a Windows service start script.
#>

$ErrorActionPreference = 'Continue'
$APP_DIR = Split-Path -Parent $MyInvocation.MyCommand.Definition
$LOG_FILE = Join-Path $APP_DIR "logs\startup.log"

New-Item -ItemType Directory -Force -Path (Split-Path $LOG_FILE) | Out-Null

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] [$Level] $Message"
    Write-Host $line
    Add-Content -Path $LOG_FILE -Value $line
}

function Wait-ForPort {
    param([int]$Port, [int]$TimeoutSeconds = 120)
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

Write-Log "========================================"
Write-Log "Starting Computera Ops Services"
Write-Log "========================================"

# Step 1: Start Ollama (no dependencies)
$ollamaSvc = Get-Service -Name "computera-ollama" -ErrorAction SilentlyContinue
if ($ollamaSvc) {
    if ($ollamaSvc.Status -ne 'Running') {
        Write-Log "Starting Ollama service..."
        Start-Service -Name "computera-ollama" -ErrorAction SilentlyContinue
    }
    Wait-ForPort -Port 11434 -TimeoutSeconds 120
} else {
    Write-Log "Ollama service not found. Starting manually..."
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
    Wait-ForPort -Port 11434 -TimeoutSeconds 120
}

# Step 2: Start Kilo (depends on Ollama)
$kiloSvc = Get-Service -Name "computera-kilo" -ErrorAction SilentlyContinue
if ($kiloSvc) {
    if ($kiloSvc.Status -ne 'Running') {
        Write-Log "Starting Kilo service..."
        Start-Service -Name "computera-kilo" -ErrorAction SilentlyContinue
    }
    Wait-ForPort -Port 7777 -TimeoutSeconds 60
} else {
    Write-Log "Kilo service not found. Starting manually..."
    $kiloExe = Join-Path $env:APPDATA "npm\kilo.cmd"
    if (Test-Path $kiloExe) {
        Start-Process -FilePath $kiloExe -ArgumentList "serve --port 7777 --hostname 127.0.0.1" -WindowStyle Hidden
    } else {
        Start-Process -FilePath "kilo" -ArgumentList "serve --port 7777 --hostname 127.0.0.1" -WindowStyle Hidden
    }
    Wait-ForPort -Port 7777 -TimeoutSeconds 60
}

# Step 3: Start Computera app (depends on Ollama and Kilo)
$appSvc = Get-Service -Name "computera-app" -ErrorAction SilentlyContinue
if ($appSvc) {
    if ($appSvc.Status -ne 'Running') {
        Write-Log "Starting Computera app service..."
        Start-Service -Name "computera-app" -ErrorAction SilentlyContinue
    }
    Wait-ForPort -Port 3001 -TimeoutSeconds 60
} else {
    Write-Log "Computera app service not found. Starting via PM2..."
    Push-Location $APP_DIR
    npm run pm2:start 2>&1 | Out-Null
    Pop-Location
    Wait-ForPort -Port 3001 -TimeoutSeconds 60
}

Write-Log "========================================"
Write-Log "All services started."
Write-Log "Computera: http://localhost:3001"
Write-Log "Kilo:      http://127.0.0.1:7777"
Write-Log "Ollama:    http://localhost:11434"
Write-Log "========================================"
