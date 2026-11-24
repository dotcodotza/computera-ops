@echo off
if "%1"=="--version" (
  echo 0.0.0-fake
  exit /b 0
)
if "%1"=="--help" (
  echo fake dsh
  exit /b 0
)
node "%~dp0fake-dsh.mjs" %*
