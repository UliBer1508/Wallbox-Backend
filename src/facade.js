// ============================================================================
// SCHICHT 3 — DAEMON-FASSADE (facade.js)
// ============================================================================
// Der bezahl-neutrale Vertrag zwischen Daemon-Kern (Schicht 2, manager.js)
// und Abrechnungslayer (Schicht 3b, stripe.js / server.js).
//
// Leitprinzipien (siehe WALLBOX-ARCHITEKTUR-KONZEPT.md, Abschnitt 5):
//   - Kennt "laden", "Strom", "Energie", "Limit" — KEIN Stripe, KEINE
//     PaymentIntents, KEINE Modbus-Register.
//   - Der Abrechnungslayer redet AUSSCHLIESSLICH mit dieser Fassade.
//   - Variante A: gleicher Node-Prozess, Fassade als importiertes Objekt.
//     Aber so diszipliniert gebaut, als wäre es ein eigener Dienst
//     (Variante B) → späterer Umstieg auf HTTP/WS-API trivial.
//
// ---------------------------------------------------------------------------
// ERWARTETES MANAGER-INTERFACE (Schicht 2)
// ---------------------------------------------------------------------------
// Die Fassade bekommt den Manager per Dependency Injection übergeben.
// manager.js muss folgende Methoden bereitstellen (async erlaubt):
//
//   getState(wallboxId)                 → StateObjekt einer Box
//   getAllState()                       → { wallboxen: {...}, sessions: [...] }
//   requestCharge(wallboxId, options)   → { sessionId, ... }  (Vormerkung)
//   startCharge(wallboxId, sessionId)   → void | StateObjekt
//   stopCharge(wallboxId, sessionId)    → void | StateObjekt
//   setCurrent(wallboxId, milliampere)  → void
//   cancelRequest(wallboxId, sessionId) → void
//
// Und folgende Events feuern (EventEmitter):
//
//   chargingStarted(wallboxId, sessionId)
//   energyUpdated(wallboxId, sessionId, kWh, betrag)
//   limitReached(wallboxId, sessionId)
//   chargingStopped(wallboxId, sessionId, finalKWh)
//   cableDisconnected(wallboxId, sessionId)
//   errorOccurred(wallboxId, code, details)
//   connectionLost(wallboxId)
//   connectionRestored(wallboxId)
//
// Fehlen Methoden, schlägt der Konstruktor sofort und laut fehl —
// damit Integrationsfehler beim Start auffallen, nicht erst zur Laufzeit.
// ============================================================================

import { EventEmitter } from 'node:events';

// --- Vertragskonstanten ------------------------------------------------------

/** Lademodi, die die Fassade kennt. */
export const MODUS = Object.freeze({
  VOLL: 'voll',
  LIMIT: 'limit',
});

/** Events, die die Fassade vom Manager nach oben durchreicht (Whitelist). */
export const FACADE_EVENTS = Object.freeze([
  'chargingStarted',
  'energyUpdated',
  'limitReached',
  'chargingStopped',
  'cableDisconnected',
  'cablePlugged',      // Auto eingesteckt (fuer Gratis-Dokumentation bei Bezahlung AUS)
  'errorOccurred',
  'connectionLost',
  'connectionRestored',
  'waitingForCar',     // bezahlt, wartet auf Anstecken des Autos
  'waitTimeout',       // kein Auto in der Wartezeit -> Reservierung freigeben
  'requestCancelled',  // Vormerkung/Warte abgebrochen -> Reservierung freigeben
]);

/** Methoden, die der injizierte Manager bereitstellen MUSS. */
const REQUIRED_MANAGER_METHODS = Object.freeze([
  'getState',
  'getAllState',
  'requestCharge',
  'startCharge',
  'stopCharge',
  'setCurrent',
  'cancelRequest',
]);

// --- Fehlerklasse -------------------------------------------------------------

/**
 * Einheitlicher Fehlertyp der Fassade.
 * code: maschinenlesbar (z.B. für HTTP-Statusmapping in server.js)
 */
export class FacadeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FacadeError';
    this.code = code;
  }
}

// --- Fassade -------------------------------------------------------------------

export class WallboxFacade extends EventEmitter {
  /**
   * @param {object} manager   Schicht-2-Instanz (siehe Interface oben)
   * @param {object} [options]
   * @param {Array<number|string>} [options.wallboxIds]  Gültige Box-IDs (Default: [1, 2])
   * @param {number} [options.minCurrentA]  Minimaler Ladestrom in A (Default: 6)
   * @param {number} [options.maxCurrentA]  Maximaler Ladestrom in A (Default: 32)
   *
   * Hinweis: min/max kommen später aus den Admin-Settings (Gruppe A) —
   * dann beim Erzeugen der Fassade aus der settings-Tabelle übergeben
   * bzw. via updateLimits() nachziehen.
   */
  constructor(manager, options = {}) {
    super();

    if (!manager || typeof manager !== 'object') {
      throw new FacadeError('MANAGER_MISSING', 'WallboxFacade: Manager-Instanz fehlt.');
    }

    const fehlend = REQUIRED_MANAGER_METHODS.filter(
      (m) => typeof manager[m] !== 'function'
    );
    if (fehlend.length > 0) {
      throw new FacadeError(
        'MANAGER_INTERFACE',
        `WallboxFacade: Manager implementiert nicht: ${fehlend.join(', ')}`
      );
    }

    this._manager = manager;
    this._wallboxIds = new Set(
      (options.wallboxIds ?? [1, 2]).map((id) => String(id))
    );
    this._minCurrentA = options.minCurrentA ?? 6;
    this._maxCurrentA = options.maxCurrentA ?? 32;

    this._wireEvents();
  }

  // --- Events durchreichen (nur Whitelist) ----------------------------------

  _wireEvents() {
    if (typeof this._manager.on !== 'function') {
      // Manager ohne EventEmitter: tolerieren, aber Events gibt es dann nicht.
      // Bewusst kein Fehler — Polling via getState() bleibt möglich.
      return;
    }
    for (const ev of FACADE_EVENTS) {
      this._manager.on(ev, (...args) => this.emit(ev, ...args));
    }
  }

  // --- Validierungs-Helfer ---------------------------------------------------

  _checkWallboxId(wallboxId) {
    if (wallboxId === undefined || wallboxId === null || !this._wallboxIds.has(String(wallboxId))) {
      throw new FacadeError(
        'WALLBOX_UNKNOWN',
        `Unbekannte Wallbox-ID: ${wallboxId}. Gültig: ${[...this._wallboxIds].join(', ')}`
      );
    }
  }

  _checkSessionId(sessionId) {
    if (
      sessionId === undefined ||
      sessionId === null ||
      (typeof sessionId !== 'string' && typeof sessionId !== 'number') ||
      String(sessionId).trim() === ''
    ) {
      throw new FacadeError('SESSION_INVALID', `Ungültige Session-ID: ${sessionId}`);
    }
  }

  // --- Limits zur Laufzeit aktualisierbar (Admin-Settings, Gruppe A) ---------

  /**
   * Min/Max-Ladestrom nachziehen, z.B. nach POST /api/settings.
   */
  updateLimits({ minCurrentA, maxCurrentA } = {}) {
    if (minCurrentA !== undefined) {
      if (!Number.isFinite(minCurrentA) || minCurrentA < 6) {
        throw new FacadeError('LIMIT_INVALID', `minCurrentA ungültig: ${minCurrentA} (>= 6 A)`);
      }
      this._minCurrentA = minCurrentA;
    }
    if (maxCurrentA !== undefined) {
      if (!Number.isFinite(maxCurrentA) || maxCurrentA > 63) {
        throw new FacadeError('LIMIT_INVALID', `maxCurrentA ungültig: ${maxCurrentA} (<= 63 A)`);
      }
      this._maxCurrentA = maxCurrentA;
    }
    if (this._minCurrentA > this._maxCurrentA) {
      throw new FacadeError(
        'LIMIT_INVALID',
        `minCurrentA (${this._minCurrentA}) > maxCurrentA (${this._maxCurrentA})`
      );
    }
  }

  // --- Befehle (Abrechnungslayer → Daemon) ------------------------------------

  /**
   * Aktueller Zustand einer Box (Zustand, Strom, Energie, verbunden).
   */
  async getState(wallboxId) {
    this._checkWallboxId(wallboxId);
    return this._manager.getState(wallboxId);
  }

  /**
   * Zustand beider Boxen + laufende Sessions.
   */
  async getAllState() {
    return this._manager.getAllState();
  }

  /**
   * Ladevorgang vormerken (noch KEIN Stromfluss).
   * Der Abrechnungslayer ruft das VOR der Zahlungsautorisierung auf.
   *
   * @param {number|string} wallboxId
   * @param {object} options
   * @param {'voll'|'limit'} options.modus
   * @param {number} [options.limit]  Pflicht bei modus='limit'. Limit in kWh.
   * @returns {Promise<{sessionId: string|number}>}
   */
  async requestCharge(wallboxId, { modus, limit } = {}) {
    this._checkWallboxId(wallboxId);

    if (modus !== MODUS.VOLL && modus !== MODUS.LIMIT) {
      throw new FacadeError(
        'MODUS_INVALID',
        `Ungültiger Modus: ${modus}. Erlaubt: '${MODUS.VOLL}' | '${MODUS.LIMIT}'`
      );
    }

    if (modus === MODUS.LIMIT) {
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new FacadeError(
          'LIMIT_INVALID',
          `Modus 'limit' braucht ein positives Limit (kWh), erhalten: ${limit}`
        );
      }
    }

    // FIX (Integrationstest 11.06.): manager.js erwartet das Limit als
    // `limitKwh`, die Fassade nennt es nach außen `limit`. Hier übersetzen,
    // sonst greift der Auto-Stopp am Limit nie (limitKwh bliebe undefined → 0).
    const result = await this._manager.requestCharge(wallboxId, { modus, limitKwh: limit });
    if (!result || result.sessionId === undefined) {
      throw new FacadeError(
        'MANAGER_RESULT',
        'requestCharge: Manager hat keine sessionId zurückgegeben.'
      );
    }
    return result;
  }

  /**
   * Tatsächlich Laden starten — NACH erfolgreicher Freigabe durch den
   * Abrechnungslayer (z.B. Stripe-Vorautorisierung erfolgreich).
   */
  async startCharge(wallboxId, sessionId, maxAmpere) {
    this._checkWallboxId(wallboxId);
    this._checkSessionId(sessionId);
    return this._manager.startCharge(wallboxId, sessionId, maxAmpere);
  }

  /**
   * Laden beenden (Gast drückt "Beenden", Admin-Stopp, etc.).
   */
  async stopCharge(wallboxId, sessionId) {
    this._checkWallboxId(wallboxId);
    this._checkSessionId(sessionId);
    return this._manager.stopCharge(wallboxId, sessionId);
  }

  /**
   * Ladestrom anpassen.
   * WICHTIG: Fassade spricht AMPERE (Mensch/Settings-Ebene).
   * Umrechnung in mA passiert HIER — Schicht 2 und 1 arbeiten in mA.
   *
   * @param {number} ampere  Ganzzahl oder Dezimal, innerhalb min/max
   */
  async setCurrent(wallboxId, ampere) {
    this._checkWallboxId(wallboxId);

    if (!Number.isFinite(ampere)) {
      throw new FacadeError('CURRENT_INVALID', `Ladestrom keine Zahl: ${ampere}`);
    }
    if (ampere < this._minCurrentA || ampere > this._maxCurrentA) {
      throw new FacadeError(
        'CURRENT_RANGE',
        `Ladestrom ${ampere} A außerhalb erlaubt ${this._minCurrentA}–${this._maxCurrentA} A`
      );
    }

    const milliampere = Math.round(ampere * 1000);
    return this._manager.setCurrent(wallboxId, milliampere);
  }

  /**
   * Vormerkung verwerfen (Zahlung abgebrochen, Auth-Timeout, Gast weg).
   */
  async cancelRequest(wallboxId, sessionId) {
    this._checkWallboxId(wallboxId);
    this._checkSessionId(sessionId);
    return this._manager.cancelRequest(wallboxId, sessionId);
  }
}

export default WallboxFacade;
