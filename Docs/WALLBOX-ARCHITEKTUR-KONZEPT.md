# Wallbox-Daemon — Architektur- & Umsetzungskonzept

> **Projekt:** Eigenes Gäste-Ladesystem Steinbock Chalets
> **Stand:** 10. Juni 2026 — Planungssession (Hamburg)
> **Status:** Konzept zur Umsetzung in Österreich
> **Vorbild:** evcc-Architektur (Schichtentrennung), eigenständig in Node.js neu gebaut — KEIN evcc-Code, KEIN Sponsor-Token nötig

---

## 0. Zielbild in einem Satz

Ein eigenständiger, dauerlaufender **Wallbox-Daemon** auf dem Windows-PC, der nach unten die beiden Keba-Wallboxen steuert, in der Mitte die gesamte Prozesslogik samt Fehlerbehandlung kapselt und nach oben eine bezahl-neutrale Schnittstelle anbietet — auf die der Abrechnungslayer (Stripe) als reiner Konsument aufgesetzt wird. **Alle** Einstellungen (Hardware, Middle-Layer, Bezahlsystem) sind im Admin-Interface (`index.html`) pflegbar.

---

## 1. Leitprinzipien

1. **Strikte Schichtentrennung.** Jede Schicht kennt nur die Schicht direkt unter sich, niemals tiefer. Die UI redet nie direkt mit Modbus; der Abrechnungslayer redet nie direkt mit der Wallbox.
2. **Die obere Schnittstelle ist bezahl-neutral.** Sie kennt "laden", "Strom", "Energie", "Limit" — aber kein Stripe, keine PaymentIntents. Dadurch ist der Abrechnungslayer austauschbar (heute Stripe, morgen Rechnung/RFID).
3. **Hardware-Eigenheiten werden ganz unten gekapselt.** Port 502, Einzel-Reads, 32-bit BigEndian — nichts davon ist oberhalb der Treiber-Schicht sichtbar.
4. **Alles konfigurierbar im Admin.** Keine Einstellung lebt fest verdrahtet im Code. Hardware-Parameter, Logik-Parameter und Bezahl-Parameter sind alle über `index.html` les- und schreibbar (persistiert in SQLite).
5. **Robustheit vor Funktionsumfang.** Failsafe, Reconnect, Aufräumen hängender Sessions und sauberer Neustart haben Vorrang vor neuen Features.
6. **Refactoring statt Neubau.** `keba.js`, `manager.js`, `db.js`, Stripe-Logik existieren bereits. Das Konzept beschreibt, wie sie in saubere Schichten überführt und gehärtet werden.

---

## 2. Schichtenmodell (Überblick)

```
┌─────────────────────────────────────────────────────────────┐
│  SCHICHT 4 — UI                                              │
│  index.html (Admin)   guest.html (Gäste)                     │
│  Bedient REST-API. Alle Einstellungen pflegbar.              │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP / REST (Port 8080)
┌───────────────────────────┴─────────────────────────────────┐
│  SCHICHT 3 — ABRECHNUNGSLAYER (Konsument)                    │
│  Stripe-Vorautorisierung, Capture, Quittung, Preislogik       │
│  Nutzt NUR die Daemon-Fassade. Kennt keine Modbus-Register.  │
└───────────────────────────┬─────────────────────────────────┘
                            │ interne Fassade (Methoden + Events)
┌───────────────────────────┴─────────────────────────────────┐
│  SCHICHT 2 — PROZESSLOGIK / DAEMON-KERN                      │
│  Zustandsautomat, Polling, Fehlerbehandlung, Event-System    │
│  Aufgebohrter manager.js                                     │
└───────────────────────────┬─────────────────────────────────┘
                            │ primitive Treiber-Methoden
┌───────────────────────────┴─────────────────────────────────┐
│  SCHICHT 1 — GERÄTE-TREIBER (HAL)                            │
│  keba.js — kennt Modbus-Register, spricht nur "Keba"         │
│  Modbus TCP, Port 502, 32-bit BigEndian, Einzel-Reads        │
└───────────────────────────┬─────────────────────────────────┘
                            │ Modbus TCP
                  ┌──────────┴──────────┐
              P30C (Gäste)        P30X (Tesla)
            192.168.188.36      192.168.188.63
```

---

## 3. Schicht 1 — Geräte-Treiber (Hardware Abstraction Layer)

**Datei:** `src/keba.js`
**Aufgabe:** Eine Klasse `KebaCharger` pro Wallbox-Instanz. Kennt ausschließlich Hardware. Weiß nichts von Sessions, Preisen, Gästen.

### Primitive Methoden (nach oben angeboten)
| Methode | Zweck | Modbus |
|---------|-------|--------|
| `readChargingState()` | Ladezustand 0–5 | Reg 1000 (32-bit) |
| `readCableState()` | Kabel/Auto verbunden | Reg 1004 (Bit 2) |
| `readCurrents()` | Strom L1/L2/L3 (mA) | Reg 1008/1010/1012 |
| `readPower()` | Leistung (mW) | Reg 1020 |
| `readEnergyTotal()` | Energie gesamt (0.1 Wh) | Reg 1036 |
| `readEnergySession()` | Energie Session (0.1 Wh) | Reg 1502 |
| `readVoltages()` | Spannung L1/L2/L3 (V) | Reg 1040/1042/1044 |
| `writeCurrent(mA)` | Ladestrom setzen | Reg 5004 (16-bit) |
| `writeEnable(bool)` | Laden ein/aus | Reg 5014 (siehe Hinweis) |
| `writeFailsafe(timeout, fallback)` | Watchdog der Box | Reg 5018/5016 |
| `connect()` / `disconnect()` | Modbus-Verbindung | — |
| `isConnected()` | Verbindungsstatus | — |

> **Hinweis enable/Register:** Die genauen Schreib-Register (5004, 5014, 5050 Phasen, Failsafe-Register) sind beim nächsten Mal am PC gegen `keba.js` und die Keba-Modbus-Doku zu verifizieren. Die hier gelisteten Lese-Register sind bereits hart verifiziert (siehe WALLBOX-PROJEKT.md).

### Eigenschaften, die hier gekapselt bleiben
- Port **502** (nicht 1502), Unit-ID **255**
- Alle Messwerte **32-bit = 2 Register, BigEndian**, **einzeln** lesen
- Reconnect-Mechanik (siehe Schicht 2 ruft `connect()` erneut)
- Pro Wallbox-Typ ggf. Abweichungen (P30C vs. P30X) hier isolieren

---

## 4. Schicht 2 — Prozesslogik (Daemon-Kern)

**Datei:** `src/manager.js` (aufgebohrt)
**Aufgabe:** Das Herzstück. Verwaltet beide Wallboxen, hält den Zustand, behandelt alle Fehler, feuert Events nach oben.

### 4.1 Zustandsautomat (pro Wallbox)

```
   IDLE
    │  requestCharge()
    ▼
 REQUESTED ──(Zahlung/Freigabe ausgeblieben, Timeout)──► IDLE
    │  startCharge()
    ▼
 CHARGING ──(limitReached | stopCharge | Kabel gezogen)──► STOPPING
    │
    ▼
 STOPPING ──(Capture/Abschluss erledigt)──► IDLE
    │
    └──(Fehler)──► ERROR ──(Reset/Aufräumen)──► IDLE
```

- Jeder Übergang ist explizit definiert; ungültige Übergänge werden abgewiesen und geloggt.
- Der Zustand wird **persistiert** (SQLite), damit ein Daemon-Neustart ihn rekonstruieren kann.

### 4.2 Polling
- **Adaptiv:** im Leerlauf langsam (z.B. 10 s), bei aktiver Ladung schnell (z.B. 2–4 s). Beide Intervalle als Einstellung im Admin.
- Liest pro Zyklus den relevanten Zustand jeder Box über Schicht 1 und aktualisiert den In-Memory-State.
- Vergleicht neuen mit altem Zustand → bei Änderung Event feuern.

### 4.3 Fehlerbehandlung (das Kernstück der "Middle Layer")
| Mechanismus | Beschreibung | Einstellung im Admin |
|-------------|--------------|----------------------|
| **Modbus-Reconnect** | Bricht die Verbindung weg, automatisch neu verbinden statt Prozess sterben lassen. Exponentielles Backoff. | Reconnect-Versuche, Backoff-Basis |
| **Failsafe-Watchdog** | Keba-eigenes Failsafe-Register setzen: Box stoppt selbsttätig, wenn der Daemon verstummt. Schutz bei Backend-Absturz. | Failsafe-Timeout (s), Fallback-Strom |
| **Hängende Sessions** | Gast schließt Seite ohne "Beenden" → Timeout-basiertes Auto-Cancel/Abschluss. | Session-Timeout (min) |
| **Neustart während Ladung** | Beim Start prüfen: lief eine Session? Zustand aus DB + Live-Hardware rekonstruieren, nicht doppelt starten. | — |
| **Stripe-Abbruch** | Verwaiste REQUESTED-Sessions (Zahlung nie abgeschlossen) aufräumen. | Auth-Timeout (min) |
| **Modbus-Konflikt eCarUp** | Erkennen, wenn Steuerbefehle nicht greifen (Box reagiert nicht wie erwartet) → Event `errorOccurred`, Admin-Warnung. | — |

### 4.4 Event-System (nach oben)
Der Daemon feuert Ereignisse, der Abrechnungslayer hört zu (statt selbst zu pollen):
- `chargingStarted(wallboxId, sessionId)`
- `energyUpdated(wallboxId, sessionId, kWh, betrag)`
- `limitReached(wallboxId, sessionId)` → Abrechnungslayer löst Capture aus
- `chargingStopped(wallboxId, sessionId, finalKWh)`
- `cableDisconnected(wallboxId, sessionId)`
- `errorOccurred(wallboxId, code, details)`
- `connectionLost(wallboxId)` / `connectionRestored(wallboxId)`

---

## 5. Schicht 3 — Obere Schnittstelle (Daemon-Fassade)

**Der Vertrag zwischen Daemon und Abrechnungslayer.** Bezahl-neutral.

### Befehle (Abrechnungslayer → Daemon)
| Methode | Zweck |
|---------|-------|
| `getState(wallboxId)` | Aktueller Zustand einer Box (Zustand, Strom, Energie, verbunden) |
| `getAllState()` | Zustand beider Boxen + laufende Sessions |
| `requestCharge(wallboxId, {modus, limit})` | Ladevorgang vormerken (modus: "voll" \| "limit"; limit in kWh oder €-Äquivalent) |
| `startCharge(wallboxId, sessionId)` | Tatsächlich Laden starten (nach Freigabe durch Abrechnungslayer) |
| `stopCharge(wallboxId, sessionId)` | Laden beenden |
| `setCurrent(wallboxId, ampere)` | Ladestrom anpassen |
| `cancelRequest(wallboxId, sessionId)` | Vormerkung verwerfen |

### Events (Daemon → Abrechnungslayer)
Siehe 4.4. Der Abrechnungslayer registriert Callbacks und reagiert (z.B. `limitReached` → Stripe-Capture).

### Implementierungs-Variante
- **Variante A (Empfehlung):** Daemon + Abrechnungslayer im selben Node-Prozess, Fassade als importiertes Objekt. Schnell, robust, ein Dienst.
- **Variante B (später optional):** Daemon als eigener Dienst mit lokaler HTTP/WS-API (z.B. `localhost:9000`), Abrechnungslayer als zweiter Dienst. Erst nötig, wenn die Layer unabhängig deploybar sein sollen.
- **Disziplin:** Auch in Variante A die Fassade so sauber halten, als wäre es Variante B → späterer Umstieg trivial.

---

## 6. Schicht 3b — Abrechnungslayer (Konsument)

**Dateien:** `src/stripe.js` + Teile von `src/server.js`
**Aufgabe:** Bezahllogik. Nutzt NUR die Fassade aus Schicht 3.

- Stripe-Vorautorisierung (capture_method: manual)
- Partial Capture (nur echte kWh abbuchen, Rest freigeben)
- Bei Betrag < 0,50 €: Auth komplett canceln
- Preisberechnung (Preis/kWh × verbrauchte kWh)
- Quittung / spätere E-Mail (Resend o.ä.)
- Reagiert auf `limitReached`, `chargingStopped` etc.

**Wichtig:** Dieser Layer kennt keine Modbus-Register. Wenn er wissen will, wie viel geladen wurde, fragt er `getState()` oder hört auf `energyUpdated`.

---

## 7. Schicht 4 — UI & ZENTRALE EINSTELLUNGEN

**Dateien:** `public/index.html` (Admin), `public/guest.html` (Gäste)

### Grundsatz (ausdrücklicher Wunsch)
> **ALLE Einstellungen — Hardware, Middle-Layer, Bezahlsystem — sind im Admin (`index.html`) verfügbar und änderbar.** Persistenz in SQLite (`settings`-Tabelle). Keine Einstellung lebt fest im Code.

### Einstellungs-Katalog im Admin (gruppiert)

**Gruppe A — Hardware (pro Wallbox)**
- IP-Adresse, Modbus-Port (Default 502), Unit-ID (Default 255)
- Wallbox aktiv/inaktiv (z.B. P30X vorerst nur lesen)
- Min-Strom (A), Max-Strom (A)
- Failsafe-Timeout (s), Failsafe-Fallback-Strom (A)
- (optional später) Phasenumschaltung 1P/3P

**Gruppe B — Middle-Layer / Prozesslogik**
- Polling-Intervall Leerlauf (s)
- Polling-Intervall aktiv (s)
- Session-Timeout für hängende Sessions (min)
- Auth-Timeout für unbezahlte Vormerkungen (min)
- Reconnect-Versuche, Backoff-Basis (s)

**Gruppe C — Bezahlsystem**
- Preis pro kWh (€)
- Reservierungsbetrag "Voll laden" (€)
- Währung (EUR)
- Stripe-Modus (Test / Live) — *nur Umschaltung, Keys über .env, nie in DB/UI im Klartext*
- Mindestbetrag für Capture (€, Default 0,50)
- (später) Absender/Resend-Konfig für Quittungs-Mail

**Gruppe D — System/Anzeige**
- Status beider Wallboxen (live)
- Lade-Verlauf / Sessions
- Verbindungsstatus, letzte Fehler
- Manuelle Steuerung (Admin: starten/stoppen)

### Sicherheits-Hinweis zu Einstellungen
- **Secrets (Stripe Secret Key, Tunnel-Credentials) gehören NIEMALS in die DB oder ins Admin-UI im Klartext.** Sie bleiben in `.env`. Im Admin nur: Test/Live-Umschaltung und Anzeige "Key gesetzt: ja/nein".
- Admin-UI braucht Passwortschutz, da extern über Cloudflare-Tunnel erreichbar (siehe offene Aufgabe `/api/login`).

### Benötigte API-Endpunkte für Einstellungen
| Methode | Endpunkt | Zweck |
|---------|----------|-------|
| GET | `/api/settings` | Alle Einstellungen (ohne Secrets) lesen |
| POST | `/api/settings` | Einstellungen ändern (validiert!) |
| GET | `/api/state` | Live-Status beider Boxen |
| POST | `/api/login` | Admin-Login (noch offen) |

> **Validierung Pflicht:** Bei `POST /api/settings` jeden Wert prüfen (z.B. Max-Strom 6–32 A, Intervalle > 0). Ungültige Hardware-Werte können die Box stören.

---

## 8. Dateistruktur (Zielbild)

```
Wallbox-Backend/
  .env                       ← Secrets (NIE in Git)
  package.json
  src/
    config.js                ← Defaults (werden von DB-Settings überschrieben)
    keba.js                  ← SCHICHT 1: Treiber (Klasse KebaCharger)
    manager.js               ← SCHICHT 2: Daemon-Kern (Zustandsautomat, Polling, Fehler)
    facade.js                ← SCHICHT 3: obere Schnittstelle (NEU — sauberer Vertrag)
    stripe.js                ← SCHICHT 3b: Abrechnungslayer
    db.js                    ← SQLite (sessions + settings + persistierter Zustand)
    server.js                ← REST-API + UI-Auslieferung + Login/Upload
  public/
    index.html               ← Admin (alle Einstellungen A–D)
    guest.html               ← Gäste-Seite
  sessions.db                ← SQLite (NICHT in Git)
```

**Neu gegenüber heute:** `facade.js` als expliziter Schnittstellen-Layer. Der Rest ist Refactoring + Härtung bestehender Dateien.

---

## 9. Umsetzungs-Reihenfolge (Roadmap)

### Phase 0 — Voraussetzungen (am PC, sowieso fällig)
- [ ] Backend als Windows-Dienst via **NSSM** (Autostart, Neustart bei Absturz) — wie evcc.exe als Dienst
- [ ] Falsche Domain `steinbocchalets-charge.com` löschen
- [ ] Stripe-Live-Key-Status prüfen

### Phase 1 — Schichten sauber ziehen (Refactoring)
- [ ] `keba.js` zur reinen HAL-Klasse kapseln (nur primitive Methoden)
- [ ] `facade.js` anlegen — den bezahl-neutralen Vertrag aus Abschnitt 5 implementieren
- [ ] `server.js` & `stripe.js` so umbauen, dass sie NUR über `facade.js` mit der Hardware reden

### Phase 2 — Prozesslogik härten (Middle Layer)
- [ ] Zustandsautomat in `manager.js` formalisieren
- [ ] Event-System einziehen (Abschnitt 4.4)
- [ ] Fehlerbehandlung: Reconnect, Failsafe-Watchdog, hängende Sessions, Neustart-Recovery (Abschnitt 4.3)

### Phase 3 — Einstellungen zentralisieren
- [ ] `settings`-Tabelle um alle Parameter A–D erweitern
- [ ] `/api/settings` GET/POST mit Validierung
- [ ] Admin-UI `index.html`: Einstellungs-Gruppen A–D als Formulare
- [ ] `/api/login` implementieren (Admin-Passwortschutz)

### Phase 4 — Echter Lade-Test
- [ ] eCarUp an P30C kurz pausieren
- [ ] Auto anstecken, `setCurrent` + `enable` mit echtem Stromfluss verifizieren
- [ ] kWh-Zählung über Zeit prüfen
- [ ] Failsafe testen (Daemon hart beenden → stoppt Box?)

### Phase 5 — Feinschliff
- [ ] Quittungs-E-Mail (Resend)
- [ ] QR-Code → `https://wallbox.steinbockchalets-charge.com/guest?wb=1`
- [ ] GitHub-Push

---

## 10. Was am PC gebraucht wird (für die konkrete Ausarbeitung)

Damit aus diesem Konzept echter Code-Entwurf wird, beim nächsten Mal in Österreich bereitstellen:
- Inhalt von `src/manager.js`
- Inhalt von `src/keba.js`
- Inhalt von `src/server.js`
- Inhalt von `src/db.js`
- Variablen-NAMEN aus `.env` (keine Werte!)

Dann lassen sich die Schichtgrenzen direkt in den vorhandenen Code zeichnen und die genauen Modbus-Schreibregister verifizieren.

---

## 11. Bewusste Nicht-Ziele (Scope-Grenzen)

- **Kein evcc-Code übernehmen.** evcc ist nur Architektur-Vorbild. Keba ist bei evcc sponsorpflichtig → eigener Treiber bleibt.
- **Kein Energiemanagement / PV-Überschuss** in dieser Ausbaustufe (für Gäste-Laden nicht nötig; P30X macht PV via SmartFox). Die Schichtung lässt es später nachrüsten, ohne den Rest anzufassen.
- **Kein UDP-Listener.** P30X spricht kein UDP; Modbus TCP ist der für beide Boxen zuverlässige Weg.
- **Kein Neubau bei null.** Vorhandenes wird zum sauberen Daemon veredelt.
