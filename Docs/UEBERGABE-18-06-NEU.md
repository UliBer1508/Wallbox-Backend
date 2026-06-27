# Wallbox — Übergabe 18.06.2026 & Aufgabe für morgen

> Zusammenfassung dessen, was heute gebaut wurde, plus die geplante nächste
> Aufgabe (automatischer Aufräumer für hängende Sessions). Damit wir morgen
> nahtlos weitermachen, ohne etwas neu zu diskutieren.

---

## TEIL 1 — Was heute (18.06.) gebaut und eingespielt wurde

Alle Dateien wurden auf dem Produktiv-PC eingespielt und das Backend neu
gestartet. Stand: läuft.

### Behobene Bugs

**Hängende Sessions — Ursache gefunden und behoben (der große Fix).**
Der Stop quittierte „ok", schloss die DB-Session aber NICHT ab, wenn die
State-Machine in IDLE hing. Dadurch sammelten sich `active`/`pending`-Sessions
in der DB an und blockierten die Boxen. Behoben in:
- `manager.js` → `stopCharge` beendet die Session jetzt zuverlässig, auch wenn
  `_beginStop` nichts tut (IDLE-Fall), und feuert `chargingStopped`.
- `server.js` → der `chargingStopped`-Handler schließt jetzt die DB-Session ab
  (`status: 'completed'`, `ended_at` gesetzt).

**Stripe/Gäste-Flow:**
- `guest.html`: fehlende `api()`-Funktion ergänzt (war „api is not defined").
- E-Mail-Feld-Autofill (zeigte die Wallbox-URL) — Korrektur war in Arbeit/geplant.

### Neue Funktionen

**Bezahlung aus = nur lesen (Tesla-Modus).**
Bei `pay_required=false` greift die Default-Sperre NICHT mehr — das Auto (eigener
Tesla) lädt frei im Überschuss, das Backend liest nur. Umgesetzt über neue
Methode `manager.setPayRequired(id, bool)`; server.js ruft sie beim Start (aus
DB) und bei jedem Bezahl-Schalter-Klick auf. Verifiziert: P30X lud mit ~7 kW
bei pay aus, ohne Sperre.

**Lade-Info bei angestecktem Auto ohne Session.**
Backend merkt sich Einsteck-Zeitpunkt (`plugTs`) und Zählerstand beim Einstecken
(`plugStartKwh`); `getState`/`buildState` liefern `pluggedSince` + `pluggedKwh`.
Admin zeigt grüne Box „Lade-Info (gratis)" mit „Angesteckt seit / Geladen /
Status". Eigenheit: Nach Backend-Neustart startet `pluggedSince` am Neustart-
Moment (nicht rückwirkend); beim nächsten echten Ein-/Ausstecken exakt.

**Admin-Frontend (index.html):**
- Ehrliche Status-Texte (Badge + Hinweis) statt Rohwert „NOTREADY" → „Bereit"
  etc., abhängig von state + carConnected + power.
- „Aktuelle Session"-Box erweitert + jetzt EINHEITLICH GRÜN (alle Infos in einer
  grünen Box: Betrag/kW, kWh, Angesteckt seit, Leistung, Status).
- Live-Ladestrom-Anzeige („Lädt mit X A").
- Selectbox „Max. Ladestrom" (statt „Ladestrom") mit Hinweis „Obergrenze — Auto
  und Wallbox bestimmen die tatsächliche Höhe".
- Buttons: bei pay aus „Auto-Start" (deaktiviert) / „Stopp"; bei pay an „Start"/
  „Stopp".
- Ladeverlauf: einklappbar (letzte 5 + Aufklapper) mit Filter-Buttons pro Box.
- „Gäste-Seite öffnen ↗"-Button pro Box.
- Login in den HEADER verlegt (Passwortfeld + Anmelden/Abmelden oben rechts);
  Login-Token bleibt in localStorage gespeichert (übersteht Neuladen).

**guest.html:** ehrlicher Lade-Status (lädt / pausiert / wartet auf Fahrzeug)
statt fest „Ihr Auto lädt"; zweisprachig DE/EN.

### Aufgeräumt
- 4 hängende Sessions per `cleanup-sessions.mjs` (mit DB-Backup) auf `completed`
  gesetzt. Beide Boxen danach sauber (`session: null`).

### Dateistände (aktuell produktiv)
- `src/manager.js`  (zuletzt: manager-NEU2.js)
- `src/server.js`   (zuletzt: server-NEU2.js)
- `public/index.html` (zuletzt: index-NEU3.html — grüne Box + Header-Login)
- `public/guest.html` (zuletzt: guest-NEU.html)

---

## TEIL 2 — AUFGABE FÜR MORGEN: Auto-Aufräumer für hängende Sessions

### Ziel
Ein Sicherheitsnetz, das verbleibende/zukünftige hängende Sessions automatisch
beendet. WICHTIG: Der eigentliche Stop-Bug ist bereits behoben — dies ist nur
ein Schutz gegen Abstürze, Stromausfall oder unbekannte Randfälle.

### Mechanismus
Periodischer Job im Backend (`server.js`), läuft alle paar Minuten (z.B. alle
2–3 Min). Kein separates Skript — integriert, damit er immer mitläuft.

### Regeln (konservativ — NICHT zu aggressiv!)
Eine Session wird automatisch beendet (`status='completed'`, `ended_at`,
`note` markieren, `db.log`), wenn:

1. **pending** und älter als ~15 Minuten (Zahlung kam nie zustande).
2. **active**, aber **Auto abgesteckt** (`carConnected=false` an der Box) →
   Auto ist weg, Session blieb hängen.

NICHT anfassen (in Ruhe lassen):
3. **active** mit **Auto angesteckt, aber pausiert** (kein Strom) → das ist der
   normale Überschuss-Modus des Tesla (kann stundenlang so sein). Darf NICHT
   abgewürgt werden.

### Verhalten
- Leise aufräumen, jede Aktion in `db.log` schreiben (nachvollziehbar: was,
  wann, warum beendet).
- Schwellwerte (15 Min etc.) als Konstanten oben definieren, später ggf. als
  Admin-Setting.

### Offene Detailfrage für morgen
- Soll der Aufräumer beim Beenden auch die Hardware sperren (Box wieder in
  Default-Sperre, falls pay_required), oder nur die DB-Session schließen?
  → Vermutlich ja, konsistent mit normalem Stop.

---

## TEIL 3 — OFFENE UNTERSUCHUNG: Warum lädt das Auto nach Stopp wieder an?

### Das Problem
Wenn das Backend die Wallbox stoppt, fängt das Auto teils wieder an zu laden.
Unklar war, ob das (a) das Auto selbst ist, das bei anliegendem Strom neu
aushandelt, oder (b) ein anderer Prozess (eCarUp/OCPP) aktiv wieder einschaltet.

### Zwei Prüfwege — Stand:

**Weg 1 — evcc, wie machen die das: ✅ ERLEDIGT (recherchiert).**
- evcc nutzt DUAL-STOP: `current=0` PLUS `enable=false` (Register 5014), weil
  Strom=0 allein manche Keba nicht zuverlässig stoppt. → In keba.js `stop()`
  bereits so umgesetzt.
- evcc hat einen Soll/Ist-Wächter ("out of sync: expected disabled, got
  enabled") und hält aktiv dagegen, wenn die Box abweicht. → Entspricht unserer
  Default-Sperre (`_enforceLock` erneuert bei jedem Poll).
- evcc weiß: Keba lädt von selbst los, sobald Auto ansteckt → muss aktiv
  dagegenhalten ("Disable-Timer"). Genau unser Ansatz.

**Weg 2 — eCarUp/OCPP prüfen: ⏳ OFFEN (Test vor Ort nötig).**
- Test: eCarUp KOMPLETT von der Box trennen (OCPP-Verbindung in eCarUp-Config
  kappen), dann an der P30X stoppen und beobachten:
  - Auto läuft trotz getrenntem eCarUp wieder an → es ist DAS AUTO.
  - Auto bleibt aus → eCarUp war der Übeltäter.
- Voraussetzung: Zugang zur eCarUp-Konfiguration der Box.

**SmartFox: ✅ ausgeschlossen.** Nur Strom-Freigeber (voll/Überschuss), kein
Modbus-Client. Steuert die Box nicht. (Von Uli mehrfach bestätigt.)

### Starke Indizien aus heutigem Test (18.6.)
Das Backend konnte an der P30X den Tesla sauber stoppen UND freigeben, und die
Default-Sperre ließ den Tesla bei „Bezahlung aus" frei laden. Hätte eCarUp aktiv
gegengesteuert, wäre das nicht so sauber gelaufen. → Deutet stark darauf hin,
dass es DAS AUTO ist (Ulis ursprüngliche Vermutung), nicht eCarUp. Beweis steht
noch aus (Weg-2-Test).

---

## Weitere offene Punkte (niedrigere Priorität)
- E-Mail-Feld-Autofill in guest.html final unterbinden (zeigte Wallbox-URL).
- **Admin-Passwort ändern** — war mehrfach im Chat sichtbar (Waldim1508@).
- Stripe `sk_live_`-Key rotieren (war früher offengelegt) — aktuell läuft TEST
  (`sk_test_`), aber Publishable Key war Platzhalter `pk_test_HIER_...` →
  echten pk_test_ aus Stripe-Dashboard eintragen, falls Zahlung im Browser
  getestet werden soll.
- TEMP-Endpunkte `/block`, `/setcurrent` später entfernen.
- Echter Lade-Test mit Abrechnung (bezahlte Gast-Session mit fließendem Strom,
  Reservierung minus realer Verbrauch über Stripe) steht noch aus.
