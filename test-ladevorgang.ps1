# ============================================================
#  test-ladevorgang.ps1
#  Begleitet einen Lade-Test und schreibt alles mit.
#
#  - Vorab-Check: Backend online? Boxen erreichbar? Box frei?
#  - Live-Mitschnitt: volle JSON-Zeile in die Datei,
#    am Bildschirm farbig hervorgehoben bei wichtigen Ereignissen
#    (Zustandswechsel, Auto angesteckt, Energie/Betrag, Warte-Timeout).
#  - Am Ende (Strg+C): zeigt die letzte Quittung aus der Datenbank.
#
#  Aufruf (im Projektordner):
#     powershell -ExecutionPolicy Bypass -File .\test-ladevorgang.ps1
#  Optional andere Box:  -Wb p30c
# ============================================================

param(
  [string]$Wb       = "p30x",
  [string]$BaseUrl  = "http://localhost:8080",
  [string]$Project  = "C:\Users\ulibe\Wallbox-Backend",
  [int]   $Interval = 1
)

$ErrorActionPreference = "SilentlyContinue"
$logFile = Join-Path $Project ("test-protokoll-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".txt")

function Write-Log($text, $color = "Gray") {
  Write-Host $text -ForegroundColor $color
  Add-Content -Path $logFile -Value $text
}

function Get-State {
  try { return (Invoke-WebRequest -UseBasicParsing "$BaseUrl/api/state" -TimeoutSec 5).Content | ConvertFrom-Json }
  catch { return $null }
}

# ---------------- VORAB-CHECK ----------------
Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  WALLBOX LADE-TEST  -  Box: $Wb" -ForegroundColor Cyan
Write-Host "  Protokoll: $logFile" -ForegroundColor DarkGray
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "Vorab-Check..." -ForegroundColor Yellow
$state = Get-State
if ($null -eq $state) {
  Write-Host "  [FEHLER] Backend nicht erreichbar unter $BaseUrl" -ForegroundColor Red
  Write-Host "  Laeuft der Dienst? -> nssm status WallboxBackend" -ForegroundColor Red
  exit 1
}
Write-Host "  [OK] Backend erreichbar" -ForegroundColor Green

$box = $state.wallboxen | Where-Object { $_.id -eq $Wb }
if ($null -eq $box) {
  Write-Host "  [FEHLER] Box '$Wb' nicht gefunden. Verfuegbar: $($state.wallboxen.id -join ', ')" -ForegroundColor Red
  exit 1
}
if ($box.online) { Write-Host "  [OK] Box '$Wb' ist online" -ForegroundColor Green }
else { Write-Host "  [WARNUNG] Box '$Wb' ist OFFLINE" -ForegroundColor Red }

Write-Host "  Zustand: fsmState=$($box.fsmState), pay_required=$($box.pay_required), carConnected=$($box.carConnected)" -ForegroundColor Gray
if ($box.session) {
  Write-Host "  [WARNUNG] Es laeuft bereits eine Session ($($box.session.id)). Erst beenden!" -ForegroundColor Red
} else {
  Write-Host "  [OK] Keine laufende Session - Box ist frei" -ForegroundColor Green
}
if (-not $box.pay_required) {
  Write-Host "  [HINWEIS] pay_required=false -> Box ist im Gratis-Modus. Fuer Bezahl-Test im Admin umstellen." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Mitschnitt laeuft. Jetzt den Ladevorgang am Geraet starten." -ForegroundColor Cyan
Write-Host "Beenden mit STRG+C - danach wird die Quittung gezeigt." -ForegroundColor DarkGray
Write-Host ""

Add-Content -Path $logFile -Value "=== TEST-START $(Get-Date) Box=$Wb ==="

# ---------------- LIVE-MITSCHNITT ----------------
$prevState   = $box.fsmState
$prevPlugged = $box.carConnected
$prevHadSess = [bool]$box.session

try {
  while ($true) {
    $t = Get-Date -Format "HH:mm:ss"
    $s = Get-State
    if ($null -eq $s) {
      Write-Log "$t  [FEHLER] Backend nicht erreichbar" "Red"
      Start-Sleep -Seconds $Interval
      continue
    }
    $b = $s.wallboxen | Where-Object { $_.id -eq $Wb }

    # Volle JSON-Zeile immer in die Datei
    $raw = ($s | ConvertTo-Json -Depth 6 -Compress)
    Add-Content -Path $logFile -Value "$t  $raw"

    # --- Wichtige Ereignisse am Bildschirm hervorheben ---
    $fsm = $b.fsmState

    # Zustandswechsel
    if ($fsm -ne $prevState) {
      $col = switch ($fsm) {
        "REQUESTED"        { "Yellow" }
        "WAITING_FOR_CAR"  { "Magenta" }
        "CHARGING"         { "Green" }
        "STOPPING"         { "Yellow" }
        "IDLE"             { "Cyan" }
        default            { "White" }
      }
      Write-Host "$t  >>> ZUSTAND: $prevState -> $fsm" -ForegroundColor $col
      if ($fsm -eq "WAITING_FOR_CAR") { Write-Host "        (wartet auf Anstecken - Countdown laeuft)" -ForegroundColor Magenta }
      if ($fsm -eq "CHARGING")        { Write-Host "        (Auto angesteckt - Ladung startet)" -ForegroundColor Green }
      $prevState = $fsm
    }

    # Auto an-/abgesteckt
    if ($b.carConnected -ne $prevPlugged) {
      if ($b.carConnected) { Write-Host "$t  >>> AUTO ANGESTECKT" -ForegroundColor Green }
      else                 { Write-Host "$t  >>> AUTO ABGESTECKT" -ForegroundColor Yellow }
      $prevPlugged = $b.carConnected
    }

    # Session-Ende erkennen
    $hasSess = [bool]$b.session
    if ($prevHadSess -and -not $hasSess) {
      Write-Host "$t  >>> SESSION BEENDET" -ForegroundColor Cyan
    }
    $prevHadSess = $hasSess

    # Laufende Energie/Betrag (wenn Session aktiv)
    if ($b.session) {
      $kwh = [double]$b.session.energyKwh
      $amt = [double]$b.session.amount
      $pw  = [double]$b.power
      $line = "$t  laden: {0:N3} kWh | {1:N2} EUR | {2:N0} W" -f $kwh, $amt, $pw
      if ($kwh -gt 0) { Write-Host $line -ForegroundColor White }
      else            { Write-Host "$t  laden: noch 0 kWh (wartet auf Stromfluss)" -ForegroundColor DarkGray }
    }

    Start-Sleep -Seconds $Interval
  }
}
finally {
  # ---------------- QUITTUNG AUS DB ----------------
  Write-Host ""
  Write-Host "==================================================" -ForegroundColor Cyan
  Write-Host "  Mitschnitt beendet. Letzte Quittung aus der DB:" -ForegroundColor Cyan
  Write-Host "==================================================" -ForegroundColor Cyan
  Add-Content -Path $logFile -Value "=== TEST-ENDE $(Get-Date) ==="

  Push-Location $Project
  $node = @'
import Database from "better-sqlite3";
const db = new Database("sessions.db", { readonly: true });
function table(name){ try { return db.prepare(`SELECT * FROM ${name} ORDER BY rowid DESC LIMIT 1`).get(); } catch { return null; } }
const inv = table("invoices");
const ses = (()=>{ try { return db.prepare("SELECT * FROM sessions ORDER BY rowid DESC LIMIT 1").get(); } catch { return null; } })();
console.log("\n--- Letzte Rechnung (invoices) ---");
if (inv) {
  for (const k of ["invoice_no","wallbox_name","guest_name","guest_email","energy_kwh","price_per_kwh","amount","captured","currency","created_at"]) {
    if (inv[k] !== undefined) console.log("  " + k.padEnd(16) + ": " + inv[k]);
  }
} else { console.log("  (keine Rechnung gefunden - evtl. unter Mindestbetrag storniert)"); }
console.log("\n--- Letzte Session (sessions) ---");
if (ses) {
  for (const k of ["id","status","mode","energy_kwh","amount","captured","guest_email","ended_at","note"]) {
    if (ses[k] !== undefined) console.log("  " + k.padEnd(16) + ": " + ses[k]);
  }
} else { console.log("  (keine Session gefunden)"); }
db.close();
'@
  $node | node --input-type=module
  Pop-Location

  Write-Host ""
  Write-Host "Volles Protokoll: $logFile" -ForegroundColor DarkGray
  Write-Host ""
}
