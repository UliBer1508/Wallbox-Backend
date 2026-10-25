// src/config.js
//
// Default-Werte aller Schichten
// =============================
// Diese Werte sind NUR die Startbelegung. Sobald die settings-Tabelle
// in SQLite angebunden ist (Phase 3 im Konzept), ueberschreiben die
// DB-Settings diese Defaults — Aenderungen passieren dann im Admin
// (index.html), nicht hier im Code.
//
// Secrets (Stripe-Keys, UPLOAD_PASSWORD) leben NICHT hier, sondern
// ausschliesslich in der .env.
//
// Gruppierung folgt dem Einstellungs-Katalog aus
// WALLBOX-ARCHITEKTUR-KONZEPT.md (Gruppen A-D).

// --- Gruppe A: Hardware (pro Wallbox) ------------------------------

export const wallboxes = [
  {
    id: 'p30c',
    name: 'P30C Gaeste',
    host: '192.168.188.36',
    port: 502,
    unitId: 255,
    active: true,              // Gaeste-Box: wird gesteuert
    minCurrentA: 6,
    maxCurrentA: 16,
    failsafeTimeoutSec: 30,    // Box stoppt selbst bei Daemon-Stille [PRUEFEN@PC]
                               // (nur bei Bezahlung AN aktiv; 0 = Failsafe nie nutzen)
    failsafeFallbackA: 0,      // 0 A: faellt das Backend aus, laedt NIEMAND gratis
                               // (frueher 6 A = Gratis-Laden bei Backend-Ausfall)
  },
  {
    id: 'p30x',
    name: 'P30X Tesla',
    host: '192.168.188.63',
    port: 502,
    unitId: 255,
    active: true,              // Gaeste-Box: wird gesteuert (wie P30C).
                               // ACHTUNG VOR ORT: eCarUp von P30X trennen
                               // (OCPP-Single-Backend) + SmartFox-Freigabe,
                               // sonst Steuer-Konflikt. Siehe Doku.
    minCurrentA: 6,
    maxCurrentA: 16,
    failsafeTimeoutSec: 30,    // Box stoppt selbst bei Daemon-Stille [PRUEFEN@PC]
                               // (nur bei Bezahlung AN aktiv; 0 = Failsafe nie nutzen)
    failsafeFallbackA: 0,      // 0 A: faellt das Backend aus, laedt NIEMAND gratis
                               // (frueher 6 A = Gratis-Laden bei Backend-Ausfall)
  },
];

// --- Gruppe B: Middle-Layer / Prozesslogik --------------------------

export const middle = {
  pollIdleSec: 10,        // Polling im Leerlauf (langsam)
  pollActiveSec: 3,       // Polling waehrend Ladung (schnell)
  sessionTimeoutMin: 720, // haengende Session nach X min abschliessen
  authTimeoutMin: 15,     // unbezahlte Vormerkung (REQUESTED) nach X min verwerfen
  reconnectTries: 5,      // Reconnect-Versuche pro Zyklus
  backoffBaseSec: 2,      // Backoff-Basis zwischen Versuchen
  guardDurationSec: 30,   // Schuetz-Schonung: Warnung bei schnellerem Schalten
  stopForceSec: 30,       // Stopp greift nicht -> nach X s Session erzwungen beenden + sperren
  // Benachrichtigung (Empfaenger: NOTIFY_EMAIL in .env)
  notifyStartupQuietSec: 60,  // nach Backend-Start X s keine Einsteck-Mails
  notifyPlugDelaySec: 15,     // Einsteck-Mail X s verzoegert (zeigt, ob Sperre greift)
  notifyPlugDebounceMin: 10,  // max. 1 Einsteck-Mail pro Box in X Min
};

// --- Gruppe C: Bezahlsystem ------------------------------------------
// Keys (sk_live/sk_test) NIEMALS hier — nur in .env!

export const payment = {
  pricePerKwh: 0.45,      // EUR
  reserveAmountEur: 35,   // Reservierung "Voll laden"
  currency: 'eur',
  stripeMode: 'test',     // 'test' | 'live' (nur Umschaltung, Keys via .env)
  minCaptureEur: 0.5,     // Stripe-Mindestbetrag fuer Capture
};

// --- Gruppe D: System -------------------------------------------------

export const system = {
  httpPort: 8080,
};

export default { wallboxes, middle, payment, system };
