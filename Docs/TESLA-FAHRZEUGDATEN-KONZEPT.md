# Tesla-Fahrzeugdaten — Konzept-Notiz (zurückgestellt)

**Stand:** 19.06.2026 · **Status:** bewusst NICHT umgesetzt

## Idee
Zusätzliche Fahrzeug-Infos vom eigenen Tesla (P30X) zur Anzeige im Admin: vor allem
**Batterie-Ladestand (SOC) und Ziel-Ladestand** — die einzige Info, die die Wallbox
selbst nicht liefert (Box weiß nur „Strom fließt", nicht „Akku 64 %, Ziel 80 %").
Dazu Lade-Status und Reichweite.

## Quelle
Tesla Fleet API über MyTeslaMate Cloud Proxy (wie im evcc-Setup München).
Nur **lesen**, kein Steuern.

## Wichtige Randbedingungen
- Funktioniert **nur für den eigenen Tesla** (P30X) — Gäste-Fahrzeuge an P30C
  nicht auslesbar (andere Marken, kein Zugang).
- **Strikt getrennt vom Lade-Daemon** — reine Anzeige-Quelle für Schicht 4,
  greift nie in Schicht 1–3 ein. Fällt sie aus, lädt das System unbeeindruckt weiter.
- **Credit-Kosten** sind der Knackpunkt: jeder Abruf kostet, Auto aufwecken kostet
  das 20-fache. Daher: nur bei angestecktem Auto, langsames Intervall (Minuten),
  letzten Wert cachen, niemals aktiv `wake_up`.

## Warum zurückgestellt
**Viel Aufwand für wenig Mehrwert** — dieselben Infos (SOC etc.) sieht Uli ohnehin
direkt in der **Tesla-App**. Lohnt sich erst, falls die Daten mal automatisiert im
Admin neben den Lade-Infos stehen sollen.

## Falls später doch
Bricht die Architektur nicht, wenn als separate Lese-Quelle gebaut. Widerspricht
aber dem Nicht-Ziel §11 (kein fahrzeugseitiges Management) — daher bewusst nur als
optionales Extra für die eigene Box, nie im Gäste-Flow.
