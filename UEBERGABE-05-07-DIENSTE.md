# Wallbox - Uebergabe 05.07.2026: Nicht-NSSM-Dienste im Dashboard (Tailscale)

## Problem
Im Admin-Dashboard erschienen nur NSSM-Dienste. Tailscale fehlte, weil die
Auto-Discovery in src/services.js nur NSSM-Dienste findet (Registry-Wert
'Application' unter ...\Services\<Name>\Parameters, den nur NSSM setzt).
Tailscale laeuft als eigener Windows-Dienst und fiel durch den Filter.

## Loesung
Neuer optionaler Block 'extraServices' in services.json. Dort gelistete Dienste
werden zusaetzlich angezeigt - mit Live-Status, aber IMMER nur-lesen (kein
Start/Stop). Schutz gegen versehentliches Abschalten des Fernzugriffs.

Merksatz:
- NSSM-Dienste       -> 'services'-Block (nur Anzeigename + Link ergaenzen)
- Alle anderen       -> 'extraServices'-Block (Tailscale etc.)

## Geaenderte Dateien
- src/services.js         : loadConfig() liest extraServices; listServices()
                            mischt NSSM + Extra (Extra: manageable:false,
                            kind:'extra'); Status via sc-Fallback.
- services.json           : Tailscale in extraServices. PC-spezifisch, jetzt
                            in .gitignore, nicht mehr im Repo.
- .gitignore              : services.json ausgeschlossen.
- services.example.json   : NEU - Vorlage fuers Repo (ohne echte Werte).

## Verifiziert (05.07.)
- node -Test liefert Tailscale mit kind:extra, manageable:false, status:running.
- Dashboard zeigt Tailscale (Fernzugriff) mit gruenem Status, Link und Schloss.
- Fuenf Dienste sichtbar: Cloudflare-Tunnel, SmartfoxFronius, SmartfoxTuya,
  Wallbox-Backend, Tailscale.

## Offene Kleinigkeit (kein Handlungsbedarf)
- Dashboard-Ueberschrift heisst noch 'NSSM-Dienste (dieser PC)'. Sauberer waere
  'System-Dienste (dieser PC)'. Einzeilige Aenderung in public/index.html.
