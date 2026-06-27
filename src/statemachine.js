// src/statemachine.js
//
// SCHICHT 2a — Zustandsautomat (pro Wallbox)
// ==========================================
// Reiner, hardwarefreier Zustandsautomat. Kennt KEINE Modbus, KEINE
// Stripe, KEINE Timer. Nur: erlaubte Zustaende und erlaubte Uebergaenge.
// Dadurch isoliert testbar.
//
// Zustaende (aus Konzept Abschnitt 4.1):
//   IDLE -> REQUESTED -> CHARGING -> STOPPING -> IDLE
//   jeder Zustand kann nach ERROR; ERROR -> IDLE (nach Aufraeumen)
//
// ES-Modul.

export const STATES = {
  IDLE: 'IDLE',           // nichts los, bereit
  REQUESTED: 'REQUESTED', // Ladevorgang vorgemerkt, wartet auf Freigabe/Zahlung
  WAITING_FOR_CAR: 'WAITING_FOR_CAR', // bezahlt, wartet auf Anstecken des Autos
  CHARGING: 'CHARGING',   // laedt aktiv
  STOPPING: 'STOPPING',   // wird beendet (Abschluss/Capture laeuft)
  ERROR: 'ERROR',         // Fehlerzustand, muss aufgeraeumt werden
};

// Erlaubte Uebergaenge: vonZustand -> Set erlaubter Zielzustaende
const TRANSITIONS = {
  [STATES.IDLE]:      new Set([STATES.REQUESTED, STATES.ERROR]),
  // REQUESTED -> WAITING_FOR_CAR (bezahlt, wartet auf Anstecken);
  //   IDLE = abgebrochen/Timeout vor dem Anstecken
  [STATES.REQUESTED]: new Set([STATES.WAITING_FOR_CAR, STATES.IDLE, STATES.ERROR]),
  // WAITING_FOR_CAR -> CHARGING (Auto steckt + Strom fliesst);
  //   IDLE = Gast bricht ab oder 10-Min-Timeout, ohne dass je geladen wurde
  [STATES.WAITING_FOR_CAR]: new Set([STATES.CHARGING, STATES.IDLE, STATES.ERROR]),
  [STATES.CHARGING]:  new Set([STATES.STOPPING, STATES.ERROR]),
  [STATES.STOPPING]:  new Set([STATES.IDLE, STATES.ERROR]),
  [STATES.ERROR]:     new Set([STATES.IDLE]),
};

export class ChargeStateMachine {
  /**
   * @param {string} [initial] Startzustand (Default IDLE) - fuer
   *        Wiederherstellung nach Daemon-Neustart aus DB nutzbar.
   */
  constructor(initial = STATES.IDLE) {
    if (!STATES[initial] && !Object.values(STATES).includes(initial)) {
      throw new Error(`Ungueltiger Startzustand: ${initial}`);
    }
    this._state = initial;
    this._history = [{ state: initial, ts: Date.now(), reason: 'init' }];
  }

  get state() {
    return this._state;
  }

  get history() {
    return this._history.slice();
  }

  /** Prueft, ob ein Uebergang erlaubt waere (ohne ihn auszufuehren). */
  canTransition(to) {
    const allowed = TRANSITIONS[this._state];
    return !!allowed && allowed.has(to);
  }

  /**
   * Fuehrt einen Uebergang aus. Wirft bei ungueltigem Uebergang.
   * @param {string} to     Zielzustand
   * @param {string} [reason] Begruendung (fuers Log/History)
   * @returns {{from, to, ts}} der vollzogene Uebergang
   */
  transition(to, reason = '') {
    if (!Object.values(STATES).includes(to)) {
      throw new Error(`Unbekannter Zielzustand: ${to}`);
    }
    if (!this.canTransition(to)) {
      throw new Error(`Ungueltiger Uebergang: ${this._state} -> ${to}`);
    }
    const from = this._state;
    this._state = to;
    const entry = { state: to, from, ts: Date.now(), reason };
    this._history.push(entry);
    // History begrenzen (Speicher schonen)
    if (this._history.length > 100) this._history.shift();
    return { from, to, ts: entry.ts };
  }

  /** Bequeme Abfragen */
  isIdle()      { return this._state === STATES.IDLE; }
  isCharging()  { return this._state === STATES.CHARGING; }
  isWaitingForCar() { return this._state === STATES.WAITING_FOR_CAR; }
  isError()     { return this._state === STATES.ERROR; }
}

export default ChargeStateMachine;
