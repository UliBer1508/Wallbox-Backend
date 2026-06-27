# ============================================================
#  Wallbox-Backend — Setup-Script (PowerShell)
#  Richtet das System auf einem Windows-PC ein.
#
#  AUSFÜHREN:
#    1. Rechtsklick auf diese Datei -> "Mit PowerShell ausführen"
#       ODER in PowerShell:  .\setup.ps1
#    2. Falls eine Sicherheitswarnung kommt, einmalig in einer
#       PowerShell (als Admin) ausführen:
#         Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
#
#  Was dieses Script TUT (automatisch):
#    - prüft/installiert Node.js (via winget)
#    - installiert alle npm-Module (express, better-sqlite3, stripe, ...)
#    - legt eine .env aus der Vorlage an (falls noch keine da ist)
#    - prüft die Ordnerstruktur
#
#  Was dieses Script NICHT tut (musst du selbst machen — Checkliste am Ende):
#    - echte Stripe-Keys eintragen (.env)
#    - cloudflared / NSSM herunterladen und einrichten
#    - eCarUp von der P30X trennen, SmartFox freigeben (vor Ort)
# ============================================================

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
Set-Location $ProjectRoot

function Write-Step($msg)  { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "  [X]  $msg" -ForegroundColor Red }

Write-Host @"

  ============================================
   WALLBOX-BACKEND  -  Einrichtung
  ============================================
"@ -ForegroundColor White

# ----------------------------------------------------------------
# 1. Node.js prüfen / installieren
# ----------------------------------------------------------------
Write-Step "1. Node.js"

$nodeOk = $false
try {
  $nodeVer = node --version 2>$null
  if ($nodeVer) {
    Write-Ok "Node.js gefunden: $nodeVer"
    # Mindestversion 18 empfohlen (better-sqlite3, node:test)
    $major = [int]($nodeVer.TrimStart('v').Split('.')[0])
    if ($major -lt 18) {
      Write-Warn2 "Node.js $nodeVer ist alt. Empfohlen: v18 oder neuer."
    }
    $nodeOk = $true
  }
} catch { $nodeOk = $false }

if (-not $nodeOk) {
  Write-Warn2 "Node.js ist nicht installiert."
  $answer = Read-Host "  Node.js jetzt automatisch installieren (via winget)? [J/N]"
  if ($answer -match '^[JjYy]') {
    try {
      Write-Host "  Installiere Node.js LTS ..." -ForegroundColor Gray
      winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
      Write-Ok "Node.js installiert. WICHTIG: PowerShell-Fenster schließen und neu öffnen,"
      Write-Ok "dann dieses Script erneut starten (damit 'node' im Pfad ist)."
      Read-Host "  Enter zum Beenden"
      exit 0
    } catch {
      Write-Err "winget-Installation fehlgeschlagen: $_"
      Write-Err "Bitte Node.js manuell installieren: https://nodejs.org (LTS-Version)"
      Read-Host "  Enter zum Beenden"
      exit 1
    }
  } else {
    Write-Err "Ohne Node.js kann das System nicht laufen."
    Write-Err "Manuell installieren: https://nodejs.org (LTS-Version)"
    Read-Host "  Enter zum Beenden"
    exit 1
  }
}

# npm prüfen
try {
  $npmVer = npm --version 2>$null
  Write-Ok "npm gefunden: $npmVer"
} catch {
  Write-Err "npm nicht gefunden (sollte mit Node.js kommen). Node.js neu installieren."
  Read-Host "  Enter zum Beenden"
  exit 1
}

# ----------------------------------------------------------------
# 2. Ordnerstruktur prüfen
# ----------------------------------------------------------------
Write-Step "2. Ordnerstruktur"

$needed = @('src', 'public')
foreach ($d in $needed) {
  if (Test-Path (Join-Path $ProjectRoot $d)) {
    Write-Ok "$d/ vorhanden"
  } else {
    Write-Err "$d/ fehlt! Ist die ZIP vollständig entpackt?"
    Read-Host "  Enter zum Beenden"
    exit 1
  }
}

# Schlüsseldateien prüfen
$keyFiles = @('src\server.js', 'src\db.js', 'src\stripe.js', 'src\keba.js',
              'src\manager.js', 'src\facade.js', 'src\config.js',
              'public\index.html', 'public\guest.html', 'package.json')
$allThere = $true
foreach ($f in $keyFiles) {
  if (-not (Test-Path (Join-Path $ProjectRoot $f))) {
    Write-Err "$f fehlt"
    $allThere = $false
  }
}
if ($allThere) { Write-Ok "Alle Kerndateien vorhanden" }
else {
  Write-Err "Es fehlen Dateien. ZIP erneut entpacken."
  Read-Host "  Enter zum Beenden"
  exit 1
}

# ----------------------------------------------------------------
# 3. npm-Module installieren
# ----------------------------------------------------------------
Write-Step "3. npm-Module installieren"
Write-Host "  Das kann beim ersten Mal einige Minuten dauern" -ForegroundColor Gray
Write-Host "  (better-sqlite3 wird kompiliert)..." -ForegroundColor Gray
try {
  npm install
  Write-Ok "Alle Module installiert"
} catch {
  Write-Err "npm install fehlgeschlagen: $_"
  Write-Warn2 "Häufige Ursache: Build-Tools für better-sqlite3 fehlen."
  Write-Warn2 "Falls Fehler bei better-sqlite3: 'npm install --build-from-source' versuchen,"
  Write-Warn2 "oder die Visual C++ Build Tools installieren."
  Read-Host "  Enter zum Beenden"
  exit 1
}

# ----------------------------------------------------------------
# 4. .env anlegen
# ----------------------------------------------------------------
Write-Step "4. Konfiguration (.env)"

$envPath = Join-Path $ProjectRoot '.env'
$envExample = Join-Path $ProjectRoot '.env.example'

if (Test-Path $envPath) {
  Write-Ok ".env existiert bereits — wird NICHT überschrieben"
} elseif (Test-Path $envExample) {
  Copy-Item $envExample $envPath
  Write-Ok ".env aus Vorlage erstellt"
  Write-Warn2 "WICHTIG: .env öffnen und echte Werte eintragen (Stripe-Keys, Passwörter)!"
} else {
  Write-Warn2 ".env.example fehlt — .env muss manuell angelegt werden."
}

# ----------------------------------------------------------------
# 5. Schnelltest (optional)
# ----------------------------------------------------------------
Write-Step "5. Schnelltest"
$answer = Read-Host "  Automatische Tests jetzt ausführen? [J/N]"
if ($answer -match '^[JjYy]') {
  try {
    npm test
    Write-Ok "Tests durchgelaufen"
  } catch {
    Write-Warn2 "Einige Tests sind fehlgeschlagen — Ausgabe oben prüfen."
  }
}

# ----------------------------------------------------------------
# Abschluss + Checkliste
# ----------------------------------------------------------------
Write-Host @"

  ============================================
   EINRICHTUNG ABGESCHLOSSEN
  ============================================
"@ -ForegroundColor Green

Write-Host @"

  NOCH MANUELL ZU ERLEDIGEN:
  --------------------------
  [ ] 1. .env öffnen und echte Werte eintragen:
         - STRIPE_SECRET_KEY  (echter Stripe-Schlüssel)
         - ADMIN_PASSWORD     (sicheres Admin-Passwort)
         - UPLOAD_PASSWORD    (für Datei-Upload)

  [ ] 2. Cloudflare-Tunnel (cloudflared.exe) einrichten
         -> siehe WALLBOX-ANLEITUNGEN.md, Abschnitt "Cloudflare Tunnel"

  [ ] 3. Autostart als Dienst (NSSM) einrichten
         -> siehe WALLBOX-ANLEITUNGEN.md, Abschnitt "NSSM Autostart"

  [ ] 4. VOR ORT an der Anlage:
         - eCarUp von der P30X trennen (OCPP-Konflikt vermeiden)
         - SmartFox-Freigabe für die P30X
         - Modbus-Schreibregister verifizieren ([PRUEFEN@PC] in keba.js)

  SYSTEM JETZT STARTEN (zum Testen):
  ----------------------------------
    npm start

    Dann im Browser:
      Admin:  http://localhost:8080/
      Gäste:  http://localhost:8080/guest?wb=p30c

"@ -ForegroundColor White

Read-Host "  Enter zum Beenden"
