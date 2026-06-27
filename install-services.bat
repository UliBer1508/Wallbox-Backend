@echo off
REM ============================================================
REM  install-services.bat
REM  Richtet die beiden Wallbox-Dienste als Autostart ein (NSSM):
REM    - WallboxBackend   (node src\server.js)
REM    - CloudflaredTunnel (cloudflared tunnel run wallbox)
REM
REM  VORAUSSETZUNGEN:
REM    - NSSM installiert (nssm.exe in PATH oder C:\Windows\System32)
REM    - Node.js installiert
REM    - cloudflared.exe im Projektordner
REM    - Alte CMD-Fenster (npm start / cloudflared) geschlossen!
REM
REM  ALS ADMINISTRATOR AUSFUEHREN!
REM ============================================================

setlocal
set "PROJECT=C:\Users\ulibe\Wallbox-Backend"
set "SERVICE_BACKEND=WallboxBackend"
set "SERVICE_TUNNEL=CloudflaredTunnel"
set "NODE_EXE=C:\Program Files\nodejs\node.exe"

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [FEHLER] Bitte als Administrator ausfuehren.
    pause
    exit /b 1
)

echo.
echo === Backend-Dienst einrichten ===
nssm install "%SERVICE_BACKEND%" "%NODE_EXE%" "%PROJECT%\src\server.js"
nssm set "%SERVICE_BACKEND%" AppDirectory "%PROJECT%"
nssm set "%SERVICE_BACKEND%" Start SERVICE_AUTO_START
nssm set "%SERVICE_BACKEND%" AppStdout "%PROJECT%\logs\backend.log"
nssm set "%SERVICE_BACKEND%" AppStderr "%PROJECT%\logs\backend-error.log"

echo.
echo === Cloudflare-Tunnel-Dienst einrichten ===
nssm install "%SERVICE_TUNNEL%" "%PROJECT%\cloudflared.exe" "tunnel run wallbox"
nssm set "%SERVICE_TUNNEL%" AppDirectory "%PROJECT%"
nssm set "%SERVICE_TUNNEL%" Start SERVICE_AUTO_START
nssm set "%SERVICE_TUNNEL%" AppStdout "%PROJECT%\logs\tunnel.log"
nssm set "%SERVICE_TUNNEL%" AppStderr "%PROJECT%\logs\tunnel-error.log"

echo.
echo === Logs-Ordner anlegen ===
if not exist "%PROJECT%\logs" mkdir "%PROJECT%\logs"

echo.
echo === Dienste starten ===
nssm start "%SERVICE_BACKEND%"
nssm start "%SERVICE_TUNNEL%"

echo.
echo Fertig. Status pruefen mit:
echo   nssm status %SERVICE_BACKEND%
echo   nssm status %SERVICE_TUNNEL%
echo.
pause
endlocal
