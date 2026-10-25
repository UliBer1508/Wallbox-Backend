# Abrechnungsschutz + Einsteck-Mail — 25.10.2026

**Status:** EINGESPIELT + auf GitHub (Commit `01a8ef3`, 25.10. 07:32). Sandbox-Test 31/31 bestanden.
Nach Neustart: `mail_verify_ok`, keine Fehler (kein `FAILSAFE_FAILED`). Backup alter Stand: `src-backup-25-10/` auf dem Mini-PC.
P30C: Bezahlung AN. P30X: Bezahlung AUS (Tesla, war durch alte Auto-Rücksetzung vom 21.10. gesperrt).

## Ziele (Uli)
1. Bezahlung AN → Laden nur nach Bezahlung.
2. Mail an steinbockchalets@gmail.com + uli.berresheim@hotmail.de, wenn bei Bezahlung AN ein Auto angesteckt wird.
3. Bezahlung AUS = Uli selbst: keine Sperre, keine Mails, kein automatisches Zurückschalten.

## Behobene Lücken
1. Auto-Rücksetzung des Bezahl-Schalters entfernt (setzte nur DB, nicht Manager → Anzeige „an", Box offen; nach Neustart Tesla gesperrt — so passiert am 21.10./25.10.).
2. Aufräumer schließt keine Sessions mehr, die der Manager hält (Warten/Laden/Stoppen); REQUESTED wird über den Manager abgebrochen.
3. **Stopp-Race:** Gast-Stopp lief über zwei Wege, einer meldete `chargingStopped` ohne Session-ID → server.js schloss die Session → `settle()` buchte nichts ab. Im echten Betrieb belegt (`SETTLE_FAILED Session undefined` am 20.06.). Behoben.
4. Failsafe: Fallback 0 A + Heartbeat bei jedem Poll (Bezahlung AN), Failsafe aus bei Bezahlung AUS.
5. STOPPING: Stopp wird wiederholt, nach 30 s erzwungen + Alarm-Mail.
6. Einsteck-Erkennung steht jetzt vor der Sperre (Ereignis ging bei sofort ladendem Auto verloren).
7. Wartezustand: Modbus-Fehler bei Freigabe → kein ewiges Hängen; Stopp im Warten = Abbruch (erklärt Fehler 3.3 vom 21.10.).
8. Bezahlung AUS: Box nach Abbruch/Timeout/Abstecken wieder frei.
9. Admin-Start: kein HTTP 400 mehr (Fehler 3.1).

## Mail
- Auslöser `cablePlugged` bei Bezahlung AN, 15 s verzögert, max. 1 pro Box/10 Min, 60 s Ruhe nach Start.
- Alarm-Mail bei `LOCK_FAILED` / `STOP_FORCED` (max. 1 pro 30 Min).
- Empfänger: `NOTIFY_EMAIL` in `.env` (kommagetrennt), gesetzt.

## Logs abfragen (Admin-UI hat keine Ansicht)
PowerShell: Login-Token holen, dann `/api/logs?limit=20` bzw. `/api/errors?limit=20` mit Header `X-Auth-Token`.

## Noch offen
- Erste echte bezahlte Ladung > 30 s beobachten (Failsafe-Heartbeat). Bei Abbruch: `failsafeTimeoutSec: 0` in config.js.
- Fremdes Auto an P30C (vor Ort): lädt nicht, Mail kommt nach ~15 s.
- eCarUp/OCPP an den Boxen weiterhin ungeklärt.
- Sicherheit: Admin-Passwort ändern (steht im öffentlichen Repo), Gmail-App-Passwort erneuern (war im Chat), Repo privat.
- `src-backup-25-10/` nach erfolgreicher Ladung löschen.
