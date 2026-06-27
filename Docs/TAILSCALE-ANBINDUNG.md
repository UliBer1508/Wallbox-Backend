# TAILSCALE-ANBINDUNG.md
## Fernzugriff: Wallbox-PC (Österreich) ↔ PC (Hamburg) ↔ Handy

**Stand:** 10. Juni 2026
**Zweck:** Privates VPN-Mesh-Netz zwischen allen drei Geräten. Damit ist der
Wallbox-PC in Neukirchen jederzeit aus Hamburg (und vom Handy) erreichbar —
ohne Portfreigaben am Router, ohne feste IP, ohne den Cloudflare-Tunnel anzufassen.

> **Das ist der bisherige „Punkt 0" aus PC-AUFGABEN.md.**
> Tailscale + Remotedesktop ersetzt AnyDesk/RustDesk als Fernzugriffslösung
> und schaltet alle weiteren Remote-Arbeiten frei (NSSM, server.js-Anpassungen,
> Lade-Test-Begleitung etc.).

---

## 1. Was Tailscale macht (Kurzfassung)

- Jedes Gerät bekommt eine feste private IP im Bereich `100.x.x.x`
- Geräte finden sich direkt (Peer-to-Peer, WireGuard-verschlüsselt)
- Funktioniert hinter jedem Router/NAT — **keine Portfreigabe nötig**
- Kostenlos für bis zu 3 Benutzer / 100 Geräte (Personal-Plan) — reicht locker
- Der bestehende Cloudflare-Tunnel für die Gäste bleibt **unverändert** —
  Tailscale ist nur für DICH (Admin-Zugriff), nicht für Gäste

```
   Handy (Tailscale-App)          PC Hamburg (Tailscale)
        \                              /
         \                            /
          ───── Tailscale-Netz ──────
                      |
                      v
        Wallbox-PC Neukirchen (Tailscale, 24/7)
        → RDP, Dateizugriff, localhost:8080
```

---

## 2. Voraussetzung EINMALIG am Wallbox-PC (vor Ort oder per TeamViewer-Ersatz)

Wie immer gilt: Die allererste Installation braucht jemanden AM PC.
Danach läuft alles remote.

- [ ] **Windows-Edition prüfen:** `winver` ausführen
  - **Windows 10/11 Pro:** Remotedesktop (RDP) ist eingebaut → Plan A unten
  - **Windows 10/11 Home:** KEIN RDP-Host! → Plan B (RustDesk über Tailscale)

---

## 3. Schritt-für-Schritt

### Schritt 1 — Tailscale-Konto anlegen (5 Min, von überall)
- [ ] https://login.tailscale.com → „Sign up"
- [ ] Anmeldung mit bestehendem Google- oder Microsoft-Konto (kein neues Passwort nötig)
- [ ] Personal-Plan (kostenlos) wählen

### Schritt 2 — Wallbox-PC Österreich (15 Min, AM PC)
- [ ] https://tailscale.com/download/windows → Installer laden und ausführen
- [ ] Mit dem Konto aus Schritt 1 anmelden (Browser öffnet sich)
- [ ] **WICHTIG — Stolperfalle Nr. 1:** Im Tailscale-Tray-Icon (Taskleiste):
      Rechtsklick → **„Run unattended" aktivieren** (bzw. Settings → „Run unattended")
      → Ohne das läuft Tailscale nur, solange ein Benutzer angemeldet ist!
      Mit „unattended" läuft es als Dienst — auch nach Neustart, ohne Login.
- [ ] **WICHTIG — Stolperfalle Nr. 2:** Key-Ablauf deaktivieren:
      https://login.tailscale.com/admin/machines → Wallbox-PC → „…"-Menü →
      **„Disable key expiry"**
      → Sonst verlangt Tailscale nach ~180 Tagen eine Neuanmeldung AM PC —
      genau das Remote-Dilemma, das wir vermeiden wollen!
- [ ] Tailscale-IP des PCs notieren (Tray-Icon → zeigt `100.x.x.x`)
      Hier eintragen: `100.___.___.___`
- [ ] Gerätename in der Admin-Konsole ggf. umbenennen auf `wallbox-pc`
      (dann erreichbar als `wallbox-pc` dank MagicDNS)

### Schritt 3 — Fernsteuerung am Wallbox-PC aktivieren (AM PC)

**Plan A — Windows Pro (RDP):**
- [ ] Einstellungen → System → Remotedesktop → **Aktivieren**
- [ ] Benutzerkonto `ulibe` muss ein **Passwort** haben (RDP ohne Passwort geht nicht)
- [ ] KEINE Portfreigabe am Router machen! RDP läuft nur übers Tailscale-Netz —
      von außen (Internet) bleibt der Port unsichtbar. Das ist sicher.

**Plan B — Windows Home (RustDesk):**
- [ ] https://rustdesk.com → Windows-Client laden, installieren
- [ ] „Install as service" bestätigen (Autostart)
- [ ] Festes Passwort in RustDesk setzen (Settings → Security → Permanent Password)
- [ ] RustDesk-ID notieren: `___________`

### Schritt 4 — PC Hamburg (10 Min)
- [ ] Tailscale installieren (gleicher Download-Link)
- [ ] Mit DEMSELBEN Konto anmelden
- [ ] Test: `ping 100.x.x.x` (IP des Wallbox-PCs) → muss antworten

### Schritt 5 — Handy (5 Min)
- [ ] Tailscale-App aus App Store / Play Store
- [ ] Mit demselben Konto anmelden
- [ ] VPN-Berechtigung erlauben
- [ ] Hinweis: Tailscale am Handy nur einschalten, wenn gebraucht
      (läuft sonst dauerhaft als VPN, kostet minimal Akku)

### Schritt 6 — Verbindungstest (von Hamburg aus)
- [ ] **RDP-Test (Plan A):** `mstsc` öffnen → Computer: `100.x.x.x` (oder `wallbox-pc`)
      → Anmelden als `ulibe` → Desktop des Wallbox-PCs erscheint
- [ ] **RustDesk-Test (Plan B):** RustDesk öffnen → ID eingeben → Passwort → verbunden
- [ ] **Backend-Test:** Im Browser am Hamburg-PC:
      `http://100.x.x.x:8080/api/state` → muss JSON liefern
      (= direkter Zugriff aufs Backend OHNE Cloudflare-Umweg!)
- [ ] **Handy-Test:** Tailscale-App an → Browser → `http://100.x.x.x:8080`

---

## 4. Was danach alles möglich ist

| Aufgabe aus PC-AUFGABEN.md | Vorher | Mit Tailscale |
|---|---|---|
| NSSM installieren + Backend-Dienst | nur vor Ort | per RDP von Hamburg ✅ |
| server.js bearbeiten (/api/login, /api/upload) | Dateitransfer-Krücken | direkt am PC per RDP ✅ |
| Falsche Domain löschen, Stripe-Key prüfen | Browser am PC nötig | per RDP ✅ |
| Logs/CMD-Fenster prüfen | unmöglich | per RDP ✅ |
| Admin-Dashboard sicher aufrufen | über öffentliche URL | privat via `100.x:8080` ✅ |
| Lade-Test begleiten | — | Handy vor der Wallbox + RDP parallel ✅ |

**Bonus:** Das Admin-Dashboard muss langfristig gar nicht öffentlich erreichbar
sein. Per Tailscale kannst du es privat nutzen — der offene Punkt
„Admin-Dashboard mit Passwortschutz" wird dadurch entschärft (Gäste-Seite
bleibt natürlich öffentlich über den Cloudflare-Tunnel).

---

## 5. Sicherheits-Hinweise

- Tailscale-Netz ist privat: Nur Geräte, die mit DEINEM Konto angemeldet sind,
  kommen rein. Niemand sonst sieht die `100.x`-Adressen.
- Das Konto (Google/Microsoft-Login) ist jetzt der Schlüssel zum Wallbox-PC →
  **2-Faktor-Authentifizierung am Google/Microsoft-Konto aktivieren**, falls
  noch nicht geschehen.
- Keine Router-Portfreigaben machen — weder für RDP (3389) noch sonst etwas.
- Cloudflare-Tunnel, config.yml, .env: bleiben alle UNVERÄNDERT.

---

## 6. Spickzettel

```
Admin-Konsole:        https://login.tailscale.com/admin/machines
Wallbox-PC IP:        100.___.___.___   (nach Schritt 2 eintragen)
RDP von Hamburg:      mstsc → 100.x.x.x  (Benutzer: ulibe)
Backend direkt:       http://100.x.x.x:8080
Status am PC prüfen:  tailscale status   (in CMD)
```

---

## 7. Eintrag für PC-AUFGABEN.md

Diesen Block in PC-AUFGABEN.md als neuen Punkt 0 übernehmen:

```markdown
### Punkt 0 — Fernzugriff via Tailscale (NEU, ersetzt AnyDesk-Plan)
- [ ] winver: Windows Pro oder Home? (entscheidet RDP vs. RustDesk)
- [ ] Tailscale installieren + anmelden (Konto: siehe TAILSCALE-ANBINDUNG.md)
- [ ] „Run unattended" aktivieren (Tray-Icon) — PFLICHT für 24/7!
- [ ] Key expiry deaktivieren (Admin-Konsole) — PFLICHT!
- [ ] RDP aktivieren (Pro) ODER RustDesk als Dienst (Home)
- [ ] Tailscale-IP notieren und in TAILSCALE-ANBINDUNG.md eintragen
- [ ] Test von Hamburg: ping + RDP + http://100.x:8080/api/state
→ Details: TAILSCALE-ANBINDUNG.md
```

---

*Geschätzter Gesamtaufwand: ~30 Minuten am Wallbox-PC, ~15 Minuten in Hamburg/Handy.*
*Danach ist die „Erste-Aktion-muss-am-PC-sein"-Hürde dauerhaft Geschichte.*
