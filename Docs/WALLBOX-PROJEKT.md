# Wallbox-Ladelösung Steinbock Chalets — Projektgedächtnis

> Stand: 6. Juni 2026 — Ende Tag 1
> Ziel: Eigenes Gäste-Ladesystem für E-Autos mit Bezahlung, unabhängig von eCarUp

---

## 1. Das große Ziel

Eine eigene Ladelösung für Gäste bauen, die an der **P30C** laden:
- Gast scannt QR-Code an der Wallbox
- Webinterface öffnet sich (Handy)
- Gast gibt Name + E-Mail ein, wählt Lademodus
- Bezahlung wird VOR dem Laden abgesichert (Stripe-Vorautorisierung)
- Laden startet, läuft, wird beendet
- Nur die tatsächlich geladenen kWh werden abgebucht
- Abrechnung pro kWh (Standard: 0,35 €/kWh)

**Wichtig:** eCarUp (aktuelle Lösung) soll langfristig ersetzt werden. Kostet nur Cent pro Ladung, aber Uli will eigene, unabhängige Lösung. PC läuft immer (24/7).

---

## 2. Hardware-Setup

### Zwei Keba Wallboxen (beide am Heimnetz)
| Wallbox | IP | Verwendung | Steuerung |
|---------|-----|-----------|-----------|
| **P30C** | 192.168.188.36 | Gäste-Laden (unser System) | Modbus TCP |
| **P30X** | 192.168.188.63 | Uli's Tesla | SmartFox (PV-Überschuss) + eCarUp |

- Firmware P30C: v3.10.80
- PC im Netz: 192.168.188.34

### WICHTIG: eCarUp läuft noch parallel (Option B gewählt)
- eCarUp steuert BEIDE Wallboxen via OCPP, aber nur P30C wird abgerechnet
- eCarUp bleibt aktiv bis unser System komplett fertig + getestet ist
- **Konflikt-Risiko:** eCarUp (OCPP) und unser System (Modbus) steuern dieselbe P30C.
  Lesen (Status/kWh) ist konfliktfrei. Echtes Steuern (enable/setCurrent) kann
  kollidieren → für echten Lade-Test muss eCarUp kurz pausiert werden.
- Eine Wallbox kann nur EIN OCPP-Backend haben. Umstieg = eCarUp von P30C trennen.

---

## 3. Technische Erkenntnisse (hart erarbeitet)

### Modbus ist der richtige Weg (nicht UDP, nicht REST)
- Die P30 x-series hat KEIN UDP (Port 7090 antwortet nicht)
- REST API /api/v1/... gibt es bei dieser Firmware nicht (404)
- HTTP-Scraping von status.shtml funktioniert, aber Modbus ist sauberer
- **Modbus TCP läuft auf Port 502** (NICHT 1502, auch wenn im Web-UI 1502 stand!)
- Unit-ID: 255

### Keba Modbus-Register (aus evcc keba-modbus.go verifiziert)
ALLE Messwerte sind 32-bit = 2 Register, BigEndian. EINZELN lesen (Keba gibt
oft nur 2 Register pro Anfrage zurück).

| Register | Wert | Format | Einheit |
|----------|------|--------|---------|
| 1000 | Charging State | 32-bit | 0=Startup 1=NotReady 2=Ready 3=Charging 4=Error 5=Suspended |
| 1004 | Cable State | 32-bit | Bit 2 gesetzt = Auto verbunden |
| 1008/1010/1012 | Strom L1/L2/L3 | 32-bit | mA |
| 1020 | Leistung | 32-bit | mW |
| 1036 | Energie gesamt | 32-bit | 0.1 Wh |
| 1040/1042/1044 | Spannung L1/L2/L3 | 32-bit | V |
| 1502 | Energie Session | 32-bit | 0.1 Wh |
| **5004** | Ladestrom setzen (SCHREIBEN) | 16-bit | mA (z.B. 6000 = 6A) |
| **5014** | Laden ein/aus (SCHREIBEN) | 16-bit | 1=ein, 0=aus |
| 5018 | Failsafe-Heartbeat | 16-bit | nur nötig wenn Failsafe-Timeout > 0 |

### pymodbus 3.13 Besonderheit
- Parameter heißt `device_id` (NICHT `slave` wie in alten Versionen)
- read_holding_registers(address, count=2, device_id=255)

### Abrechnung über Gesamtzählerstand (Register 1036), NICHT sessionEnergy
- Grund: Keba setzt sessionEnergy beim Anstecken nicht zuverlässig zurück
- Wir merken Start-Zählerstand, bilden Differenz = verbrauchte kWh

---

## 4. Das Backend (fertig, läuft)

**Speicherort:** `C:\Users\ulibe\Wallbox-Backend\`
**Stack:** Node.js (ES Modules), Express, modbus-serial, better-sqlite3, stripe, dotenv
**Sprache:** Node.js (wie Uli's andere Apps)
**Start:** `npm start` → läuft auf Port 8080

### Dateistruktur
```
Wallbox-Backend/
  .env                  ← STRIPE_SECRET_KEY etc. (NIEMALS in Git!)
  .env.example          ← Vorlage
  .gitignore
  package.json
  src/
    config.js           ← Wallbox-IPs, Defaults
    keba.js             ← Modbus-Treiber (Keba-Klasse)
    manager.js          ← verwaltet beide Wallboxen, Polling alle 4s, Auto-Stop
    db.js               ← SQLite (sessions + settings)
    stripe.js           ← Vorautorisierung + Capture
    server.js           ← REST-API + liefert UIs aus
  public/
    index.html          ← Admin-Dashboard (dunkel, technisch)
    guest.html          ← Gäste-Seite (hell, freundlich, mobil)
  sessions.db           ← SQLite-Datenbank (NICHT in Git)
  fix-session.mjs       ← Aufräum-Script für hängende Sessions
  cloudflared.exe       ← Cloudflare Tunnel Client
```

### REST-API Endpunkte
| Methode | Endpunkt | Zweck |
|---------|----------|-------|
| GET | /api/state | Status beider Wallboxen + laufende Sessions |
| GET | /api/settings | Einstellungen (Preis, Reservierung) |
| POST | /api/settings | Einstellungen ändern |
| POST | /api/guest/request?wb=1 | Gast startet Anfrage → Stripe-Checkout-URL |
| POST | /api/guest/confirm/:sessionId | Nach Stripe-Rückkehr → Ladung starten |
| POST | /api/guest/stop/:sessionId | Laden beenden → Capture |
| POST | /api/wallbox/:id/start | Admin: manuell starten |
| POST | /api/wallbox/:id/stop | Admin: manuell stoppen |
| GET | /api/sessions | Alle Ladevorgänge |

### Einstellungen (in DB, im Admin-UI änderbar)
- price_per_kwh: 0.35 (€/kWh)
- reserve_amount: 30 (€ Vorautorisierung bei "Voll laden")
- currency: EUR

---

## 5. Stripe-Bezahlung (Vorautorisierung)

### Konto-Status
- Uli hat Stripe-Account (verknüpft mit steinbock-chalets / Webflow)
- WICHTIG: Im TESTMODUS / Sandbox entwickeln (Keys beginnen mit pk_test_ / sk_test_)
- Test-Publishable-Key ist in .env.example hinterlegt
- Test-Secret-Key (sk_test_) muss Uli selbst in .env eintragen (NIE in Chat/Git!)

### SICHERHEITSVORFALL Tag 1 (erledigt prüfen!)
- Uli hat versehentlich LIVE Secret Key (sk_live_...) im Chat gepostet
- MUSS im Stripe-Dashboard widerrufen/rolliert werden (falls noch nicht geschehen)
- → Morgen prüfen: ist der sk_live Key wirklich rolliert?

### Der Flow (capture_method: manual)
1. Gast wählt Modus + Daten → POST /api/guest/request
2. Stripe Checkout-Session mit capture_method:"manual" → reserviert Geld (Hold)
3. Gast zahlt mit Testkarte 4242 4242 4242 4242, 12/30, CVC 123
4. Rückleitung zu /guest?paid=ok&sid=X → POST /api/guest/confirm
5. Backend prüft: PaymentIntent status == "requires_capture"? → Ladung starten
6. Laden läuft. Bei Modus "limit": Auto-Stop wenn Betrag erreicht
7. "Laden beenden" → POST /api/guest/stop → captureAmount(pi, echteKwh*preis)
8. Partial Capture: nur echter Betrag abgebucht, Rest der Reservierung freigegeben
9. Bei Betrag < 0,50 €: cancelAuth → komplette Freigabe (kein Capture)

### Zwei Lademodi
- **"Voll laden"**: reserviert Admin-Reservierungsbetrag (30€), Gast beendet selbst
- **"Bis Betrag laden"**: Gast wählt Limit (z.B. 20€), reserviert genau das,
  Wallbox stoppt automatisch bei Erreichen (manager.js onLimitReached)

### Pflichtfelder
- Name (min. 2 Zeichen) + gültige E-Mail werden vor Zahlung geprüft

---

## 6. Cloudflare Tunnel (Quick Tunnel — getestet, funktioniert)

### Was läuft
- cloudflared.exe im Backend-Ordner
- Start: `cloudflared.exe tunnel --url http://localhost:8080`
- Gibt ZUFALLS-URL (ändert sich bei jedem Neustart!)
- Tag 1 URL war: supports-housewares-agenda-autumn.trycloudflare.com
- Erfolgreich vom Handy übers Internet getestet inkl. komplettem Stripe-Flow

### WICHTIG bei Tunnel-Nutzung
- PUBLIC_BASE_URL in .env muss auf die Tunnel-URL zeigen (sonst Stripe-Rückleitung
  zu localhost → klappt auf Handy nicht). Bei Quick Tunnel jedes Mal anpassen!
- Backend UND Tunnel müssen beide laufen (zwei CMD-Fenster)

---

## 7. Was HEUTE (Tag 1) erreicht wurde

✅ Modbus-Verbindung zu beiden Wallboxen (Lesen + Steuerbefehle)
✅ Korrekte Register-Logik aus evcc übernommen (32-bit!)
✅ Node.js-Backend mit REST-API
✅ Admin-Dashboard (Live-Status, Steuerung, Einstellungen)
✅ Gäste-Interface (mobil, schön, Lademodi)
✅ SQLite für Sessions + Einstellungen
✅ Stripe-Vorautorisierung komplett (beide Modi, Partial Capture)
✅ Pflichtfelder Name + E-Mail
✅ Cloudflare Quick Tunnel — vom Handy übers Internet getestet, funktioniert!

---

## 8. NÄCHSTE SCHRITTE (Tag 2 und weiter)

### Priorität 1 — Robustheit
- [ ] Hängende Sessions automatisch aufräumen (Problem Tag 1: Session blieb "aktiv"
      wenn Gast Seite schließt ohne "Beenden"). Lösung: Timeout-basiertes Auto-Cancel
      oder "laufende Session fortsetzen" beim erneuten Öffnen
- [ ] Verhalten bei Stripe-Abbruch absichern (pending_auth Sessions aufräumen)
- [ ] Was passiert bei Backend-Neustart während laufender Ladung?

### Priorität 2 — Echter Lade-Test mit Auto
- [ ] eCarUp kurz pausieren (sonst OCPP/Modbus-Konflikt)
- [ ] Auto an P30C anstecken
- [ ] Prüfen: startet setCurrent(16) + enable(true) WIRKLICH die Ladung?
- [ ] kWh-Zählung über Zeit verifizieren
- [ ] eCarUp wieder aktivieren
- WICHTIG: Das haben wir NIE mit echtem Auto an P30C getestet!

### Priorität 3 — Feste URL (für QR-Code)
- [ ] Quick Tunnel gibt wechselnde URL → für Produktiv ungeeignet
- [ ] Named Tunnel mit fester Subdomain: wallbox.steinbockchalets.com
- [ ] DAFÜR KLÄREN: Wo wird steinbockchalets.com DNS verwaltet?
      (Domain ist in Lovable erstellt, läuft auf gekaufter Website)
      ACHTUNG: Webflow-Website darf nicht abgeschossen werden!
- [ ] Cloudflare Named Tunnel + DNS-CNAME einrichten

### Priorität 4 — Autostart (PC läuft 24/7)
- [ ] Backend als Windows-Dienst (NSSM oder node-windows)
- [ ] Cloudflare Tunnel als Windows-Dienst (`cloudflared service install`)
- [ ] Beide starten automatisch nach PC-Neustart

### Priorität 5 — Quittungs-E-Mail
- [ ] Nach Zahlung automatische Rechnung per E-Mail
- [ ] Resend oder Supabase Edge Function (wie bei anderen Uli-Projekten)

### Priorität 6 — QR-Code erstellen
- [ ] QR-Code → https://wallbox.steinbockchalets.com/guest?wb=1
- [ ] Ausdrucken, an P30C anbringen

### Später / Optional
- [ ] Admin-Dashboard mit Passwortschutz (wenn extern erreichbar)
- [ ] Übernahme/Integration in Lovable (Gäste-Seite als Teil von steinbockchalets.com)
- [ ] eCarUp endgültig von P30C trennen (erst wenn alles bewährt!)
- [ ] Steuerliche Frage klären (Steuerberater): Gewerbeschein/USt für
      Stromverkauf an Gäste? Kleinunternehmerregelung (AT: bis 55.000€)?

---

## 9. Offene Sicherheits-Punkte

- [ ] Stripe LIVE Secret Key rollieren (wurde Tag 1 im Chat gepostet!)
- [ ] .env aus web-takeover-buddy GitHub-Repo entfernen (nur Anon-Key, nicht akut,
      aber unsauber) — Lovable-Prompt wurde dafür erstellt
- [ ] Niemals sk_test_ oder sk_live_ in Chat/Git — nur in lokale .env

---

## 10. Wichtige Befehle (Spickzettel)

```cmd
REM Backend starten
cd C:\Users\ulibe\Wallbox-Backend
npm start

REM Tunnel starten (zweites Fenster)
cd C:\Users\ulibe\Wallbox-Backend
cloudflared.exe tunnel --url http://localhost:8080

REM Hängende Sessions aufräumen
node fix-session.mjs

REM Status testen (lokal)
curl http://localhost:8080/api/state
```

URLs lokal:
- Admin:  http://localhost:8080
- Gäste:  http://localhost:8080/guest?wb=1  (wb=1 = P30C, wb=2 = P30X)

Stripe Testkarte: 4242 4242 4242 4242 / 12/30 / CVC 123

---

## 11. Architektur-Diagramm

```
   Gast (Handy, überall im Internet)
        |
        | HTTPS
        v
   Cloudflare Tunnel  (wechselnde URL bei Quick Tunnel)
        |
        v
   PC zuhause (läuft 24/7, 192.168.188.34)
   ┌─────────────────────────────────────┐
   │  Node.js Backend (Port 8080)         │
   │   - Express REST-API                 │
   │   - Stripe (Vorautorisierung)        │
   │   - SQLite (Sessions)                │
   │   - Modbus-Treiber                   │
   └─────────────────────────────────────┘
        |                      |
        | Modbus TCP :502      | (P30X: SmartFox/eCarUp)
        v                      v
   P30C (.36)             P30X (.63)
   Gäste-Laden            Uli's Tesla
```

---

*Ende Projektgedächtnis Tag 1. Morgen weiter bei "Nächste Schritte".*
