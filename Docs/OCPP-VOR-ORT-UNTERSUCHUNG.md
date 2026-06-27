# OCPP VOR-ORT-UNTERSUCHUNG (Österreich)
**Was an der Keba P30 zu prüfen ist, bevor wir über OCPP entscheiden**

*Stand: Juni 2026 · Für den Vor-Ort-Besuch in Neukirchen · Ziel: Fakten sammeln, dann entscheiden*

---

## Warum diese Untersuchung?

Wir haben recherchiert, welche OCPP-Quellen es gibt. Ergebnis kurz:
- **Keba** dokumentiert die **Box-Seite** (wie man die Box auf ein OCPP-Backend
  einstellt) im offiziellen Konfigurationshandbuch — aber NICHT die Server-Seite.
- **eCarUp** nutzt OCPP, aber ihre Backend-Implementierung ist proprietär und
  nicht öffentlich.
- **evcc** (der Goldstandard für lokale Wallbox-Steuerung) steuert die Keba
  **über Modbus, nicht OCPP** — es gibt also kein OCPP-Keba-Vorbild zum Abschauen.

**Konsequenz:** Es gibt keine fertige Doku, wie ein lokales OCPP-Backend die
Keba genau ansprechen muss. Der einzige verlässliche Weg, das zu lernen, ist:
**der echten Box beim OCPP-Sprechen zuschauen, solange eCarUp noch dran ist.**
eCarUp hat die Keba-OCPP-Eigenheiten gelöst — wenn wir sehen, WAS zwischen Box
und eCarUp ausgetauscht wird, haben wir die Vorlage, die uns sonst niemand gibt.

Diese Anleitung sammelt drei Dinge:
1. **Box-Konfiguration** ablesen (welche OCPP-Einstellungen sind aktiv)
2. **OCPP-Verkehr mitschneiden** (was sendet die Box wirklich)
3. **Modbus-Schreibregister testen** (der Entscheidungspunkt: bleibt Modbus?)

---

## TEIL 1 — Box-Konfiguration ablesen (10 Min, einfach)

Das Keba-Webinterface zeigt die aktiven Einstellungen.

1. IP der Box im Browser öffnen (P30C: `192.168.188.36`, P30X: `192.168.188.63`).
   Login: Webinterface-Passwort (steht auf dem Aufkleber „Wallbox Configuration
   Information", den die Box bei Lieferung hatte).
2. Reiter **„Configuration"** → runterscrollen zum Abschnitt **„OCPP"**.
3. **Abfotografieren / notieren:**
   - [ ] **Central System Address** (die eCarUp-URL — zeigt, wohin die Box spricht)
   - [ ] **Central System Path**
   - [ ] **OCPP-Version** (1.5 / 1.6 — wir erwarten 1.6)
   - [ ] **Transport** (SOAP oder JSON — wir erwarten JSON/WebSocket)
   - [ ] **Chargepoint Identity / EVSE-ID**
   - [ ] **Connection State / Status** (sollte „ONLINE"/„Reachable" sein)
4. Im Reiter **„Configuration"** zusätzlich notieren:
   - [ ] **Firmware-Version** der Box (wichtig — OCPP-Verhalten variiert je Firmware)
   - [ ] Welche **Phasenumschaltung-Quelle** eingestellt ist
         (0=keine, 1=OCPP, 2=REST, 3=Modbus) — verrät den aktiven Steuerweg

> Wichtig: An dieser Stelle NICHTS ändern. Nur ablesen. eCarUp soll vorerst
> weiterlaufen, damit wir den echten Verkehr sehen (Teil 2).

---

## TEIL 2 — OCPP-Verkehr mitschneiden (der wertvollste Teil)

Ziel: sehen, welche OCPP-Nachrichten die Box im Normalbetrieb mit eCarUp
austauscht — vor allem beim **Starten, Laden und Stoppen** einer Ladung.
Das ist die Vorlage für unser eigenes Backend.

### Voraussetzung prüfen: verschlüsselt oder nicht?
In Teil 1 hast du gesehen, ob die Central System Address mit `ws://`
(unverschlüsselt) oder `wss://` (TLS-verschlüsselt) beginnt.
- **`ws://`** → Mitschnitt einfach lesbar (siehe A)
- **`wss://`** → verschlüsselt, Mitschnitt zeigt nur Kauderwelsch. Dann ist
  Variante B (eigenes Backend als Beobachter) der bessere Weg.

### Variante A — Wireshark-Mitschnitt (wenn ws:// unverschlüsselt)

1. Auf dem Wallbox-PC **Wireshark** installieren (https://www.wireshark.org).
2. Optional, macht OCPP lesbar: den **CheckOCPP-Dissector** dazu
   (https://github.com/vfg27/CheckOCPP) — er erkennt OCPP automatisch und
   validiert die Nachrichten. Ohne ihn siehst du die JSON-Frames trotzdem,
   nur nicht so hübsch aufbereitet.
3. Wireshark starten, Netzwerk-Interface wählen, Aufnahme starten.
4. Filter setzen: `tcp.port == 80 || tcp.port == 8080 || websocket`
   (der genaue Port steht in der Central System Address aus Teil 1).
5. **Jetzt eine echte Ladung durchführen:** Auto anstecken, über eCarUp/RFID
   starten, ~1 Minute laden lassen, stoppen, abstecken.
6. Aufnahme stoppen, als `.pcapng` speichern.
7. **Diese Datei mir schicken** (oder die lesbaren OCPP-Frames als Text
   exportieren: Rechtsklick auf einen WebSocket-Frame → „Follow" → „WebSocket
   Stream" → als Text speichern).

**Was uns interessiert** (die Nachrichten, die beim Laden fließen):
- `BootNotification` (Box meldet sich an)
- `StatusNotification` (Zustandswechsel: Available → Preparing → Charging → ...)
- `StartTransaction` / `StopTransaction` (Ladebeginn/-ende mit Zählerstand)
- `MeterValues` (laufende kWh/Leistung — welche Felder genau?)
- die Reaktion auf `RemoteStartTransaction` / Strom-Setzen, falls eCarUp das schickt

### Variante B — Eigenes Lausch-Backend (wenn wss:// oder Variante A zu fummelig)

Eleganter, aber ein kleiner Eingriff: Wir lassen die Box kurz auf ein
**Mitschnitt-Backend von mir** zeigen (das nur zuhört und alles protokolliert,
ohne selbst zu steuern). So sehen wir den Klartext, auch wenn eCarUp wss nutzt.

Ablauf (mache ich vorher fertig, du startest es nur):
1. Ich baue dir ein winziges Node-Skript `ocpp-sniffer.js` (nur Zuhören +
   Mitschreiben, antwortet minimal, damit die Box zufrieden ist).
2. Du startest es am PC: `node ocpp-sniffer.js` (lauscht auf z.B. Port 9000).
3. In der Box (Teil 1, Configuration → OCPP) die Central System Address
   **vorübergehend** auf den PC umbiegen: `ws://192.168.188.34:9000`
   (PC-IP). Die alte eCarUp-Adresse VORHER notieren!
4. Box neu starten, kurz laufen lassen, eine Ladung versuchen.
5. Das Skript schreibt alle Nachrichten in eine Logdatei → die schickst du mir.
6. **Danach die eCarUp-Adresse wieder eintragen** (zurück zum Normalbetrieb).

> Variante B ist der direkteste Weg an die Daten, aber sie unterbricht eCarUp
> kurz. Nur machen, wenn du dir das zutraust und die alte Adresse sicher
> notiert hast. Sonst Variante A.

---

## TEIL 3 — Modbus-Schreibregister testen (der Entscheidungspunkt)

Das ist der eigentliche Knackpunkt für die Entscheidung Modbus vs. OCPP.
Unser fertiges Modbus-System hat drei Schreibregister, die noch nicht an echter
Hardware verifiziert sind (im Code als `[PRUEFEN@PC]` markiert):

- `writeEnable` (Register 5014) — Laden ein/aus
- `writeFailsafe` (Register 5016/5018) — Box stoppt bei Daemon-Stille
- (`writeCurrent` 5004 ist schon verifiziert — der funktioniert)

**Wenn diese Register zuverlässig funktionieren → bleiben wir bei Modbus
(es ist fertig). Wenn sie zicken → ist OCPP der robustere Weg.**

### Test mit einem Modbus-Tool (z.B. „Modbus Poll" oder `mbpoll`)

> Achtung: eCarUp/SmartFox müssen für die Test-Box pausiert sein — die Keba
> bedient nur EINEN Steuer-Client gleichzeitig (Modbus ODER OCPP, nicht beides).
> Am besten an der P30C testen, wenn dort gerade nichts lädt.

Beispiel mit `mbpoll` (Kommandozeile), Box 192.168.188.36:

```
REM Aktuellen Ladestrom setzen (5004, verifiziert — sollte gehen):
mbpoll 192.168.188.36 -a 255 -0 -r 5004 -t 4 6000

REM Enable testen (5014) — schaltet Laden frei/aus:
mbpoll 192.168.188.36 -a 255 -0 -r 5014 -t 4 1
```

- [ ] Reagiert die Box auf `writeEnable`? (Ladefreigabe sichtbar?)
- [ ] Kommt eine Fehlermeldung „illegal data address" (Reg gibt's nicht so)?
- [ ] Failsafe (5016/5018) setzbar ohne Fehler?

> Notiz aus der Recherche: In der evcc-Community taucht bei der Keba gelegentlich
> „illegal data address" und „charger out of sync" auf — genau die Art Problem,
> die für OCPP sprechen würde. Wenn DU das hier siehst, ist das ein starkes
> Signal pro OCPP. Läuft alles sauber → Modbus bleibt.

---

## TEIL 4 — Entscheidung treffen (gemeinsam, nach den Tests)

Mit den Ergebnissen aus Teil 1–3 entscheiden wir fundiert:

| Beobachtung | Spricht für |
|-------------|-------------|
| Modbus-Schreibregister (Teil 3) funktionieren sauber | **Modbus behalten** (fertig, einfach) |
| Modbus-Register zicken (illegal address / out of sync) | **OCPP** (robuster, von eCarUp bewiesen) |
| OCPP-Mitschnitt (Teil 2) zeigt klare, einfache Nachrichten | OCPP machbar mit gutem Bauplan |
| OCPP-Verkehr ist wss-verschlüsselt + komplex | OCPP aufwändiger, Modbus attraktiver |

**Wenn OCPP gewählt wird:** Mit dem Mitschnitt aus Teil 2 baue ich einen
passgenauen OCPP-Server (Bibliothek `ocpp-rpc`), der genau Kebas Nachrichten
beantwortet — statt nach Spezifikation zu raten. Das senkt das Risiko massiv.

**Wenn Modbus bleibt:** Wir haken nur noch die `[PRUEFEN@PC]`-Register ab und
das System ist fertig. Kein Umbau.

---

## Checkliste zum Mitnehmen (kurz)

```
[ ] Teil 1: Box-Webinterface → Configuration → OCPP abfotografieren
            (Address, Path, Version, Transport, Firmware, Phasenquelle)
[ ] Teil 2: OCPP-Verkehr mitschneiden (Wireshark ODER Sniffer-Backend)
            während echter Ladung; Datei/Log an Claude
[ ] Teil 3: Modbus 5014 (enable) + 5016/5018 (failsafe) testen
            → funktioniert? oder „illegal data address"?
[ ] eCarUp-Adresse VORHER notieren, falls in Teil 2 Variante B umgebogen wird
[ ] Nach allen Tests: eCarUp-Normalbetrieb wiederherstellen
[ ] Ergebnisse sammeln → gemeinsam entscheiden
```

> Wenn du in Österreich bist und Variante B (Sniffer-Backend) nutzen willst,
> sag mir vorher Bescheid — dann baue ich dir das `ocpp-sniffer.js` rechtzeitig
> fertig, sodass du es nur noch starten musst.
