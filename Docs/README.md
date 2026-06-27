# Wallbox-Backend (Keba P30)

Node.js-Backend zur Steuerung der Keba P30 Wallboxen über Modbus TCP.
Architektur an evcc angelehnt, Keba-Steuerung selbst implementiert.

## Installation

```cmd
cd C:\Users\ulibe\wallbox-backend
npm install
```

## Starten (Test)

```cmd
npm start
```

Backend läuft dann auf http://localhost:8080

## REST-API

| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET  | /api/state | Status aller Wallboxen |
| GET  | /api/wallbox/1 | Status einer Wallbox |
| POST | /api/wallbox/1/start | Laden starten (Body: {"current":16}) |
| POST | /api/wallbox/1/stop | Laden stoppen |
| POST | /api/wallbox/1/current | Strom ändern (Body: {"current":10}) |
| GET  | /api/health | Health-Check |

## Wallbox-IDs

- ID 1 = P30C Gäste (192.168.188.36)
- ID 2 = P30X Tesla (192.168.188.63)

## Als Windows-Dienst (Autostart)

Mit NSSM (Non-Sucking Service Manager):

1. NSSM herunterladen: https://nssm.cc/download
2. nssm.exe nach C:\Windows\System32 kopieren
3. Dienst einrichten:

```cmd
nssm install WallboxBackend "C:\Program Files\nodejs\node.exe" "C:\Users\ulibe\wallbox-backend\src\server.js"
nssm set WallboxBackend AppDirectory "C:\Users\ulibe\wallbox-backend"
nssm set WallboxBackend Start SERVICE_AUTO_START
nssm start WallboxBackend
```

Dienst stoppen / entfernen:
```cmd
nssm stop WallboxBackend
nssm remove WallboxBackend confirm
```

## Test mit curl

```cmd
curl http://localhost:8080/api/state
curl -X POST http://localhost:8080/api/wallbox/1/start -H "Content-Type: application/json" -d "{\"current\":16}"
curl -X POST http://localhost:8080/api/wallbox/1/stop
```

## Version 1.1 — Sessions & Abrechnung

Neue Features:
- SQLite-Datenbank (sessions.db) für alle Ladevorgänge
- Automatische kWh-Abrechnung (Preis in config.js: PRICE_PER_KWH)
- Session wird bei "Laden starten" angelegt, bei "Stoppen" mit Betrag abgeschlossen
- Lade-Verlauf im Admin-UI

Neue API-Endpunkte:
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET  | /api/sessions | Alle Ladevorgänge |
| GET  | /api/sessions/:id | Einzelne Session |
| POST | /api/sessions/:id/paid | Als bezahlt markieren |

Start/Stop akzeptieren jetzt optional Gast-Daten:
POST /api/wallbox/1/start  { "current":16, "guestName":"Max", "guestEmail":"max@example.com" }

WICHTIG: better-sqlite3 muss kompiliert werden. Falls npm install Fehler bringt,
Visual Studio Build Tools installieren oder: npm install --build-from-source

## Gäste-Interface

Mobiloptimierte Lade-Seite für Gäste:
- http://localhost:8080/guest?wb=1  (P30C Gäste)
- http://localhost:8080/guest?wb=2  (P30X Tesla)

Flow: Daten eingeben → Laden starten → Live-Anzeige (kWh + Betrag) → Beenden → Quittung → Bezahlen (Platzhalter)

Der QR-Code an der Wallbox zeigt später auf die externe URL (via Cloudflare Tunnel),
z.B. https://wallbox.steinbock-chalets.at/guest?wb=1
