@echo off
REM vault-chat launcher — Windows.
REM Checks toolchain, installs node deps on first run, then launches
REM the Tauri dev server. Add this folder to PATH so `vc` just works.
setlocal

set "SCRIPT_DIR=%~dp0"
set "REPO=%SCRIPT_DIR%.."

where node >nul 2>&1
if errorlevel 1 (
  echo vault-chat: missing 'node'.
  echo Install Node 20+ — https://nodejs.org
  exit /b 1
)

where cargo >nul 2>&1
if errorlevel 1 (
  echo vault-chat: missing 'cargo'.
  echo Install Rust via rustup — https://rustup.rs
  exit /b 1
)

where git >nul 2>&1
if errorlevel 1 (
  echo vault-chat: missing 'git'.
  echo Install git — https://git-scm.com/downloads
  exit /b 1
)

pushd "%REPO%"

if not exist node_modules (
  echo vault-chat: installing node deps ^(one-time, ~1 min^)…
  call npm install --silent
  if errorlevel 1 (
    popd
    exit /b 1
  )
)

call npm run tauri dev
set "EXIT=%ERRORLEVEL%"
popd
exit /b %EXIT%
