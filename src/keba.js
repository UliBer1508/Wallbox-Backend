// src/keba.js
//
// SCHICHT 1 — Geraete-Treiber (Hardware Abstraction Layer)
// ========================================================
// Eine Klasse KebaCharger pro Wallbox-Instanz.
// Kennt AUSSCHLIESSLICH Hardware: Modbus-Register, Port 502,
// Unit-ID 255, 32-bit BigEndian, Einzel-Reads.
// Weiss NICHTS von Sessions, Preisen, Gaesten, Stripe.
//
// Nach oben (an Schicht 2) bietet sie nur primitive Methoden an.
//
// ES-Modul. Benoetigt: modbus-serial
//
// -----------------------------------------------------------------
// WICHTIG — Verifizierungsstand der Register (Stand 11.06.2026):
//   LESE-Register (1000..1502): HART VERIFIZIERT (aus WALLBOX-PROJEKT.md)
//   SCHREIB-Register (5004):    Ladestrom - verifiziert
//   SCHREIB-Register (5014 enable, 5016/5018 failsafe, 5050 phasen):
//       NOCH NICHT VERIFIZIERT -> am PC gegen vorhandene keba.js
//       UND Keba-Modbus-Doku pruefen, bevor an echter Box benutzt!
//   Jede unsichere Stelle ist unten mit  // [PRUEFEN@PC]  markiert.
// -----------------------------------------------------------------

import ModbusRTU from 'modbus-serial';

// --- Register-Landkarte (zentral, nicht im Code verstreut) ---------
// Adresse, Breite (Register a 16 bit), Skalierung, Beschreibung.
export const REG = {
  // --- Lesen (verifiziert) ---
  CHARGING_STATE: { addr: 1000, words: 2 },   // 0=Startup 1=NotReady 2=Ready 3=Charging 4=Error 5=Suspended
  CABLE_STATE:    { addr: 1004, words: 2 },    // Bit 2 = Auto verbunden
  CURRENT_L1:     { addr: 1008, words: 2 },    // mA
  CURRENT_L2:     { addr: 1010, words: 2 },    // mA
  CURRENT_L3:     { addr: 1012, words: 2 },    // mA
  POWER:          { addr: 1020, words: 2 },    // mW
  ENERGY_TOTAL:   { addr: 1036, words: 2 },    // 0.1 Wh
  VOLTAGE_L1:     { addr: 1040, words: 2 },    // V
  VOLTAGE_L2:     { addr: 1042, words: 2 },    // V
  VOLTAGE_L3:     { addr: 1044, words: 2 },    // V
  ENERGY_SESSION: { addr: 1502, words: 2 },    // 0.1 Wh

  // --- Schreiben ---
  SET_CURRENT:    { addr: 5004, words: 1 },    // mA, 16-bit  (verifiziert)
  SET_ENABLE:     { addr: 5014, words: 1 },    // [PRUEFEN@PC] 1=ein 0=aus
  FAILSAFE_CURRENT: { addr: 5016, words: 1 },  // [PRUEFEN@PC] mA Fallback
  FAILSAFE_TIMEOUT: { addr: 5018, words: 1 },  // [PRUEFEN@PC] s Timeout
  SET_PHASES:     { addr: 5050, words: 1 },    // [PRUEFEN@PC] Phasenumschaltung (nur mit S10)

  // --- Zuruecklesen fuer Soll/Ist-Abgleich (evcc "out of sync"-Konzept) ---
  // Manche Keba-Firmwares spiegeln den gesetzten Ladestrom in einem
  // eigenen Register. Falls vorhanden, ist das der zuverlaessigste
  // Ist-Wert fuer den Soll/Ist-Vergleich. [PRUEFEN@PC] Register/Existenz!
  READ_SET_CURRENT: { addr: 5004, words: 1 },  // [PRUEFEN@PC] ob 5004 ruecklesbar ist
};

// Ladezustaende als Klartext (fuer Schicht 2 nuetzlich)
export const CHARGING_STATE = {
  0: 'startup',
  1: 'notready',
  2: 'ready',
  3: 'charging',
  4: 'error',
  5: 'suspended',
};

export class KebaCharger {
  /**
   * @param {object} opts
   * @param {string} opts.host    IP der Wallbox (z.B. "192.168.188.36")
   * @param {number} [opts.port]  Modbus-Port (Default 502)
   * @param {number} [opts.unitId] Unit-ID (Default 255)
   * @param {string} [opts.name]  Anzeigename (z.B. "P30C Gaeste")
   * @param {number} [opts.timeout] Modbus-Timeout ms (Default 3000)
   */
  constructor(opts = {}) {
    if (!opts.host) throw new Error('KebaCharger: host fehlt');
    this.host = opts.host;
    this.port = opts.port ?? 502;
    this.unitId = opts.unitId ?? 255;
    this.name = opts.name ?? opts.host;
    this.timeout = opts.timeout ?? 3000;

    this.client = new ModbusRTU();
    this._connected = false;
    // Modbus bedient nur EINEN Client gleichzeitig und Einzel-Reads:
    // Ein Mutex serialisiert alle Zugriffe, damit sich parallele
    // Lese-/Schreibaufrufe nicht in die Quere kommen.
    this._chain = Promise.resolve();
  }

  // --- Verbindung --------------------------------------------------

  async connect() {
    if (this._connected) return;
    await this.client.connectTCP(this.host, { port: this.port });
    this.client.setID(this.unitId);
    this.client.setTimeout(this.timeout);
    this._connected = true;
  }

  async disconnect() {
    if (!this._connected) return;
    try {
      await new Promise((res) => this.client.close(res));
    } catch {
      /* ignorieren */
    }
    this._connected = false;
  }

  isConnected() {
    return this._connected;
  }

  // --- Interne Modbus-Primitive (serialisiert) ---------------------

  // Alle Hardware-Zugriffe laufen durch _run, damit sie nacheinander
  // passieren (Einzel-Client-Beschraenkung der Keba).
  _run(fn) {
    const next = this._chain.then(fn, fn);
    // Kette nicht an Fehlern haengen lassen:
    this._chain = next.then(() => {}, () => {});
    return next;
  }

  // 32-bit Wert aus 2 Holding-Registern, BigEndian, vorzeichenlos
  async _read32(reg) {
    return this._run(async () => {
      if (!this._connected) throw new Error('nicht verbunden');
      const r = await this.client.readHoldingRegisters(reg.addr, 2);
      const [hi, lo] = r.data;
      return (hi * 0x10000 + lo) >>> 0;
    });
  }

  // 16-bit in ein einzelnes Holding-Register schreiben
  async _write16(reg, value) {
    return this._run(async () => {
      if (!this._connected) throw new Error('nicht verbunden');
      const v = Math.round(value) & 0xffff;
      await this.client.writeRegister(reg.addr, v);
      return v;
    });
  }

  // 16-bit aus einem einzelnen Holding-Register lesen
  async _read16(reg) {
    return this._run(async () => {
      if (!this._connected) throw new Error('nicht verbunden');
      const r = await this.client.readHoldingRegisters(reg.addr, 1);
      return r.data[0] & 0xffff;
    });
  }

  // --- Primitive Lese-Methoden (nach oben angeboten) ---------------

  async readChargingState() {
    const raw = await this._read32(REG.CHARGING_STATE);
    return { code: raw, label: CHARGING_STATE[raw] ?? 'unknown' };
  }

  async readCableState() {
    const raw = await this._read32(REG.CABLE_STATE);
    // Bit 2 gesetzt => Auto verbunden
    return { raw, plugged: (raw & 0b100) !== 0 };
  }

  async readCurrents() {
    const l1 = await this._read32(REG.CURRENT_L1);
    const l2 = await this._read32(REG.CURRENT_L2);
    const l3 = await this._read32(REG.CURRENT_L3);
    // mA -> A
    return { l1: l1 / 1000, l2: l2 / 1000, l3: l3 / 1000, unit: 'A' };
  }

  async readPower() {
    const mw = await this._read32(REG.POWER);
    return { watt: mw / 1000, unit: 'W' }; // mW -> W
  }

  async readEnergyTotal() {
    const raw = await this._read32(REG.ENERGY_TOTAL);
    return { wh: raw / 10, kwh: raw / 10000, unit: 'kWh' }; // 0.1 Wh
  }

  async readEnergySession() {
    const raw = await this._read32(REG.ENERGY_SESSION);
    return { wh: raw / 10, kwh: raw / 10000, unit: 'kWh' }; // 0.1 Wh
  }

  async readVoltages() {
    const l1 = await this._read32(REG.VOLTAGE_L1);
    const l2 = await this._read32(REG.VOLTAGE_L2);
    const l3 = await this._read32(REG.VOLTAGE_L3);
    return { l1, l2, l3, unit: 'V' };
  }

  // Bequemer Gesamt-Schnappschuss (Schicht 2 nutzt das im Poll-Zyklus)
  // Liest jetzt zusaetzlich Gesamtenergie (Register 1036) und Phasen-
  // stroeme (1008/1010/1012) mit, weil server.js diese Felder als
  // hw.totalKwh bzw. hw.l1/l2/l3 erwartet (sonst totalEnergy:null und
  // currents:[0,0,0] in der API). Gesamtenergie ist Basis der Abrechnung
  // (totalKwh-Differenz, nicht sessionKwh — Tesla setzt Session nicht zurueck).
  async readSnapshot() {
    const state = await this.readChargingState();
    const cable = await this.readCableState();
    const power = await this.readPower();
    const energySession = await this.readEnergySession();
    const energyTotal = await this.readEnergyTotal();
    const currents = await this.readCurrents();
    return {
      name: this.name,
      connected: this._connected,
      state: state.label,
      stateCode: state.code,
      plugged: cable.plugged,
      watt: power.watt,
      sessionKwh: energySession.kwh,
      totalKwh: energyTotal.kwh,
      l1: currents.l1,
      l2: currents.l2,
      l3: currents.l3,
      ts: Date.now(),
    };
  }

  // --- Primitive Schreib-Methoden ----------------------------------

  /**
   * Ladestrom setzen.
   * @param {number} milliamp  Strom in mA (z.B. 16000 = 16 A)
   * Register 5004 ist verifiziert.
   * Hinweis: Strom = 0 ist der evcc-typische "weiche Stopp".
   */
  async writeCurrent(milliamp) {
    return this._write16(REG.SET_CURRENT, milliamp);
  }

  /**
   * Laden ein/aus.
   * [PRUEFEN@PC] Register 5014 + Wertebelegung gegen keba.js/Keba-Doku
   * verifizieren, bevor an echter Box benutzt!
   * @param {boolean} on
   */
  async writeEnable(on) {
    return this._write16(REG.SET_ENABLE, on ? 1 : 0);
  }

  /**
   * Keba-eigenes Failsafe setzen: Box stoppt selbsttaetig, wenn der
   * Daemon laenger als timeout verstummt -> faellt auf fallback-Strom.
   * [PRUEFEN@PC] Register 5016/5018 + Reihenfolge gegen Keba-Doku pruefen!
   * @param {number} timeoutSec   0 = Failsafe aus
   * @param {number} fallbackMilliamp
   */
  async writeFailsafe(timeoutSec, fallbackMilliamp) {
    await this._write16(REG.FAILSAFE_CURRENT, fallbackMilliamp);
    await this._write16(REG.FAILSAFE_TIMEOUT, timeoutSec);
    return { timeoutSec, fallbackMilliamp };
  }

  /**
   * Phasenumschaltung 1P/3P (nur C-Serie mit KeContact S10).
   * [PRUEFEN@PC] Register 5050 + Wert "3" gegen Keba-Doku pruefen!
   * @param {1|3} phases
   */
  async writePhases(phases) {
    return this._write16(REG.SET_PHASES, phases);
  }

  // --- Kombinierte Hardware-Operationen ----------------------------

  /**
   * Zuverlaessiger Stopp nach evcc-Erkenntnis:
   * Strom=0 allein stoppt manche Keba-Boxen nicht sicher, daher
   * ZUSAETZLICH enable=false. Beide Wege kombiniert.
   * Schicht 2 ruft nur stop() auf, muss die Reihenfolge nicht kennen.
   *
   * Reihenfolge: erst Strom auf 0 (Box regelt runter), dann enable aus.
   * @param {object} [opts]
   * @param {boolean} [opts.alsoDisable=true] enable=false zusaetzlich setzen
   */
  async stop(opts = {}) {
    const alsoDisable = opts.alsoDisable !== false;
    await this.writeCurrent(0);
    if (alsoDisable) {
      try {
        await this.writeEnable(false);
      } catch (e) {
        // enable-Register evtl. nicht verfuegbar/verifiziert -> Strom=0
        // bleibt als Stopp bestehen. Fehler nach oben sichtbar machen.
        return { current0: true, disabled: false, disableError: e.message };
      }
      return { current0: true, disabled: true };
    }
    return { current0: true, disabled: false };
  }

  /**
   * Liest den IST-Steuerzustand fuer den Soll/Ist-Abgleich
   * (evcc "out of sync"-Konzept). Schicht 2 vergleicht das Ergebnis
   * mit dem zuletzt kommandierten Soll.
   *
   * Liefert mehrere Indikatoren, damit Schicht 2 den robustesten
   * waehlen kann:
   *  - chargingState: der verifizierte Lade-Zustand (1000) - IMMER da
   *  - setCurrentMa:  zurueckgelesener Soll-Strom (5004) [PRUEFEN@PC]
   *
   * chargingState ist der zuverlaessige Anker (Register verifiziert):
   *   'charging'  -> Box laedt aktiv
   *   'suspended' -> Box pausiert (z.B. nach Strom=0 / enable=false)
   *   'ready'     -> bereit, laedt nicht
   */
  async readControlState() {
    const state = await this.readChargingState();
    let setCurrentMa = null;
    try {
      setCurrentMa = await this._read16(REG.READ_SET_CURRENT);
    } catch {
      // Register evtl. nicht ruecklesbar -> null, Schicht 2 nutzt dann
      // chargingState als alleinigen Ist-Indikator.
      setCurrentMa = null;
    }
    return {
      chargingState: state.label,   // verifizierter Anker
      chargingCode: state.code,
      setCurrentMa,                 // [PRUEFEN@PC] evtl. null
      // abgeleitete Interpretation fuer bequemen Soll/Ist-Vergleich:
      isCharging: state.code === 3,
      isSuspended: state.code === 5,
    };
  }
}

export default KebaCharger;
