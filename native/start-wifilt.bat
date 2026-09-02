@echo off
rem Convenience launcher: starts wifilt.exe (and local-trx.exe, if it is
rem sitting right next to this script -- see BUILD.md section 5) and opens
rem both web interfaces in the browser. Not a required step -- double-
rem clicking either .exe directly works exactly as before; this just saves
rem an operator from having to know there are two separate programs at all.
rem
rem Usage:
rem   start-wifilt.bat          (re)start both -- an already-running copy of
rem                             either one is stopped first, see below
rem   start-wifilt.bat stop     stop both, do not start anything
rem
rem wifilt.ino/native/ itself stays completely unaware of local-trx (bod
rem 1/12's "zero diff" -- see docs/local-trx-implementace.md): this script
rem is the thing that knows about both, not either .exe.
setlocal
set "HERE=%~dp0"

if /I "%~1"=="stop" (
    echo Stopping wifilt and local-trx if running...
    taskkill /F /IM wifilt.exe >nul 2>&1
    taskkill /F /IM local-trx.exe >nul 2>&1
    endlocal
    exit /b 0
)

rem taskkill matches by image name only -- Windows has no cheap equivalent
rem of the .sh launcher's /proc/PID/exe-path check -- so this assumes a
rem single install of each on the machine, the same assumption the rest of
rem this script already makes. "not found" is silenced (>nul 2>&1) since
rem the common case on a fresh boot is nothing to kill yet.
echo wifilt: stopping any already-running copy...
taskkill /F /IM wifilt.exe >nul 2>&1

echo wifilt: starting...
start "wifilt" "%HERE%wifilt.exe" --data-dir "%HERE%data"
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1/"

if exist "%HERE%local-trx.exe" (
    echo local-trx: stopping any already-running copy...
    taskkill /F /IM local-trx.exe >nul 2>&1

    echo local-trx: starting...
    rem Suppresses local-trx's own openBrowserOnStart (main.cpp) -- this
    rem script opens both tabs itself below, so local-trx's own copy of
    rem that logic firing too (if the operator has also turned it on in
    rem local-trx's config) would open the wizard tab a second time. `start`
    rem inherits this cmd session's environment into the new process.
    set "LOCAL_TRX_SKIP_AUTO_OPEN=1"
    start "local-trx" "%HERE%local-trx.exe"
    timeout /t 1 /nobreak >nul
    start "" "http://127.0.0.1:8765/"
)

endlocal
