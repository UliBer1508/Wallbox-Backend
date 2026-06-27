# Warte-auf-Auto-Zustand — KOMPLETT umgesetzt

**Stand:** 19.06.2026 · alle 4 Ebenen fertig + getestet

## Das behobene Problem
Nach der Zahlung sprang die Anzeige sofort auf „Bezahlt" mit 0 kWh, ohne dass
ein Auto angesteckt war. Ursache: `startCharge` ging direkt auf CHARGING,
obwohl kein Auto da war → Box meldet „lädt nicht" → STOPPING → 0-kWh-Quittung.

## Lösung: neuer Zustand WAITING_FOR_CAR
Ablauf: REQUESTED (bezahlt) → **WAITING_FOR_CAR** → CHARGING (Auto lädt wirklich)
Erst wenn Auto steckt UND Strom fließt → CHARGING. Sonst nach 10 Min Abbruch +
Reservierung freigeben. Gast kann jederzeit selbst abbrechen.

## GEÄNDERTE DATEIEN (5) — alle syntaxgeprüft + Integrationstests grün

1. **statemachine.js** — Zustand WAITING_FOR_CAR + Übergänge. Direkter Sprung
   REQUESTED→CHARGING gesperrt. 12 Unit-Tests grün.

2. **manager.js**
   - `startCharge` → WAITING_FOR_CAR (kein Strom, Box bleibt gesperrt), merkt
     `waitingSince`.
   - neuer `_beginCharging()` — WAITING→CHARGING, Sperre auf, Strom frei.
   - Poll-Block: Auto erkannt (`plugged||watt>50`) → `_beginCharging`; sonst
     10-Min-Timeout (`middle.waitForCarMinutes`) → IDLE + Event `waitTimeout`.
   - Default-Sperre nimmt WAITING_FOR_CAR aus (sonst sperrt sie das anlaufende
     Auto sofort wieder — war ein Testfehler, behoben).
   - `cancelRequest` bricht auch aus WAITING ab.

3. **facade.js** — neue Events `waitingForCar`, `waitTimeout`, `requestCancelled`
   zur FACADE_EVENTS-Whitelist (sonst kommen sie nicht in server.js an).

4. **server.js**
   - Endpoint `POST /api/guest/cancel/:sid` → `facade.cancelRequest`.
   - Handler `waitTimeout` + `requestCancelled` → `billing.cancelAuthorization`
     gibt Stripe-Reservierung komplett frei (0 € berechnet).
   - Status-Endpoints geben `fsmState` + `waitingForCar` an den Client.

5. **guest-NEU.html**
   - neuer Warte-Screen (step-wait) mit Countdown-Ring 10:00 + Abbrechen-Button.
   - Poll erkennt `wb.waitingForCar` → zeigt Warte-Screen statt Lade-Screen.
   - Abbrechen → Bestätigung (confirm) → `/api/guest/cancel/:sid` → zurück zum Start.
   - DE/EN-Texte ergänzt.

## EINSPIEL-REIHENFOLGE (WICHTIG)
Alle 5 Dateien gehören ZUSAMMEN und müssen GEMEINSAM eingespielt werden:
- statemachine.js, manager.js, facade.js, server.js → nach `src/`
- guest-NEU.html → als `guest.html` nach `public/`
NICHT einzeln einspielen — die alte manager.js würde mit neuer statemachine
crashen (ruft REQUESTED→CHARGING direkt auf).

Vorher Backup der aktuellen Versionen anlegen!

## TESTEN nach Einspielen (Stripe-Sandbox)
1. P30C scannen (frei) → Daten → bis 20 € → zahlen.
2. NACH Zahlung: Warte-Screen mit Countdown muss erscheinen (NICHT mehr sofort
   „Bezahlt").
3. Auto anstecken → wechselt auf Lade-Screen, Strom fließt.
4. ODER: Abbrechen drücken → Bestätigung → Reservierung im Stripe-Dashboard frei.
5. ODER: 10 Min warten ohne Auto → automatischer Abbruch, Reservierung frei.

## Konfiguration
- Wartezeit über `middle.waitForCarMinutes` (Default 10). Wird aus der
  Middle-Layer-Config / Settings gespeist.
- Tesla-Überschuss (pay_required=false) NICHT betroffen — Warte-Logik nur für
  bezahlpflichtige Gast-Sessions.
