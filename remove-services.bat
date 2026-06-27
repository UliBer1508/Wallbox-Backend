@echo off
REM ============================================================
REM  remove-services.bat
REM  Entfernt die beiden Wallbox-Dienste wieder.
REM  Danach laeuft nichts mehr automatisch - Start dann wieder
REM  manuell per npm start / cloudflared tunnel run wallbox.
REM
REM  ALS ADMINISTRATOR AUSFUEHREN!
REM ============================================================

setlocal
set "SERVICE_BACKEND=WallboxBackend"
set "SERVICE_TUNNEL=CloudflaredTunnel"

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [FEHLER] Bitte als Administrator ausfuehren.
    pause
    exit /b 1
)

echo Stoppe und entferne Dienste...
nssm stop "%SERVICE_BACKEND%" >nul 2>&1
nssm remove "%SERVICE_BACKEND%" confirm
nssm stop "%SERVICE_TUNNEL%" >nul 2>&1
nssm remove "%SERVICE_TUNNEL%" confirm

echo.
echo Fertig. Beide Dienste wurden entfernt.
echo.
pause
endlocal
