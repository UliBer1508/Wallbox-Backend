// src/manager.js
//
// SCHICHT 2 — Prozesslogik / Daemon-Kern
// ======================================
// Das Herzstueck. Verwaltet pro Wallbox: einen Treiber (Schicht 1) und
// einen Zustandsautomaten. Pollt adaptiv, fuehrt den Soll/Ist-Waechter
// (evcc "out of sync"), behandelt Reconnect/Failsafe, raeumt haengende
// Sessions auf und feuert Events nach oben (an Schicht 3/Abrechnung).
//
// Kennt die HARDWARE nur ueber die Treiber-Schnittstelle (Schicht 1).
// Kennt KEIN Stripe, KEINE Preise. Spricht "laden/strom/energie/limit".
//
// ES-Modul. Erbt von EventEmitter (Events nach oben).
//
// Eingearbeitete evcc/eCarUp-Konzepte:
//  - Doppelter Stopp (Treiber.stop): Strom=0 + enable=false
//  - Soll/Ist-Waechter: nach Steuerbefehl pruefen, ob Box reagiert
//  - Guard-Duration: Schuetz nicht zu haeufig schalten
//  - Failsafe-Watchdog: Box stoppt selbsttaetig bei Daemon-Stille
//  - Adaptives Polling: Leerlauf langsam, Ladung schnell
//  - "Auto laedt sofort beim Anstecken" -> REQUESTED haelt dagegen

import { EventEmitter } from 'events';
import { ChargeStateMachine, STATES } from './statemachine.js';

// Ein WallboxUnit kapselt alles, was zu EINER Box gehoert.
class WallboxUnit {
  constructor(driver, cfg) {
    this.driver = driver;          // Schicht-1-Instanz (KebaCharger oder Mock)
    this.cfg = cfg;                // Hardware-Config aus config.js
    this.id = cfg.id;
    this.sm = new ChargeStateMachine();
    this.session = null;           // { sessionId, modus, limitKwh, startKwh, ... }
    this.snapshot = null;          // letzter Hardware-Schnappschuss
    this.lastSwitchTs = 0;         // fuer Guard-Duration
    this.reconnectAttempts = 0;
    this.pollTimer = null;
    this.desired = { charging: false, currentMa: 0 }; // Soll-Zustand fuer Waechter
    // --- DEFAULT-SPERRE (Abrechnungsschutz) ---------------------------
    // Eine aktive Box (cfg.active) ist im Grundzustand GESPERRT: das
    // Backend haelt sie kontinuierlich auf writeEnable(false)+current0,
    // damit ohne bezahlte Session NIEMAND laden kann. Erst startCharge
    // hebt die Sperre auf, stopCharge/Session-Ende setzt sie wieder.
    // Hintergrund (verifiziert 17.06.2026 an P30X): Ein einmaliges
    // writeEnable(false) reicht NICHT — das Auto verhandelt bei
    // anliegendem Strom (SmartFox M) neu und laedt wieder an. Deshalb
    // muss die Sperre bei JEDEM Poll erneuert werden.
    this.locked = !!cfg.active;     // aktive Box startet gesperrt
    this.lockEnforcedTs = 0;        // wann zuletzt Sperre durchgesetzt
    // --- BEZAHL-MODUS -------------------------------------------------
    // payRequired=true: Box wird gesteuert + gesperrt (Gaeste-Abrechnung).
    // payRequired=false: NUR LESEN — keine Default-Sperre, Auto laedt frei
    //   (z.B. eigener Tesla im Ueberschuss-Modus). server.js setzt das.
    this.payRequired = true;
    // Einsteck-Kontext (fuer "angesteckt seit" + "geladen seit Einstecken")
    this.plugTs = null;          // Zeitpunkt, als das Auto eingesteckt wurde
    this.plugStartKwh = null;    // Gesamt-Zählerstand beim Einstecken
    this.waitingSince = null;    // Beginn WAITING_FOR_CAR (fuer 10-Min-Timeout)
  }
}

export class WallboxManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {Array}  opts.units  Liste aus { driver, cfg }
   * @param {object} opts.middle Middle-Layer-Settings (Polling, Timeouts, ...)
   * @param {function} [opts.now] Zeitquelle (fuer Tests), Default Date.now
   */
  constructor(opts = {}) {
    super();
    this.middle = opts.middle || {};
    this._now = opts.now || (() => Date.now());
    this.units = new Map();
    for (const u of (opts.units || [])) {
      this.units.set(u.cfg.id, new WallboxUnit(u.driver, u.cfg));
    }
    this._running = false;
  }

  // --- Lebenszyklus --------------------------------------------------

  async start() {
    if (this._running) return;
    this._running = true;
    for (const unit of this.units.values()) {
      await this._connectUnit(unit);
      this._scheduleNextPoll(unit);
    }
  }

  async stop() {
    this._running = false;
    for (const unit of this.units.values()) {
      if (unit.pollTimer) clearTimeout(unit.pollTimer);
      unit.pollTimer = null;
      try { await unit.driver.disconnect(); } catch { /* egal */ }
    }
  }

  async _connectUnit(unit) {
    try {
      await unit.driver.connect();
      unit.reconnectAttempts = 0;
      this.emit('connectionRestored', { wallboxId: unit.id });
      // Failsafe der Box setzen (Box stoppt selbsttaetig bei Daemon-Stille)
      if (unit.cfg.active && typeof unit.driver.writeFailsafe === 'function') {
        const t = unit.cfg.failsafeTimeoutSec ?? 30;
        const fbMa = (unit.cfg.failsafeFallbackA ?? 6) * 1000;
        try { await unit.driver.writeFailsafe(t, fbMa); } catch { /* [PRUEFEN@PC] */ }
      }
      // DEFAULT-SPERRE beim Verbinden durchsetzen: aktive Box wird sofort
      // gesperrt, damit ohne bezahlte Session nicht geladen werden kann.
      if (unit.cfg.active && unit.payRequired && unit.locked && !unit.session) {
        await this._enforceLock(unit);
      }
    } catch (e) {
      this.emit('connectionLost', { wallboxId: unit.id, error: e.message });
    }
  }

  // Setzt die Default-Sperre durch: Box uebernehmen (writeEnable(true)),
  // dann hart stoppen (writeEnable(false)+current0). Die Uebernahme ist
  // noetig, weil die Keba ein "Aus" nur zuverlaessig akzeptiert, wenn sie
  // vorher ein "Ein" vom selben Client bekommen hat (verifiziert P30X).
  async _enforceLock(unit) {
    try {
      if (typeof unit.driver.writeEnable === 'function') {
        await unit.driver.writeEnable(true);   // kurz uebernehmen
      }
      await this._safeStop(unit);              // dann hart sperren
      unit.desired = { charging: false, currentMa: 0 };
      unit.lockEnforcedTs = this._now();
    } catch (e) {
      this.emit('errorOccurred', { wallboxId: unit.id, code: 'LOCK_FAILED', details: e.message });
    }
  }

  // --- Polling (adaptiv) ---------------------------------------------

  _pollIntervalMs(unit) {
    const idle = (this.middle.pollIdleSec ?? 10) * 1000;
    const active = (this.middle.pollActiveSec ?? 3) * 1000;
    // Gesperrte Box, aber Auto laedt/will laden -> schnell pollen, damit die
    // Sperre rasch wieder zuschlaegt und kaum Gratis-Strom durchkommt.
    if (unit.locked && !unit.sm.isCharging() && unit.cfg.active) {
      const snap = unit.snapshot;
      const laedt = snap && (snap.state === 'charging' || (snap.watt ?? 0) > 50);
      if (laedt) return Math.min(active, 2000);   // hoechstens 2 s
    }
    return unit.sm.isCharging() ? active : idle;
  }

  _scheduleNextPoll(unit) {
    if (!this._running) return;
    if (unit.pollTimer) clearTimeout(unit.pollTimer);
    unit.pollTimer = setTimeout(() => {
      this._pollUnit(unit).finally(() => this._scheduleNextPoll(unit));
    }, this._pollIntervalMs(unit));
  }

  // Ein Poll-Zyklus: Zustand lesen, Aenderungen erkennen, Events feuern,
  // Soll/Ist pruefen, Limit pruefen.
  async _pollUnit(unit) {
    if (!this._running) return;
    if (!unit.driver.isConnected()) {
      await this._handleReconnect(unit);
      return;
    }
    let snap;
    try {
      snap = await unit.driver.readSnapshot();
    } catch (e) {
      this.emit('connectionLost', { wallboxId: unit.id, error: e.message });
      try { await unit.driver.disconnect(); } catch { /* egal */ }
      return;
    }

    const prev = unit.snapshot;
    unit.snapshot = snap;

    // --- DEFAULT-SPERRE durchsetzen (Abrechnungsschutz) ----------------
    // Box ist gesperrt (locked) und NICHT in einer laufenden Ladung
    // (CHARGING), aber das Auto laedt trotzdem? -> erneut sperren. Das
    // faengt ab: Gast steckt an, SmartFox gibt Strom frei, Auto laedt los —
    // egal ob noch gar keine Session existiert ODER nur eine unbezahlte
    // Vormerkung (REQUESTED) laeuft. locked wird erst bei startCharge
    // (= bezahlt/freigegeben) aufgehoben.
    // AUSNAHME: Im Wartezustand (WAITING_FOR_CAR) ist ein anlaufendes Auto
    // genau das erwartete Start-Signal — hier NICHT sperren, sondern den
    // WAITING-Block unten uebernehmen lassen.
    if (unit.payRequired && unit.locked && !unit.sm.isCharging() &&
        !unit.sm.isWaitingForCar() && unit.cfg.active) {
      const laedt = snap.state === 'charging' || (snap.watt ?? 0) > 50;
      if (laedt) {
        await this._enforceLock(unit);
        return;   // gesperrte Box: keine weitere Logik in diesem Zyklus
      }
    }

    // --- Kabel-Ereignisse ---
    // Auto NEU eingesteckt: Einsteck-Zeitpunkt + Start-Zählerstand merken,
    // damit der Admin "angesteckt seit" und "geladen seit Einstecken" zeigen kann.
    if (snap.plugged && (!prev || !prev.plugged)) {
      unit.plugTs = this._now();
      unit.plugStartKwh = snap.totalKwh ?? null;
    }
    if (prev && prev.plugged && !snap.plugged) {
      // Abgesteckt: Einsteck-Kontext zuruecksetzen
      unit.plugTs = null;
      unit.plugStartKwh = null;
      this.emit('cableDisconnected', { wallboxId: unit.id, sessionId: unit.session?.sessionId });
      if (unit.sm.isCharging()) {
        await this._beginStop(unit, 'Kabel gezogen');
      }
    }

    // --- WARTE AUF AUTO: Auto angesteckt? Strom da? Timeout? -----------
    if (unit.sm.isWaitingForCar()) {
      const plugged = !!snap.plugged;
      const laedt = snap.state === 'charging' || (snap.watt ?? 0) > 50;
      // Auto steckt (oder laedt bereits) -> jetzt wirklich CHARGING + Freigabe.
      if (plugged || laedt) {
        await this._beginCharging(unit);
        return;
      }
      // Sonst: Timeout pruefen (Default 10 Min, ueberschreibbar via middle).
      const waitMs = (this.middle?.waitForCarMinutes ?? 10) * 60 * 1000;
      const seit = unit.waitingSince ? (this._now() - unit.waitingSince) : 0;
      if (seit > waitMs) {
        const sessionId = unit.session?.sessionId;
        unit.waitingSince = null;
        unit.session = null;
        unit.desired = { charging: false, currentMa: 0 };
        unit.sm.transition(STATES.IDLE, 'Timeout: kein Auto angesteckt');
        if (unit.cfg.active) { unit.locked = true; await this._enforceLock(unit).catch(() => {}); }
        // Abrechnungslayer gibt daraufhin die Reservierung frei (0 EUR).
        this.emit('waitTimeout', { wallboxId: unit.id, sessionId });
      }
      return;   // im Wartezustand keine weitere Lade-/Limit-Logik
    }

    // --- Energie-/Limit-Logik nur waehrend CHARGING ---
    if (unit.sm.isCharging() && unit.session) {
      const kwh = Math.max(0, snap.totalKwh - (unit.session.startKwh ?? 0));
      this.emit('energyUpdated', {
        wallboxId: unit.id,
        sessionId: unit.session.sessionId,
        kWh: kwh,
        watt: snap.watt,
      });

      // Limit erreicht? (modus "limit" mit limitKwh)
      if (unit.session.modus === 'limit' && unit.session.limitKwh > 0 &&
          kwh >= unit.session.limitKwh) {
        this.emit('limitReached', {
          wallboxId: unit.id,
          sessionId: unit.session.sessionId,
          kWh: kwh,
        });
        await this._beginStop(unit, 'Limit erreicht');
      }

      // --- Soll/Ist-Waechter (evcc out-of-sync) ---
      await this._checkSync(unit, snap);
    }

    // --- Waehrend STOPPING: bestaetigen, dass Box wirklich gestoppt hat ---
    if (unit.sm.state === STATES.STOPPING) {
      if (!snap.state || snap.state !== 'charging') {
        // Box hat gestoppt -> Abschluss melden, IDLE
        const finalKwh = unit.session
          ? Math.max(0, snap.totalKwh - (unit.session.startKwh ?? 0)) : 0;
        const sessionId = unit.session?.sessionId;
        unit.sm.transition(STATES.IDLE, 'Stop bestaetigt');
        this.emit('chargingStopped', { wallboxId: unit.id, sessionId, finalKWh: finalKwh });
        unit.session = null;
        unit.desired = { charging: false, currentMa: 0 };
        // DEFAULT-SPERRE wieder aktivieren und sofort durchsetzen, damit
        // nach Session-Ende nicht weitergeladen werden kann.
        if (unit.cfg.active) {
          unit.locked = true;
          await this._enforceLock(unit);
        }
      }
    }
  }

  // Soll/Ist: Box soll laden, tut sie das auch? (und umgekehrt)
  async _checkSync(unit, snap) {
    const sollCharging = unit.desired.charging;
    const istCharging = snap.state === 'charging';
    if (sollCharging && !istCharging) {
      // Wir wollen laden, Box laedt nicht -> moeglicher eCarUp-Konflikt/Fehler
      this.emit('errorOccurred', {
        wallboxId: unit.id,
        code: 'OUT_OF_SYNC',
        details: `Soll: laden, Ist: ${snap.state}. Moeglicher Steuer-Konflikt (eCarUp?) oder Box reagiert nicht.`,
      });
    }
  }

  // --- Reconnect mit Backoff -----------------------------------------

  async _handleReconnect(unit) {
    const maxTries = this.middle.reconnectTries ?? 5;
    if (unit.reconnectAttempts >= maxTries) {
      // aufgeben bis zum naechsten Zyklus, aber weiter versuchen
      unit.reconnectAttempts = 0;
    }
    unit.reconnectAttempts++;
    await this._connectUnit(unit);
  }

  // --- Steuerbefehle (von Schicht 3 ueber die Fassade) ----------------

  /** Ladevorgang vormerken. Box soll NICHT von allein loslegen. */
  async requestCharge(wallboxId, { modus = 'voll', limitKwh = 0, sessionId } = {}) {
    const unit = this._unit(wallboxId);
    if (!unit.cfg.active) throw new Error(`Wallbox ${wallboxId} ist inaktiv.`);
    if (!unit.sm.canTransition(STATES.REQUESTED)) {
      throw new Error(`requestCharge im Zustand ${unit.sm.state} nicht moeglich.`);
    }
    // Sicherstellen, dass die Box NICHT laedt (Auto koennte sonst sofort
    // loslegen). Strom 0 + enable aus.
    await this._safeStop(unit);
    unit.session = {
      sessionId: sessionId || this._genId(),
      modus, limitKwh,
      startKwh: unit.snapshot?.totalKwh ?? 0,
      requestedTs: this._now(),
    };
    unit.sm.transition(STATES.REQUESTED, 'requestCharge');
    return { sessionId: unit.session.sessionId, state: unit.sm.state };
  }

  /** Tatsaechlich Laden starten (nach Freigabe durch Abrechnungslayer). */
  async startCharge(wallboxId, sessionId) {
    const unit = this._unit(wallboxId);
    if (!unit.session || unit.session.sessionId !== sessionId) {
      throw new Error('Unbekannte oder abgelaufene Session.');
    }
    if (!unit.sm.canTransition(STATES.WAITING_FOR_CAR)) {
      throw new Error(`startCharge im Zustand ${unit.sm.state} nicht moeglich.`);
    }
    // NEU: Nach der Zahlung NICHT sofort laden, sondern in den Wartezustand
    // gehen. Strom wird ERST freigegeben, wenn ein Auto angesteckt ist und
    // tatsaechlich Strom fliesst (siehe _pollUnit, WAITING_FOR_CAR-Block).
    // Damit endet keine Session mehr mit 0 kWh, bevor der Gast anstecken konnte.
    unit.session.startKwh = unit.snapshot?.totalKwh ?? unit.session.startKwh ?? 0;
    unit.waitingSince = this._now();          // fuer 10-Min-Timeout
    unit.desired = { charging: false, currentMa: 0 };
    unit.sm.transition(STATES.WAITING_FOR_CAR, 'startCharge -> warte auf Auto');
    this.emit('waitingForCar', { wallboxId: unit.id, sessionId });
    // Sofort-Poll: falls das Auto schon steckt, startet die Ladung gleich.
    this._pollUnit(unit).catch(() => {});
    return { state: unit.sm.state };
  }

  /**
   * Interner Wechsel WAITING_FOR_CAR -> CHARGING.
   * Wird aus dem Poll aufgerufen, sobald Auto steckt UND Strom fliesst (bzw.
   * die Box bereit ist). Erst HIER wird die Sperre aufgehoben und Strom
   * freigegeben.
   */
  async _beginCharging(unit) {
    if (!unit.sm.canTransition(STATES.CHARGING)) return;
    this._guard(unit);
    unit.locked = false;   // DEFAULT-SPERRE aufheben: ab jetzt darf geladen werden
    unit.session.startKwh = unit.snapshot?.totalKwh ?? unit.session.startKwh ?? 0;
    const maxMa = (unit.cfg.maxCurrentA ?? 16) * 1000;
    await unit.driver.writeEnable(true);
    await unit.driver.writeCurrent(maxMa);
    unit.desired = { charging: true, currentMa: maxMa };
    unit.lastSwitchTs = this._now();
    unit.waitingSince = null;
    unit.sm.transition(STATES.CHARGING, 'Auto angesteckt -> laden');
    this.emit('chargingStarted', { wallboxId: unit.id, sessionId: unit.session?.sessionId });
  }

  /** Laden beenden (vom Abrechnungslayer oder intern). */
  async stopCharge(wallboxId, sessionId) {
    const unit = this._unit(wallboxId);
    if (unit.session && sessionId && unit.session.sessionId !== sessionId) {
      throw new Error('Session passt nicht.');
    }
    const sid = unit.session?.sessionId;
    await this._beginStop(unit, 'stopCharge');
    // FIX: Wenn _beginStop nichts tat (Box haengt in IDLE, aber es existiert
    // noch eine Session), die Session hier trotzdem sauber abschliessen.
    // Sonst bleibt sie als "active" haengen (Ursache der festhaengenden Sessions).
    if (unit.session) {
      const finalKwh = unit.session.startKwh != null && unit.snapshot
        ? Math.max(0, (unit.snapshot.totalKwh ?? 0) - unit.session.startKwh)
        : (unit.session.energyKwh ?? 0);
      unit.session = null;
      if (unit.cfg.active) { unit.locked = true; await this._enforceLock(unit).catch(() => {}); }
      this.emit('chargingStopped', { wallboxId: unit.id, sessionId: sid, finalKWh: finalKwh });
    }
    return { state: unit.sm.state };
  }

  /** Ladestrom anpassen (waehrend CHARGING). */
  async setCurrent(wallboxId, ampere) {
    const unit = this._unit(wallboxId);
    if (!unit.sm.isCharging()) throw new Error('Nicht im Ladezustand.');
    const min = unit.cfg.minCurrentA ?? 6;
    const max = unit.cfg.maxCurrentA ?? 16;
    const a = Math.min(max, Math.max(min, ampere));
    const ma = a * 1000;
    await unit.driver.writeCurrent(ma);
    unit.desired.currentMa = ma;
    return { ampere: a };
  }

  /**
   * Box HART sperren (Default-Sperre / Abrechnungsschutz).
   * Schickt writeEnable(false) + writeCurrent(0), UNABHAENGIG vom
   * State-Machine-Zustand. Dient dazu, eine Box im Ruhezustand
   * gesperrt zu halten, damit niemand ohne bezahlte Session laedt.
   * Aendert den FSM-Zustand NICHT (rein defensiver Hardware-Befehl).
   */
  async blockWallbox(wallboxId) {
    const unit = this._unit(wallboxId);
    unit.locked = true;
    await this._enforceLock(unit);
    return { state: unit.sm.state, blocked: true };
  }

  /**
   * Bezahl-Modus einer Box setzen (von server.js aufgerufen).
   * payRequired=false  -> NUR LESEN: Default-Sperre wird aufgehoben, das
   *   Auto (z.B. eigener Tesla) laedt frei. Keine Steuerung.
   * payRequired=true   -> normaler Abrechnungsschutz: Box wird gesperrt,
   *   wenn keine bezahlte Session laeuft.
   */
  async setPayRequired(wallboxId, required) {
    const unit = this._unit(wallboxId);
    unit.payRequired = !!required;
    if (!required) {
      // Lese-Modus: Sperre aufheben, Box freigeben, NICHT mehr eingreifen.
      unit.locked = false;
      try { await unit.driver.writeEnable(true); } catch { /* nur lesen, egal */ }
    } else if (unit.cfg.active && !unit.session) {
      // wieder Abrechnungsschutz: sperren, falls keine Session laeuft
      unit.locked = true;
      await this._enforceLock(unit).catch(() => {});
    }
    return { wallboxId: unit.id, payRequired: unit.payRequired };
  }

  /** Vormerkung/Wartevorgang verwerfen (Zahlung nie abgeschlossen ODER
   *  Gast bricht im Warte-Screen ab). */
  async cancelRequest(wallboxId, sessionId) {
    const unit = this._unit(wallboxId);
    if (unit.session && sessionId && unit.session.sessionId !== sessionId) {
      throw new Error('Session passt nicht.');
    }
    if (unit.sm.state === STATES.REQUESTED || unit.sm.isWaitingForCar()) {
      const sid = unit.session?.sessionId;
      unit.sm.transition(STATES.IDLE, 'cancelRequest');
      unit.session = null;
      unit.waitingSince = null;
      unit.desired = { charging: false, currentMa: 0 };
      // Box wieder sperren, damit nach Abbruch nicht weitergeladen werden kann.
      if (unit.cfg.active) { unit.locked = true; await this._enforceLock(unit).catch(() => {}); }
      this.emit('requestCancelled', { wallboxId: unit.id, sessionId: sid });
    }
    return { state: unit.sm.state };
  }

  // --- Zustandsabfragen (fuer Fassade/Abrechnung) --------------------

  getState(wallboxId) {
    const unit = this._unit(wallboxId);
    // geladene kWh seit Einstecken (aus Gesamt-Zählerstand-Differenz)
    let pluggedKwh = null;
    if (unit.plugStartKwh != null && unit.snapshot?.totalKwh != null) {
      pluggedKwh = Math.max(0, unit.snapshot.totalKwh - unit.plugStartKwh);
    }
    return {
      wallboxId: unit.id,
      name: unit.cfg.name,
      fsmState: unit.sm.state,
      connected: unit.driver.isConnected(),
      payRequired: unit.payRequired,
      pluggedSince: unit.plugTs,        // Zeitpunkt Einstecken (ms) oder null
      pluggedKwh,                       // kWh seit Einstecken oder null
      session: unit.session ? { ...unit.session } : null,
      hardware: unit.snapshot ? { ...unit.snapshot } : null,
    };
  }

  getAllState() {
    return [...this.units.keys()].map((id) => this.getState(id));
  }

  // --- Interne Helfer ------------------------------------------------

  // Stop einleiten: STOPPING-Zustand + Hardware-Stop. Abschluss-Event
  // kommt erst, wenn der Poll bestaetigt, dass die Box wirklich steht.
  async _beginStop(unit, reason) {
    if (unit.sm.state === STATES.STOPPING || unit.sm.state === STATES.IDLE) return;
    if (unit.sm.isCharging() || unit.sm.state === STATES.REQUESTED) {
      // aus REQUESTED direkt nach IDLE (gar nicht erst geladen)
      if (unit.sm.state === STATES.REQUESTED) {
        await this._safeStop(unit);
        const sid = unit.session?.sessionId;
        unit.sm.transition(STATES.IDLE, reason);
        unit.session = null;
        this.emit('requestCancelled', { wallboxId: unit.id, sessionId: sid });
        return;
      }
      this._guard(unit);
      await this._safeStop(unit);
      unit.lastSwitchTs = this._now();
      unit.desired = { charging: false, currentMa: 0 };
      unit.sm.transition(STATES.STOPPING, reason);
      // Sofort-Poll (Bug-3-Fix): nicht aufs Intervall warten, damit der
      // Stop-Abschluss (chargingStopped, Capture, Auto-Rücksetzung) prompt
      // passiert statt erst nach bis zu pollActiveSec Sekunden.
      this._pollUnit(unit).catch(() => {});
    }
  }

  // Hardware-Stop ueber die kombinierte Treiber-Primitive (Strom0+enable).
  async _safeStop(unit) {
    try {
      if (typeof unit.driver.stop === 'function') {
        await unit.driver.stop();
      } else {
        await unit.driver.writeCurrent(0);
        if (typeof unit.driver.writeEnable === 'function') {
          await unit.driver.writeEnable(false);
        }
      }
    } catch (e) {
      this.emit('errorOccurred', { wallboxId: unit.id, code: 'STOP_FAILED', details: e.message });
    }
  }

  // Guard-Duration: warnt, wenn zu schnell hintereinander geschaltet wird.
  // (Schuetz-Schonung; hartes Blockieren waere zu riskant -> nur Warnung.)
  _guard(unit) {
    const guardMs = (this.middle.guardDurationSec ?? 0) * 1000;
    if (guardMs <= 0) return;
    const since = this._now() - unit.lastSwitchTs;
    if (since < guardMs) {
      this.emit('guardWarning', {
        wallboxId: unit.id,
        details: `Schaltung nach ${Math.round(since/1000)}s (Guard ${guardMs/1000}s).`,
      });
    }
  }

  _unit(id) {
    const u = this.units.get(id);
    if (!u) throw new Error(`Unbekannte Wallbox: ${id}`);
    return u;
  }

  _genId() {
    return 's_' + this._now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
}

export default WallboxManager;
