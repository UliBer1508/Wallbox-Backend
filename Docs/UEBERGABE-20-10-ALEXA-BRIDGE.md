# Übergabe 20.10.2026 – Alexa-Bridge & Erkenntnisse zum Wallbox-Backend

> **Projekt:** Gäste-Ladesystem Steinbock Chalets, Neukirchen am Großvenediger
> **Bearbeitet:** 20. Oktober 2026 (aus München, Zugriff per Remote Desktop)
> **Zweck:** Was heute am Wallbox Manager / Wallbox-Backend gemacht und herausgefunden wurde.
> Details zur Alexa-Steuerung: `Docs/ALEXA-BRIDGE-KONZEPT.md`

---

## 1. Was heute gemacht wurde

| Schritt | Ergebnis |
| --- | --- |
| Alexa-Sprachsteuerung für die Wallboxen gebaut (Sinric Pro) | in Betrieb als NSSM-Dienst `alexa-bridge` |
| Version 1: direkte Modbus-Steuerung der P30X | funktionierte, aber an der Session-Dokumentation vorbei → verworfen |
| Version 2.0.3: Steuerung nur über die Admin-API des Backends | aktiv; Alexa-Ladungen erscheinen als Admin-Session „Gratis“ im Lade-Verlauf |
| Code ins Repo | Ordner `alexa-bridge/` (Commit c5dfba0) |
| Doku ins Repo | `Docs/ALEXA-BRIDGE-KONZEPT.md` (Commit bd78f2c) |
| Repo-Abgleich PC ↔ GitHub | `git status --short` leer: PC und GitHub identisch |

**Backend-Code wurde heute nicht verändert.**

## 2. Was die Bridge im Backend nutzt

| Endpunkt | Zweck |
| --- | --- |
| `POST /api/login` | Admin-Token (8 h gültig), Benutzer/Passwort in `C:\Users\ulibe\Alexa-Bridge\.env` |
| `GET /api/state` | Status beider Boxen |
| `POST /api/wallbox/p30x/start` | „Alexa, schalte Auto-Laden ein“ → Admin-Gratis-Session |
| `POST /api/wallbox/p30x/stop` | „Alexa, schalte Auto-Laden aus“ |
| `POST /api/wallbox/p30x/current` | optional, existiert noch nicht (siehe `alexa-bridge/BACKEND-ERWEITERUNG.md`) |

Die P30C (Gäste) wird nur gelesen, nie geschaltet.

## 3. Gefundene Fehler im Backend (noch offen)

### 3.1 Admin-Start meldet 400, obwohl er funktioniert
`POST /api/wallbox/:id/start` legt die Session an und geht in WAITING_FOR_CAR, ruft danach aber
`facade.setCurrent()` auf. Das ist nur in CHARGING erlaubt → „Nicht im Ladezustand.“ → HTTP 400.
Betrifft auch den Start-Button im Wallbox Manager.
**Fix:** in `src/server.js` im Start-Endpunkt `await facade.setCurrent(id, ampere).catch(() => {});`

### 3.2 Session-Aufräumer schließt zu früh
`runSessionCleanup` (`src/server.js`) beendet eine aktive Session nach **2 Min** ohne angestecktes Auto
(`CLEANUP_UNPLUG_GRACE_MS`). Der Manager wartet aber bis **10 Min** in WAITING_FOR_CAR (`waitForCarMinutes`).
Folge: Box wartet weiter, Backend kennt keine Session mehr, `/stop` liefert „Ungültige Session-ID: undefined“.
Betrifft auch Gäste, die nach dem Bezahlen länger als 2 Min zum Anstecken brauchen.
**Fix:** Sessions, deren Box in WAITING_FOR_CAR ist, vom Aufräumer ausnehmen – oder beim Aufräumen auch den Manager zurücksetzen.

### 3.3 Warte-Timeout gibt die Box nicht frei
Die P30X blieb von 10:47 bis nach 11:04 in WAITING_FOR_CAR (Soll: 10 Min). Der Wallbox Manager zeigte dabei
„BEREIT“ (Hardware-Zustand), intern war die Box weiter im Wartezustand. Bezahlung an der P30X war AUS.
Ursache noch nicht untersucht.
**Abhilfe bis zur Korrektur:** `net stop WallboxBackend` / `net start WallboxBackend`.

## 4. Bestätigte Fakten

- Register 1502 (Sitzungsenergie) zählt in **0,1 Wh** (wie in `src/keba.js`). Beispiel: Auto-Ladung 16.10. = 51,44 kWh.
- P30X: Bezahlung AUS (Gratis-Modus, `payRequired: false`), `maxCurrentA` = 16 A.
- P30C: Bezahlung AN.
- Beide Boxen per Modbus erreichbar: P30C 192.168.188.36, P30X 192.168.188.63.
- NSSM liegt unter `C:\Users\ulibe\AppData\Local\Microsoft\WinGet\Links\nssm.exe`
  (Dienste: WallboxBackend, alexa-bridge, SmartfoxFronius, SmartfoxTuya, CloudflaredTunnel).

## 5. Nicht im Repo – bewusst ausgeschlossen, aber sichern!

`git status --ignored --short` zeigt:

| Datei | Inhalt | Sichern |
| --- | --- | --- |
| `.env` | Stripe-Schlüssel, Admin-Passwort, Mail-Zugang | ja |
| `sessions.db`, `sessions.db-shm`, `sessions.db-wal` | gesamter Lade-Verlauf, Rechnungen, Einstellungen | **ja, wichtig** |
| `services.json` | lokale Dienst-Konfiguration | ja |
| `logs/`, `node_modules/` | Protokolle, Abhängigkeiten | nein |

Sicherung (Admin-PowerShell, nicht während einer Gast-Ladung):

```powershell
$ziel = "D:\Backup\Wallbox-Backend\$(Get-Date -Format yyyy-MM-dd)"
New-Item -ItemType Directory $ziel -Force | Out-Null
net stop WallboxBackend
Copy-Item C:\Users\ulibe\Wallbox-Backend\.env, C:\Users\ulibe\Wallbox-Backend\services.json, C:\Users\ulibe\Wallbox-Backend\sessions.db* $ziel
net start WallboxBackend
```

## 6. Sicherheit – heute offen gelegt, bitte erneuern

- [ ] Admin-Passwort des Wallbox Managers (war in einem Screenshot sichtbar) → ändern, in `Alexa-Bridge\.env` nachziehen
- [ ] Sinric Pro App Secret (vollständig in einem Screenshot sichtbar) → neu erzeugen, in `Alexa-Bridge\.env` eintragen
- [ ] Danach `net stop alexa-bridge` / `net start alexa-bridge`
- [ ] Repository `wallbox-backend` ist öffentlich → auf privat stellen

## 7. Nächste Schritte

- [ ] Backend-Fehler 3.1, 3.2, 3.3 beheben
- [ ] Optional: Endpunkt `/api/wallbox/:id/current` (Strom ändern ohne Session-Neustart)
- [ ] Test „Auto-Laden ein/aus“ innerhalb von 2 Min (nach Neustart WallboxBackend), später mit angestecktem Auto
- [ ] Regelmäßige Sicherung von `.env` und `sessions.db` einrichten
- [ ] Optional: `git config --global user.email` korrigieren (Commits zeigen Platzhalter-Adresse)
