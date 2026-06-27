# Wallbox — Abrechnungsschutz & Default-Sperre: Vollständiger Statusbericht

> **Projekt:** Gäste-Ladesystem Steinbock Chalets, Neukirchen am Großvenediger
> **Zusammengestellt:** 18. Juni 2026
> **Zweck:** Alle Erkenntnisse zum Sperr-/Abrechnungsproblem an einem Ort, damit
> wir NICHT wieder von vorne diskutieren. Quellen: gesamte Chat-Historie,
> Projektdokumente, evcc-/Keba-Internet-Recherche.

---

## 1. Das Kernproblem in einem Satz

Beide Keba-Wallboxen (P30C **und** P30X) sollen **dieselbe** Gäste-Funktionalität
haben: Im Grundzustand müssen sie **von unserem Backend gesperrt** sein. Nur eine
**bezahlte Session** gibt frei. Sonst kann jeder einstecken und **gratis laden** —
die Abrechnung wäre umgehbar.

> **Architektur-Korrektur (Stand 17.06., bestätigt 18.06.):**
> Beide Boxen können von anderen Leuten genutzt werden. Die P30X ist **nicht**
> mehr "nur Tesla / read-only". Uli lädt dort nur faktisch fast immer selbst.
> Technik, Steuerung und Abrechnung sind für beide Boxen **identisch**.
> → In `config.js` sind daher **beide** Boxen `active: true` — beabsichtigt.

---

## 2. Was an echter Hardware bereits BEWIESEN ist (P30X, 17.06.2026)

| Punkt | Status |
|-------|--------|
| Modbus lesen (State, Leistung, Ströme, Energie) | ✅ verifiziert unter Last (11,25 kW, 16 A) |
| Schreibregister 5004 (Strom) + 5014 (enable) | ✅ funktionieren, keine "illegal data address" |
| Freigeben (`writeEnable true`) | ✅ Tesla begann auf Backend-Befehl zu laden |
| Sperren (`writeEnable false`) | ✅ Tesla fiel von 11 kW auf ~80 W |
| Backend überstimmt im aktiven Zustand | ✅ bewiesen |

**Fazit:** Modbus reicht vollständig. **Kein OCPP nötig.** Der größte ungetestete
Brocken des Projekts — "funktioniert Modbus-Steuerung an echter Hardware?" — ist
mit **Ja** beantwortet.

---

## 3. Die kritische Lücke — sauber benannt

**Beobachtung (verifiziert 17.06., P30X):**
Nach jedem Stop kam der Tesla **von selbst zurück**. Sobald die Session endete und
das Backend "losließ" (Box → IDLE, Backend schrieb nichts mehr), lag weiter Strom
an, und das **Auto verhandelte neu und lud wieder**.

**Zwei harte Befunde:**

1. **Ein einmaliges `writeEnable(false)` reicht NICHT.** Das Auto lädt nach
   Sekunden wieder an.
2. **`writeEnable(false)` greift nur zuverlässig, wenn die Box vorher per
   `writeEnable(true)` vom SELBEN Client übernommen wurde.** Ein "Aus" ohne
   vorheriges "Ein" verpufft. (Deshalb wirkte `stop` nach `start`, aber ein
   nackter `block` auf eine IDLE-Box nicht.)

---

## 4. WER schaltet wieder ein? — Ursache geklärt

Das war die offene Untersuchungsfrage. Antwort nach Recherche + Vor-Ort-Befund:

### Es ist NICHT ein konkurrierendes Steuersystem
- **SmartFox** ist nur ein **Strom-Freigabe-Schalter**, KEIN Modbus-Steuergerät.
  (Von Uli mehrfach klargestellt, 17.06.) SmartFox gibt Strom frei oder nicht,
  regelt die Box aber nicht. → **Kein Modbus-Konflikt mit SmartFox.**
- **eCarUp** (OCPP-Cloud) greift nach aktueller Einschätzung **nicht** aktiv ein.
  (Noch nicht durch Trennen final gegengeprüft — siehe offene Punkte.)
- **Das Backend ist der EINZIGE Modbus-Steuer-Client.**

### Es ist das AUTO selbst
Nach Freigabe liegt weiter Strom an (SmartFox gibt frei), und das Auto handelt
selbstständig neu aus und lädt weiter. Genau deshalb braucht es eine **aktiv
gehaltene Sperre**, nicht nur einen einmaligen Stop-Befehl.

---

## 5. Internet-Recherche: evcc & Keba bestätigen unseren Befund

**Keba Modbus TCP Programmers Guide (offiziell):**
- Eine laufende Ladung wird mit **Register 5014** gestoppt (Ladestation
  deaktivieren). Genau unser Register.
- Port 502, Unit-ID 255, nur FC3 (lesen) / FC6 (schreiben), max. 2 Register pro
  Read, Leseintervall empfohlen > 0,5 s.
- Failsafe deaktivieren = Timeout "0" senden.

**evcc-Community (mehrere Threads) — exakt unser Muster:**
- Bekannte Fehlersignatur: **"charger out of sync: expected disabled, got
  enabled"** — System sperrt, etwas macht wieder auf.
- Ein Nutzer: selbst nach Kappen des OCPP-Backends **kein** Unterschied → es war
  NICHT das OCPP-Backend. (Deckt sich mit unserem eCarUp-Verdacht: vermutlich
  nicht der Übeltäter.)
- Lösung eines anderen Nutzers im selben Thread: **"Problem war ein anderer
  Dienst, der Werte über Modbus schrieb. Nach Abschalten lief alles."** → Lehre:
  Nur EIN Modbus-Steuer-Client. (Bei uns erfüllt: nur das Backend.)
- Failsafe-Timeout sprang bei einem Nutzer nach Minuten von 0 auf 120 s zurück —
  Hinweis, dass die Box selbst Werte zurücksetzen kann. **Für uns relevant:**
  Failsafe + Default-Sperre auf Wechselwirkung prüfen.

**Kernaussage der Recherche:** Solange ein zweites System mitschreibt, ist eine
Software-Sperre ein Dauerkampf. Bei uns schreibt nur das Backend — also ist die
"enable-dann-disable + Sperre bei jedem Poll erneuern"-Strategie der richtige Weg.

---

## 6. Die Lösung — DEFAULT-SPERRE (bereits in manager.js eingebaut, 17.06.)

Eine aktive Box (`cfg.active`) ist im **Grundzustand gesperrt** und wird
**kontinuierlich** gesperrt gehalten:

1. **Beim Verbinden (`_connectUnit`):** Box übernehmen (`writeEnable(true)`),
   sofort hart sperren (`writeEnable(false)` + `writeCurrent(0)`).
2. **In JEDEM Poll-Zyklus (`_pollUnit`):** Ist die Box `locked`, ohne Session,
   aber das Auto lädt trotzdem (`state=charging` oder `watt > 50`) → Sperre
   erneut durchsetzen (`_enforceLock`). Auto kommt nie länger als ein
   Poll-Intervall durch.
3. **Schnelleres Polling** bei gesperrter Box mit ladewilligem Auto: höchstens
   2 s statt 10 s. → max. ~0,006 kWh (~0,3 ct) Gratis-Strom pro Zyklus, bevor
   die Sperre zuschlägt.
4. **Bei `startCharge`** (Gast hat bezahlt): `locked = false` → Auto darf laden.
5. **Bei Session-Ende / Stop:** `locked = true` + sofortiges `_enforceLock`.

**Neue Methode `_enforceLock(unit)`:**
Übernimmt die Box (`writeEnable(true)`), stoppt dann hart (`_safeStop` →
`writeEnable(false)` + `writeCurrent(0)`), setzt `unit.desired` auf "nicht laden",
merkt sich den Zeitpunkt. Fehler → Event `LOCK_FAILED`.

---

## 7. Geänderte Dateien (17.06.)

| Datei | Änderung |
|-------|----------|
| `src/keba.js` | `readSnapshot()` liest totalKwh (1036) + Ströme L1–L3 (1008/1010/1012) |
| `src/manager.js` | **Default-Sperre** (locked-Flag, `_enforceLock`, Poll-Enforcement, schnelles Polling, locked-Auf/Zu bei start/stop), `blockWallbox()` |
| `src/server.js` | TEMP Test-Endpunkte `/api/wallbox/:id/block` (+ `:id/setcurrent`); `manager` an `registerRoutes` durchgereicht |

> **WICHTIG:** Geänderte Dateien müssen auch in die OneDrive-Quelle kopiert
> werden, sonst überschreibt der nächste `sync-from-onedrive.bat` sie:
> `C:\Users\ulibe\OneDrive\AI\Wallbox-Backend\Wallbox-Backend\src\`
> (Status prüfen — war als To-Do offen.)

---

## 8. OFFEN — Tests, die noch ausstehen

### Test 1 — Default-Sperre greift beim Start
- Server mit neuer `manager.js`, Tesla an P30X, SmartFox auf M (voller Strom),
  Tesla-Laden einschalten.
- **Erwartung:** Tesla lädt nicht (oder nur 1–2 s). `/api/state` zeigt p30x bei
  `power ≈ 0` / `suspended`, immer wieder. KEINE `LOCK_FAILED`-Fehler im Log.

### Test 2 — Freigabe per Session
- `start` an P30X (simuliert bezahlten Gast). **Erwartung:** Tesla lädt.

### Test 3 — Stop → bleibt gesperrt
- `stop`. **Erwartung:** Tesla stoppt UND bleibt unten (kommt NICHT zurück).

### Test 4 — Limit-Modus (optional)
- Session mit kWh-Limit → bei Limit automatisch Stop + Sperre?

### Offene Design-Fragen
- **2-Sekunden-Polling im Sperrzustand:** reicht das, oder lädt der Tesla in 2 s
  zu viel? Ggf. Intervall feiner stellen.
- **Failsafe ↔ Default-Sperre:** Wechselwirkung prüfen (Box-Failsafe stoppt bei
  Daemon-Stille; darf sich mit der Sperre nicht beißen). Recherche-Hinweis: Box
  kann Failsafe selbst zurücksetzen.
- **eCarUp endgültig gegenprüfen:** durch echtes Trennen bestätigen, dass es
  nicht doch eingreift (aktuell nur Einschätzung "greift nicht ein").

---

## 9. Aufräum-To-Dos (nicht vergessen)

- [ ] P30X in SmartFox wieder auf **A (Automatik)** stellen — sonst lädt der Tesla
      teuren Netzstrom statt PV-Überschuss.
- [ ] Geänderte Dateien (keba.js, manager.js, server.js) in OneDrive-Quelle
      kopieren.
- [ ] **Admin-Passwort ändern** — wurde im Chat sichtbar getippt.
- [ ] Hängende Test-Session aufräumen (zuletzt `s_mqhvuzx8yn0be1` an P30C).
- [ ] Admin-Frontend-Bug: Start liefert "requestCharge im Zustand …" — vermutlich
      durch hängende Test-Sessions (State-Machine nicht in IDLE).
- [ ] TEMP-Endpunkte `/block` + `/setcurrent` nach Abschluss entfernen
      (`/block` ist zum manuellen Sperr-Test aber praktisch).

---

## 10. Technische Eckdaten (Spickzettel)

```
P30C  192.168.188.36   Gäste   Modbus TCP :502   active: true
P30X  192.168.188.63   "Tesla" Modbus TCP :502   active: true
PC    192.168.188.34   24/7    minipc-venediger (Tailscale 100.101.72.25)

Backend:  http://localhost:8080   (npm start, später NSSM-Dienst)
State:    curl http://localhost:8080/api/state

Keba-Register (32-bit BigEndian, einzeln lesen):
  1000 State   1004 Cable   1008/10/12 Strom L1-3   1020 Leistung
  1036 Energie gesamt   1502 Energie Session
  5004 Strom setzen (mA)   5014 enable (1/0)   5016/5018 Failsafe
```

---

*Ende. Dieses Dokument bündelt den kompletten Stand zum Sperr-/Abrechnungsthema.
Nächster sinnvoller Schritt: Tests 1–3 an der P30X durchführen und Ergebnisse hier
unter §8 eintragen.*
