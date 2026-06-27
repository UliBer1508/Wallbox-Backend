# Übergabe — Guest-Flow Überarbeitung

**Stand:** 19.06.2026 · Steinbock Chalets Wallbox-Backend

---

## TEIL A — FERTIG & GETESTET (in guest-NEU.html)

Die Datei `guest-NEU.html` ist fertig. Vor dem Einspielen alte `guest.html`
sichern, dann als `guest.html` nach `public/` kopieren.

Folgende Änderungen sind drin und live getestet:

1. **Status nur in der Pille.** Kein separater grüner „Bereit zum Laden"-Kasten
   mehr. Die Pille oben zeigt den Zustand:
   - frei → grün „[Boxname] · Station ladebereit"
   - belegt → rot „[Boxname] · Station belegt"

2. **Belegt-Logik.** Lädt schon ein (fremdes) Auto, wird der Zahl-Button zu
   „Erneut prüfen", und der 🔌-Anstecken-Hinweis wird ausgeblendet (er ergibt
   bei belegter Box keinen Sinn). Erkennung über `carConnected` / `power` / `state`.

3. **🔌-Hinweis von der Welcome-Seite entfernt.** Er erscheint jetzt erst NACH
   der Zahlung im Lade-Screen (Zustand „Warte auf Fahrzeug"), wo er hingehört.

4. **Reservierungstext + Titel modusabhängig:**
   - Voll laden → „Wichtig zur Reservierung" + Kautionstext
   - Bis Betrag → „Laden bis zum Betrag" + „Es wird bis zu dem von Ihnen
     eingegebenen Betrag geladen. Danach stoppt die Ladung automatisch."
   - Funktioniert auch beim Sprachwechsel (DE/EN).

5. **E-Mail/Name leer + Autofill-Schutz.** Felder starten `readonly` und werden
   erst beim Antippen freigeschaltet, damit der Browser sie beim Laden nicht
   automatisch mit gespeicherten Daten füllt. Plus `autocomplete="off"` u.a.

---

## TEIL B — NÄCHSTER SCHRITT (noch NICHT umgesetzt): Warte-auf-Auto-Zustand

### Das Problem (im Test gefunden)
Nach der Zahlung sprang die Anzeige sofort auf „Bezahlt — danke!" mit 0 kWh,
 OHNE dass ein Auto angesteckt war. Ursache: `startCharge` in `manager.js`
setzt die Statemachine SOFORT auf CHARGING (Zeile ~326), obwohl kein Auto da
ist. Die Box meldet „lädt nicht" → das löst STOPPING aus → Session endet mit
0 kWh, bevor der Gast überhaupt anstecken konnte.

### Die Lösung (Konzept abgestimmt, Mockup abgenommen)
Ein NEUER Zustand zwischen „bezahlt" und „lädt": **WARTE AUF AUTO**.

Soll-Ablauf:
`REQUESTED (bezahlt)` → **`WARTE AUF AUTO`** → `CHARGING (Auto lädt wirklich)`

- Nach Zahlung geht das System NICHT direkt auf CHARGING, sondern wartet aktiv.
- Erst wenn **Auto angesteckt UND Strom fließt** (`plugged && watt>0`) → CHARGING.
- Kommt nach **10 Minuten** kein Auto → Vorgang automatisch abbrechen,
  Reservierung vollständig freigeben (0 € abgebucht).

### Gast-Anzeige im Warte-Screen (Mockup abgenommen)
- Aufforderung „Bitte Auto anstecken" + Erklärung (startet automatisch).
- **Sichtbarer Countdown** im Ring: zählt von 10:00 runter, Ring amber/wartend.
- Hinweis: „Wird innerhalb von 10 Minuten kein Fahrzeug angesteckt, brechen wir
  automatisch ab. Ihre Reservierung wird freigegeben."
- **Abbrechen-Button** → Bestätigungsabfrage „Wirklich abbrechen?" mit
  „Weiter warten" / „Ja, abbrechen". Bei Ja: Reservierung frei, zurück zum Start.

### Umsetzung betrifft DREI Ebenen (Eingriff in Schicht 2 = sorgfältig!)
1. **statemachine.js** — neuen Zustand WAITING_FOR_CAR + erlaubte Übergänge
   (REQUESTED→WAITING, WAITING→CHARGING, WAITING→IDLE bei Abbruch/Timeout).
2. **manager.js** — `startCharge` geht auf WAITING statt CHARGING; der Poll-Loop
   erkennt `plugged && watt>0` und schaltet dann auf CHARGING. Timeout-Wächter
   (10 Min) → Abbruch + Reservierung freigeben.
3. **server.js / guest.html** — Warte-Screen mit Countdown, Abbrechen-Endpoint
   (`/api/guest/cancel/:sid` → Reservierung freigeben), Gast-Anzeige.

### Wichtig dabei
- Tesla-Überschuss (`pay_required=false`) NICHT betreffen — der Warte-Zustand
  gilt nur für bezahlpflichtige Gast-Sessions.
- Der bestehende Auto-Aufräumer (server.js ~Zeile 161) bleibt als Sicherheitsnetz.

---

## Allgemeines Prinzip (durchzieht alles)
An JEDER Stelle, wo der Gast warten oder handeln muss, bekommt er:
**(1) klare Information, was passiert, und (2) eine Handlungsmöglichkeit
(weitermachen oder abbrechen).** Keine stillen Zustandswechsel, keine
Entwickler-Fehlertexte.

## Offene Punkte (Nebenschauplätze)
- Stripe PLZ-Erfassung: im Sandbox nicht verlangt — im Live-Dashboard
  entscheiden, ob gewünscht.
- Mockups (rechts im Chat) sind reine Anschau-Attrappen ohne Funktion; die
  echte Datei ist immer guest-NEU.html.
