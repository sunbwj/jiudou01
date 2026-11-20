@echo off
rem ============================================================================
rem  menu-admin - stop the Flask server (port 8808)
rem  ---------------------------------------------------------------------------
rem  The server runs in a hidden background console, so there is no window to
rem  press Ctrl+C in - use this script. The stop event is appended to
rem  logs\server.log as well.
rem ============================================================================
setlocal
set "PROJ_DIR=%~dp0"

if not exist "%PROJ_DIR%tools\stop-server.ps1" (
    echo [ERROR] tools\stop-server.ps1 is missing.
    echo.
    pause
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJ_DIR%tools\stop-server.ps1"

echo.
echo Press any key to close this window ...
pause >nul
endlocal
exit /b 0
