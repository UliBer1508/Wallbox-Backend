// ============================================================================
// TEST-MOCK — KebaCharger-Ersatz (simulierte SCHICHT 1)
// ============================================================================
// Erfüllt EXAKT das Interface des echten src/keba.js (KebaCharger), damit der
// ECHTE manager.js unverändert damit läuft. Statt Modbus TCP steckt eine
// kleine Lade-Physik dahinter (Energie wächst über Zeit, Zeitraffer).
//
// Genutzte Methoden laut echtem manager.js:
//   connect(), disconnect(), isConnected()
//   readSnapshot()            → { name, connected, state, stateCode, plugged, watt, sessionKwh, ts }
//   writeEnable(on), writeCurrent(ma)
//   writeFailsafe(t, fbMa)
//   stop({alsoDisable})       → kombinierter Stopp
//   readControlState()        → { chargingState, isCharging, ... }
//
// Am PC wird diese Datei einfach NICHT verwendet — dort kommt der echte
// KebaCharger zum Einsatz. Identisches Interface = ein Zeilen-Tausch.
// ============================================================================

export class MockKebaCharger {
  constructor(opts = {}) {
    this.host = opts.host ?? '0.0.0.0';
    this.port = opts.port ?? 502;
    this.unitId = opts.unitId ?? 255;
    this.name = opts.name ?? opts.host ?? 'MockKeba';
    this.phases = opts.phases ?? 3;
    this.vehicleMaxA = opts.vehicleMaxA ?? 16;     // simuliertes Auto-Limit
    this.timeFactor = opts.timeFactor ?? 60;       // 1 reale s ≙ 1 min Ladezeit

    this._connected = false;
    this._plugged = false;       // Auto angesteckt (per Sandbox-UI steuerbar)
    this._enabled = false;
    this._setCurrentMa = 0;
    this._sessionWh = 0;
    this._totalWh = 1234560;
    this._lastTick = null;
    this._failsafe = null;
    this._forceError = false;
  }

  // --- Sandbox-Steuerung (kein Teil des echten Interfaces) ------------------
  plugVehicle()   { this._plugged = true; }
  unplugVehicle() { this._plugged = false; }
  simulateError(on = true) { this._forceError = on; }

  // --- Physik ---------------------------------------------------------------
  _isCharging() {
    return this._connected && this._plugged && this._enabled && this._setCurrentMa >= 6000;
  }
  _effectiveA() { return Math.min(this._setCurrentMa / 1000, this.vehicleMaxA); }
  _watt() { return this._isCharging() ? Math.round(this._effectiveA() * 230 * this.phases) : 0; }
  _tick() {
    const now = Date.now();
    if (this._lastTick !== null && this._isCharging()) {
      const simSec = ((now - this._lastTick) / 1000) * this.timeFactor;
      const wh = (this._watt() * simSec) / 3600;
      this._sessionWh += wh;
      this._totalWh += wh;
    }
    this._lastTick = now;
  }
  _stateLabel() {
    if (!this._plugged) return { code: 1, label: 'notready' };
    if (this._isCharging()) return { code: 3, label: 'charging' };
    return this._enabled ? { code: 2, label: 'ready' } : { code: 5, label: 'suspended' };
  }

  // --- Echtes KebaCharger-Interface -----------------------------------------
  async connect()    { this._connected = true; }
  async disconnect() { this._connected = false; }
  isConnected()      { return this._connected; }

  _guard() {
    if (!this._connected) throw new Error('nicht verbunden');
    if (this._forceError) { const e = new Error('Modbus-Timeout (simuliert)'); e.code = 'ETIMEDOUT'; throw e; }
  }

  async readSnapshot() {
    this._guard(); this._tick();
    const s = this._stateLabel();
    return {
      name: this.name,
      connected: this._connected,
      state: s.label,
      stateCode: s.code,
      plugged: this._plugged,
      watt: this._watt(),
      sessionKwh: this._sessionWh / 1000,
      ts: Date.now(),
    };
  }

  async readChargingState() { this._guard(); this._tick(); const s = this._stateLabel(); return { code: s.code, label: s.label }; }
  async readCableState()    { this._guard(); return { raw: this._plugged ? 0b100 : 0, plugged: this._plugged }; }
  async readPower()         { this._guard(); this._tick(); return { watt: this._watt(), unit: 'W' }; }
  async readEnergySession() { this._guard(); this._tick(); return { wh: this._sessionWh, kwh: this._sessionWh / 1000, unit: 'kWh' }; }
  async readEnergyTotal()   { this._guard(); this._tick(); return { wh: this._totalWh, kwh: this._totalWh / 1000, unit: 'kWh' }; }
  async readCurrents() {
    this._guard(); this._tick();
    const a = this._isCharging() ? this._effectiveA() : 0;
    return this.phases === 3 ? { l1: a, l2: a, l3: a, unit: 'A' } : { l1: a, l2: 0, l3: 0, unit: 'A' };
  }
  async readVoltages() { this._guard(); return { l1: 230, l2: 230, l3: 230, unit: 'V' }; }

  async writeCurrent(ma) { this._guard(); this._tick(); this._setCurrentMa = ma; return ma & 0xffff; }
  async writeEnable(on)  {
    this._guard(); this._tick();
    const wasEnabled = this._enabled;
    this._enabled = !!on;
    if (on && !wasEnabled) { this._sessionWh = 0; this._lastTick = Date.now(); } // neue Session bei 0
    return on ? 1 : 0;
  }
  async writeFailsafe(timeoutSec, fbMa) { this._guard(); this._failsafe = { timeoutSec, fbMa }; return { timeoutSec, fallbackMilliamp: fbMa }; }
  async writePhases(p) { this._guard(); this.phases = p; return p; }

  async stop(opts = {}) {
    const alsoDisable = opts.alsoDisable !== false;
    await this.writeCurrent(0);
    if (alsoDisable) { await this.writeEnable(false); return { current0: true, disabled: true }; }
    return { current0: true, disabled: false };
  }

  async readControlState() {
    this._guard(); this._tick();
    const s = this._stateLabel();
    return {
      chargingState: s.label, chargingCode: s.code,
      setCurrentMa: this._setCurrentMa,
      isCharging: s.code === 3, isSuspended: s.code === 5,
    };
  }
}

export default MockKebaCharger;
