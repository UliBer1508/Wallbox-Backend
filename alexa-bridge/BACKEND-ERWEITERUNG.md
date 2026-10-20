# Hinweis: Admin-Start meldet 400, obwohl er funktioniert

`POST /api/wallbox/:id/start` legt die Session an und geht in „Warten auf Auto“.
Danach ruft der Endpunkt `facade.setCurrent(...)` auf – das ist nur im Zustand
CHARGING erlaubt und wirft „Nicht im Ladezustand.“. Ergebnis: Antwort 400,
obwohl die Session korrekt angelegt ist. Das betrifft auch den Start-Button im
Wallbox Manager.

Die Alexa-Bridge (ab 2.0.1) erkennt diesen Fall selbst. Sauberer ist es, im
Backend in `src/server.js` im Start-Endpunkt die Zeile

```js
      await facade.setCurrent(id, ampere);
```

zu ersetzen durch:

```js
      // Strom erst setzbar, wenn das Auto lädt (Session wartet zunächst auf das Auto)
      await facade.setCurrent(id, ampere).catch(() => {});
```

---

# Optionale Backend-Erweiterung: Ladestrom ändern ohne Neustart

Ohne diese Erweiterung funktioniert die Alexa-Bridge vollständig. Ein Prozent-Befehl
während einer laufenden Ladung („Alexa, stelle Auto-Laden auf 50 Prozent“) beendet
dann aber die Session und startet sofort eine neue mit dem neuen Strom. Im Verlauf
stehen dadurch zwei Sessions.

Mit diesem kleinen Endpunkt ändert die Bridge den Strom direkt in der laufenden Session.

## Einbau in `src/server.js`

Direkt **nach** dem Block `app.post('/api/wallbox/:id/stop', ...)` einfügen:

```js
  // --- Ladestrom einer laufenden Session ändern (Alexa-Bridge) ---
  app.post('/api/wallbox/:id/current', requireAdmin, async (req, res) => {
    try {
      const id = req.params.id;
      const ampere = Number(req.body?.current);
      await facade.setCurrent(id, ampere);   // prüft min/max aus config.js
      db.log('current_set', { wallboxId: id, details: { current: ampere, by: req.admin?.username } });
      res.json({ ok: true, wallboxId: id, current: ampere });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
```

Danach den Dienst neu starten (Admin-PowerShell):

```powershell
net stop WallboxBackend
net start WallboxBackend
net stop alexa-bridge
net start alexa-bridge
```

Die Bridge prüft beim ersten Prozent-Befehl, ob der Endpunkt vorhanden ist, und merkt sich das bis zum nächsten Neustart. Deshalb die Bridge nach dem Einbau einmal neu starten.
