@echo off
rem ============================================================================
rem  menu-admin - start the Flask server (port 8808)
rem  ---------------------------------------------------------------------------
rem  . No console window is left behind: this launcher only checks the
rem    environment, then hands over to a HIDDEN background process
rem    (tools\start-server.ps1 via tools\_run_hidden.vbs) and exits at once.
rem  . Server output (startup lines + request log) is appended to
rem        logs\server.log          (rotated to server.log.1 above 5 MB)
rem  . To stop the server, run stop.bat.
rem ============================================================================
setlocal
set "PYTHON=C:\Users\chx\.workbuddy\binaries\python\envs\menuadmin\Scripts\python.exe"
set "PROJ_DIR=%~dp0"

if not exist "%PYTHON%" (
    echo [ERROR] Python interpreter not found:
    echo         %PYTHON%
    echo         Edit the PYTHON variable at the top of start.bat
    echo.
    pause
    exit /b 1
)

if not exist "%PROJ_DIR%server\app.py" (
    echo [ERROR] server\app.py not found under:
    echo         %PROJ_DIR%
    echo         Run this script from the project root folder.
    echo.
    pause
    exit /b 1
)

if not exist "%PROJ_DIR%tools\start-server.ps1" (
    echo [ERROR] tools\start-server.ps1 is missing.
    echo.
    pause
    exit /b 1
)

if not exist "%PROJ_DIR%tools\_run_hidden.vbs" (
    echo [ERROR] tools\_run_hidden.vbs is missing.
    echo.
    pause
    exit /b 1
)

rem ---- hand over to a hidden background process, then quit immediately ----
wscript //nologo "%PROJ_DIR%tools\_run_hidden.vbs" "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""%PROJ_DIR%tools\start-server.ps1"""

endlocal
exit /b 0
