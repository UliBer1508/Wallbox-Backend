# Wallbox — Übergabe 04.07.2026: Gratis-Sessions dokumentieren

> Was heute gebaut wurde: Automatische Dokumentation kostenloser Ladevorgänge
> (Tesla-Modus / Bezahlung aus) im Ladeverlauf, inkl. Ersparnis-Anzeige.
> Plus: Projektordner aufgeräumt, GitHub-Status geklärt.

---

## TEIL 1 — Gratis-Dokumentation (NEU)

### Ausgangslage
Bisher wurden nur zwei Arten kostenloser Ladungen in `sessions.db` erfasst:
Admin-Starts und Gäste-Starts bei „Bezahlung aus" (beide via `free_charge=1`).
Der wichtigste Fall fehlte: **Auto steckt bei „Bezahlung aus" selbst an und
lädt, ohne dass jemand etwas klickt** (Tesla-Überschuss-Modus). Diese Ladungen
tauchten nirgends im Verlauf auf. Außerdem zeigte das Admin-UI Gratis-Sessions
nicht als solche an (erschienen als graues „Beendet").

### Verhalten (neu)
1. **Einstecken** bei `pay_required=false` und ohne aktive Session →
   Gratis-Session „Auto-Ladung" wird angelegt (`free_charge=1`, `status=active`).
2. **Alle 30 s** → kWh + Ersparnis-Betrag werden aus dem Gesamtzählerstand
   aktualisiert (Betrag = kWh × `price_per_kwh`, als „gespart" zu lesen).
3. **Abstecken** → Session wird mit finalen kWh abgeschlossen.

### Kernprinzip: Zählerstand in der note
Der Start-Zählerstand wird beim Anlegen in der `note`-Spalte gespeichert
(`auto-gratis;start_total_kwh=…`). Energie = aktueller Zähler minus Start.
**Kein DB-Schema-Umbau nötig**, und die Messung überlebt Backend-Neustarts
exakt (bewährtes Projektprinzip: Abrechnung über Gesamtzählerstand, Reg 1036).

### Randfälle (alle abgedeckt)
- **Bezahl-Schalter AUS bei bereits angestecktem Auto** → Gratis-Session wird
  sofort geöffnet (Zählerstand ab diesem Moment).
- **Bezahl-Schalter AN bei offener Gratis-Session** → Session wird mit finalen
  kWh abgeschlossen (`[Bezahlung eingeschaltet]`).
- **Admin-Start / Gast-Start bei offener Gratis-Session** → Gratis-Session wird
  vorher sauber geschlossen (nie zwei aktive Sessions pro Box).
- **Backend-Neustart** (15 s verzögert, damit der erste Poll durch ist):
  - offene Gratis-Session + Auto steckt + pay aus → weiterführen (kWh exakt)
  - offene Gratis-Session, Auto weg oder pay an → abschließen
    (`[nach Neustart geschlossen]`)
  - keine Session, aber Auto steckt + pay aus → jetzt anlegen (Erfassung
    beginnt am Neustart-Moment, nicht rückwirkend)
- **Auto-Aufräumer** kollidiert nicht: Sein Schutz „Auto angesteckt → niemals
  anfassen" greift auch für Gratis-Sessions.

### Bewusste Entscheidung: Bezahl-Schalter bleibt aus
Die bestehende Auto-Rücksetzung („free_charge gilt nur für EINE Ladung") wurde
**nicht** auf Auto-Ladungen ausgedehnt. Der Tesla-Modus bleibt an, bis er im
Admin umgelegt wird — sonst müsste man ihn nach jedem Abstecken neu einschalten.

### Frontend (index.html)
- Neuer **Amber-Tag „Gratis"** für alle `free_charge`-Sessions (statt „Beendet");
  laufende Gratis-Ladung zeigt „Aktiv" + „Gratis" nebeneinander, Zeile leicht
  amber hinterlegt.
- **Betrag in Amber** bei Gratis = Ersparnis (was die Ladung zum Gäste-Tarif
  gekostet hätte). Hinweis: bewertet mit `price_per_kwh` (0,35 €), nicht mit dem
  tatsächlichen Netzbezugspreis — bei Bedarf später eigene Einstellung.
- Gast-Spalte: „🔌 Auto-Ladung" für automatisch dokumentierte Ladungen;
  „Admin" für manuelle Starts; Gastname bei Gast-Starts.
- Neuer **Filter-Button „Gratis"** neben den Box-Filtern.
- **Summenzeile „☀️ Gespart gesamt"** unter dem Verlauf (Summe über die
  geladenen Sessions, Limit 200).

### Geänderte Dateien (Stand produktiv nach Einspielen)
| Datei | Änderung |
|---|---|
| `src/manager.js` | Neues Event `cablePlugged` (mit Zählerstand); `cableDisconnected` liefert jetzt `kwhSincePlug` + `totalKwh` mit |
| `src/facade.js` | `cablePlugged` in `FACADE_EVENTS`-Whitelist aufgenommen |
| `src/server.js` | Gratis-Session-Verwaltung: open/close/find-Helfer, Event-Handler, 30-s-Live-Updater, Neustart-Wiederaufnahme, Randfall-Guards in Payment-Toggle, Admin-Start und Gäste-Request |
| `public/index.html` | Gratis-Tag, Amber-Ersparnis, Filter „Gratis", Summenzeile |
| `src/statemachine.js` | **UNVERÄNDERT** |

Lieferung als: `manager-GRATIS.js`, `facade-GRATIS.js`, `server-GRATIS.js`,
`index-GRATIS.html` (+ `wallbox-gratis-update.zip`).

### Tests
9/9 bestanden (Mock-Keba + In-Memory-DB, node:sqlite-Adapter):
Einstecken→Session, Start-Zählerstand in note, Abstecken→Abschluss mit
korrekten kWh (12,34) und Ersparnis (4,32 €), Toggle-Schließen, kein Doppel
bei aktiver Fremd-Session, keine Session bei Bezahlung AN. `node --check`
auf allen drei JS-Dateien sauber.

### Schnelltest vor Ort
Bezahlung an der P30X aus → Tesla anstecken → „🔌 Auto-Ladung" erscheint mit
Aktiv+Gratis im Verlauf → kWh/Ersparnis aktualisieren sich alle 30 s →
Abstecken schließt die Zeile ab.

---

## TEIL 2 — Projektordner aufgeräumt (04.07.)

Gelöscht: `alle datein 20.6.26.zip`, `test-protokoll.txt`,
`test-protokoll-2.txt`, `check-mail.mjs`. Behalten: `test/`-Ordner
(Sandbox-Testumgebung), `START-HIER.txt`, `setup.ps1`, `logs/`.
WICHTIG festgehalten: `sessions.db-shm` / `sessions.db-wal` gehören zu SQLite
(WAL-Modus) und dürfen NIE gelöscht werden.

---

## TEIL 3 — GitHub-Status (geklärt 04.07.)

**Befund:** Das Repo `UliBer1508/Wallbox-Backend` existiert auf GitHub NICHT
(Account hat nur smartfox-insight-ai-selfhosted, Vokabeltrainer,
hausmanagement-selfhosted). Lokal ist `.git` vorhanden, aber es wurde nie zu
GitHub gepusht. Frühere Notiz „Repo ist public" war falsch bzw. veraltet.

**Vor dem ersten Push zu klären/tun:**
- [ ] Repo anlegen — Empfehlung: **PRIVAT** (Doku enthält interne IPs,
      Tailscale-IP, Tunnel-ID; bei privat unkritisch, bei public müsste
      `Docs/` bzw. alle .md mit Infrastruktur-Details ausgeschlossen werden)
- [ ] `.gitignore` prüfen/erweitern: aktuell `node_modules/`, `.env`,
      `sessions.db`, `sessions.db-*`, `*.log`. Kandidaten zusätzlich:
      `services.json` (falls interne Links drin), `logs/`
- [ ] `steinbock-logo.png` in den Commit einschließen (offener Punkt)
- [ ] `.env.example` prüfen: kein echter Key, `UPLOAD_PASSWORD` entfernen

---

## Offene Punkte (unverändert übernommen)
- Admin-Passwort ändern (war im Chat sichtbar)
- Stripe: echten `pk_test_` eintragen (Platzhalter), alten `sk_live_` rotieren
- `UPLOAD_PASSWORD` aus `.env.example` entfernen
- TEMP-Endpunkte `/block`, `/setcurrent` entfernen
- Echter Stripe-Ladetest (bezahlte Gast-Session mit realem Stromfluss)
- eCarUp-Gegenprobe (OCPP trennen → lädt Auto trotzdem wieder an?)
- Tesla Fleet API (SoC-Anzeige P30X) — OAuth vorhanden, Umsetzung verschoben
- ⚡-Emoji auf welcome-Seite und wb-pill durch Logo ersetzen (optional)
