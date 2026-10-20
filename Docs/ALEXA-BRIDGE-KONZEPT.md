# Alexa-Sprachsteuerung Wallboxen Neukirchen – Konzept & Lösung

**Stand:** 20.10.2026 · **Version 2.0.3:** Steuerung über das Wallbox-Backend (kein direktes Modbus mehr)

## Ziel

Alexa startet und stoppt Ladungen an der **Keba P30X** und ändert den Ladestrom. Von der Gäste-Wallbox **Keba P30C** meldet sie nur den Status. Jede Alexa-Ladung läuft als Admin-Gratis-Session über das Wallbox-Backend und erscheint im Verlauf.

## Warum über das Backend (Änderung gegenüber Version 1)

Version 1 schrieb direkt per Modbus auf die P30X (Register 5014/5004). Das kollidiert mit dem Backend:

- Das Backend behandelt **beide** Boxen als Gäste-Boxen. Ist für die P30X „Bezahlung“ an, erneuert es die **Default-Sperre bei jedem Poll** – ein Alexa-„Ein“ würde sofort überstimmt.
- Direkte Modbus-Befehle laufen **an der Session-Dokumentation vorbei**.
- Das Backend begrenzt die P30X auf **16 A** (`maxCurrentA` in `config.js`), Version 1 erlaubte 32 A.

Version 2 nutzt deshalb nur die Admin-API des Backends. Es gibt genau eine Stelle, die die Keba steuert.

## Architektur

```
Echo/Alexa ─► Sinric Pro (Cloud) ◄─ WebSocket (ausgehend) ─ Alexa-Bridge ─ HTTP (lokal) ─► Wallbox-Backend ─ Modbus ─► Keba P30X / P30C
                                                            PC Neukirchen                  PC Neukirchen, Port 8080
```

## Befehle und was im Backend passiert

| Sprachbefehl | Backend-Aufruf |
| --- | --- |
| „Alexa, schalte Auto-Laden ein“ | `POST /api/wallbox/p30x/start` (Admin-Gratis-Session). Das Backend geht in „Warten auf Auto“ und antwortet 400 „Nicht im Ladezustand.“ – die Bridge prüft dann, ob die Session existiert, und wertet das als Erfolg. Läuft schon eine Session: nichts. |
| „Alexa, schalte Auto-Laden aus“ | `POST /api/wallbox/p30x/stop`. Keine Session aktiv: nichts. |
| „Alexa, stelle Auto-Laden auf 50 Prozent“ | Lädt gerade: `POST /api/wallbox/p30x/current` (8 A); ohne diesen Endpunkt Stopp + Neustart. Wartet auf Auto: Wert vormerken, die Bridge setzt ihn (alle 30 s geprüft), sobald geladen wird – nur mit `/current`-Endpunkt, sonst lädt das Backend mit seinem Maximum. Keine Session: Wert merken für den nächsten Start. |
| „Alexa, ist die Gäste-Wallbox an?“ | `GET /api/state` – an = Leistung ≥ 100 W |
| „Alexa, schalte Gäste-Wallbox ein“ | **abgelehnt**, die Bridge hat für die P30C keine Schreibfunktion |

Umrechnung: A = max(6, round(Prozent × MAX_AMPS / 100)), MAX_AMPS = 16 (wie Backend).

Anmeldung: `POST /api/login` mit Admin-Benutzer aus `.env`. Token gilt 8 h, bei 401 meldet sich die Bridge automatisch neu an.

## Dateien

| Datei | Zweck |
| --- | --- |
| `index.js` | Start als Dienst, liest `.env`; `--test` prüft Login und Status |
| `alexa-bridge.js` | Sinric-Pro-Geräte und Befehlslogik |
| `backend-wallbox.js` | Client für die Backend-API, Adapter P30X (steuerbar) und P30C (nur lesen) |
| `selftest.js` | Test gegen ein simuliertes Backend (ohne Hardware) |
| `BACKEND-ERWEITERUNG.md` | optionaler Endpunkt `/current` für Stromänderung ohne Neustart der Session |
| `package.json` | Abhängigkeit: `sinricpro` ^6.1, Node ≥ 18 |
| `.env.example` | Vorlage für Zugangsdaten und Einstellungen |

## Installierter Stand

| Punkt | Wert |
| --- | --- |
| Ort | PC Neukirchen, `C:\Users\ulibe\Alexa-Bridge\` |
| Dienst | NSSM-Dienst `alexa-bridge`, Starttyp automatisch |
| NSSM | `C:\Users\ulibe\AppData\Local\Microsoft\WinGet\Links\nssm.exe` (wie `WallboxBackend`, `SmartfoxFronius`, `SmartfoxTuya`, `CloudflaredTunnel`) |
| Node.js | `C:\Program Files\nodejs\node.exe` |
| Log | `C:\Users\ulibe\Alexa-Bridge\bridge.log` |
| Zugangsdaten | `C:\Users\ulibe\Alexa-Bridge\.env` (nicht in der Doku) |
| Sinric-Gerät „Auto-Laden“ | Switch with Dimming, ID `6ad71d4fc0d54e0b9e8b480c`, Raum Carport |
| Sinric-Gerät „Gäste-Wallbox“ | Switch, ID `6ad71dd6c0d54e0b9e8b48cd`, Raum Carport |
| Sinric-Einstellungen | Benachrichtigung „Verbindung trennt“ an; Timer aus; „Gerätezustand wiederherstellen“ **aus** |
| Alexa | Skill „Sinric Pro“ verknüpft, beide Geräte als **Ladestation** (nicht Licht) |
| Backend-Repo | [UliBer1508/wallbox-backend](https://github.com/UliBer1508/wallbox-backend) |

Version 1 (direktes Modbus) wurde am 20.10.2026 erfolgreich getestet und anschließend durch Version 2 ersetzt.

## Umstellung von Version 1 auf Version 2

Auf dem PC in Neukirchen (Admin-PowerShell):

```powershell
net stop alexa-bridge
cd C:\Users\ulibe\Alexa-Bridge
# neue Dateien einspielen: index.js, alexa-bridge.js, backend-wallbox.js, selftest.js, package.json, .env.example
Remove-Item .\keba-modbus.js
Remove-Item .\node_modules -Recurse -Force
Remove-Item .\package-lock.json
npm install
npm run selftest
notepad .env      # BACKEND_URL, BACKEND_USER, BACKEND_PASSWORD, WALLBOX_PRIVAT, WALLBOX_GAESTE, MAX_AMPS ergänzen
npm run test-backend
net start alexa-bridge
```

## Nützliche Befehle

```powershell
net stop alexa-bridge
net start alexa-bridge
Get-Content C:\Users\ulibe\Alexa-Bridge\bridge.log -Tail 20
```

## Sicherheit

- Gäste-Wallbox: Bridge hat keine Schreibfunktion; Freigabe nur über Stripe im Backend.
- Bridge spricht das Backend nur lokal an (`127.0.0.1`), keine eingehende Verbindung, kein Tunnel.
- Admin-Passwort des Backends, Sinric App Key/Secret nur in `.env`.
- Kein Echo mit Zugriff auf „Auto-Laden“ in Gästeeinheiten.

## Offene Punkte

- [x] Version 2 eingespielt, `test-backend` mit Login OK (20.10.2026).
- [x] 2.0.1: Start mit „Warten auf Auto“ (Antwort 400) wird als Erfolg erkannt.
- [x] 2.0.2: Bridge richtet sich nach dem Zustand der Box (REQUESTED/WAITING_FOR_CAR/CHARGING/STOPPING = bereits gestartet) – kein Doppelstart. „Ein“ getestet.
- [ ] 2.0.3 einspielen: „Aus“ meldet keinen Fehler mehr, wenn die Box ohne Session wartet (lädt nicht). Danach „ein/aus“ mit **angestecktem Auto** testen.
- [ ] **Backend-Bug Session-Aufräumer:** `runSessionCleanup` (server.js) schließt eine aktive Session schon nach 2 Min ohne Auto (`CLEANUP_UNPLUG_GRACE_MS`), der Manager wartet aber bis 10 Min in WAITING_FOR_CAR (`waitForCarMinutes`). Danach wartet die Box ohne Session und lässt sich über `/stop` nicht beenden. Lösung: Sessions im Zustand WAITING_FOR_CAR vom Aufräumer ausnehmen oder beim Aufräumen auch den Manager zurücksetzen.
- [ ] Backend: Start-Endpunkt so anpassen, dass er nicht mehr 400 meldet (siehe `BACKEND-ERWEITERUNG.md`).
- [ ] Admin-Passwort des Wallbox Managers ändern (war in einem Screenshot sichtbar) und in `.env` nachziehen.
- [ ] **Backend-Bug Warte-Timeout:** Am 20.10.2026 blieb die P30X von 10:47 bis nach 11:04 in WAITING_FOR_CAR, obwohl `waitForCarMinutes` 10 Min sein sollte (Bezahlung AUS an der P30X). Wallbox Manager zeigte dabei „BEREIT“ (Hardware-Zustand). Abhilfe bis zur Korrektur: `net stop WallboxBackend` / `net start WallboxBackend`.
- [ ] Optional: Endpunkt `/current` laut `BACKEND-ERWEITERUNG.md` einbauen.
- [x] `MAX_AMPS=16` passt: Backend auf dem PC ist identisch mit GitHub (`git status` am 20.10.2026), `maxCurrentA` der P30X = 16 A.
- [ ] Sinric App Secret neu erzeugen (war vollständig in einem Screenshot sichtbar), in `.env` ersetzen, Bridge neu starten.
- [ ] Repository `wallbox-backend` auf privat stellen (öffentlich ein Abrechnungs-Backend).
- [ ] Bridge als Ordner `alexa-bridge/` ins Repo `wallbox-backend` committen (ohne `.env`, `node_modules`, `bridge.log`).

## Ausbaustufen

| Stufe | Alexa steuert | Voraussetzung |
| --- | --- | --- |
| 2 (jetzt) | P30X über Backend-Sessions, P30C Status | diese Bridge |
| 3 | gesprochene Antworten, z. B. Ladeleistung in kW | eigener Alexa-Skill statt Sinric Pro |

Die Wallboxen in Neukirchen werden ausschließlich vom Wallbox-Backend gesteuert; evcc spielt hier keine Rolle.
