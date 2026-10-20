'use strict';
/**
 * Wallbox-Adapter über das bestehende Wallbox-Backend (Steinbock Chalets)
 *
 * Die Bridge spricht KEIN Modbus mehr. Alle Befehle laufen über die
 * Admin-API des Backends – damit gibt es nur eine Stelle, die die Keba
 * steuert, und jede Alexa-Ladung erscheint als Session im Verlauf.
 *
 * Genutzte Endpunkte:
 *   POST /api/login                     { username, password } -> { token }
 *   GET  /api/state                     -> { wallboxen: [{ id, power, session, ... }] }
 *   POST /api/wallbox/:id/start         { current }  (Admin-Gratis-Session)
 *   POST /api/wallbox/:id/stop
 *   POST /api/wallbox/:id/current       { current }  (OPTIONAL, siehe BACKEND-ERWEITERUNG.md)
 *
 * Token gilt im Backend 8 Stunden; bei 401 wird automatisch neu angemeldet.
 */

const CHARGING_THRESHOLD_W = 100;
// Zustände, in denen das Backend die Box bereits "in Arbeit" hat
const BUSY_STATES = ['REQUESTED', 'WAITING_FOR_CAR', 'CHARGING', 'STOPPING'];

class BackendClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl   z. B. http://127.0.0.1:8080
   * @param {string} opts.username
   * @param {string} opts.password
   */
  constructor({ baseUrl, username, password }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.username = username || 'admin';
    this.password = password;
    this.token = null;
  }

  async _login() {
    const res = await fetch(`${this.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.token) {
      throw new Error(`Backend-Login fehlgeschlagen (${res.status}): ${body.error || 'kein Token'}`);
    }
    this.token = body.token;
  }

  /** Request mit Admin-Token; bei 401 einmal neu anmelden. Gibt { status, body } zurück. */
  async request(method, path, payload, { auth = true, retry = true } = {}) {
    if (auth && !this.token) await this._login();
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers['X-Auth-Token'] = this.token;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (auth && res.status === 401 && retry) {
      this.token = null;
      return this.request(method, path, payload, { auth, retry: false });
    }
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  async getWallbox(id) {
    const { status, body } = await this.request('GET', '/api/state', undefined, { auth: false });
    if (status !== 200) throw new Error(`Status nicht lesbar (${status}): ${body.error || ''}`);
    const wb = (body.wallboxen || []).find((w) => String(w.id) === String(id));
    if (!wb) throw new Error(`Wallbox ${id} nicht im Backend gefunden`);
    return wb;
  }
}

/** Gemeinsamer Status-Umbau für beide Wallboxen. */
function toStatus(wb) {
  const powerW = Math.round(Number(wb.power) || 0);
  return {
    online: !!wb.online,
    charging: powerW >= CHARGING_THRESHOLD_W,
    carPluggedIn: !!wb.carConnected,
    powerW,
    session: wb.session || null,
    payRequired: !!wb.pay_required,
    state: wb.fsmState || wb.state,
    busy: BUSY_STATES.includes(wb.fsmState || wb.state),
  };
}

/**
 * Steuerbare Wallbox (P30X) über das Backend.
 * Erfüllt die Schnittstelle von alexa-bridge.js: getStatus / setEnabled / setCurrent.
 */
class BackendWallbox {
  constructor(client, id, { defaultAmps = 16, log = () => {} } = {}) {
    this.client = client;
    this.id = id;
    this.amps = defaultAmps;
    this.log = log;
    this.hasCurrentEndpoint = true; // wird beim ersten 404 auf false gesetzt
    this.pendingAmps = null;        // Strom, der gesetzt wird, sobald wirklich geladen wird
    this.pendingTimer = null;
  }

  async getStatus() {
    return toStatus(await this.client.getWallbox(this.id));
  }

  async setEnabled(on) {
    if (on) {
      const st = await this.getStatus();
      if (st.session || st.busy) {
        this.log(`[Backend] ${this.id}: bereits gestartet (${st.state}) – nichts zu tun`);
        return;
      }
      await this._start(this.amps);
    } else {
      // Das Backend lehnt einen Stopp ohne Session ab -> vorher prüfen
      const st = await this.getStatus();
      if (!st.session && !st.busy) {
        this.log(`[Backend] ${this.id}: keine Session aktiv – nichts zu stoppen`);
        return;
      }
      if (!st.session && st.state !== 'CHARGING') {
        // Bekannter Backend-Fall: Der Session-Aufräumer schließt die Session nach
        // 2 Min ohne Auto, die Box wartet aber noch bis zu 10 Min (WAITING_FOR_CAR).
        // /stop kann ohne Session nichts beenden; es fließt kein Strom -> Ziel erreicht.
        this.log(`[Backend] ${this.id}: ${st.state} ohne Session – lädt nicht, Backend gibt die Box per Timeout frei`);
        return;
      }
      const { status, body } = await this.client.request('POST', `/api/wallbox/${this.id}/stop`, {});
      if (status !== 200 || body.ok === false) {
        if (!st.session) {
          throw new Error(`Backend hat Zustand ${st.state}, aber keine aktive Session – Stopp im Wallbox Manager oder Timeout abwarten (${body.error || status})`);
        }
        throw new Error(`Stopp abgelehnt (${status}): ${body.error || ''}`);
      }
    }
  }

  async setCurrent(amps) {
    this.amps = amps;
    const st = await this.getStatus();
    if (!st.session && !st.busy) {
      // Keine laufende Session: Wert merken, gilt beim nächsten "ein"
      this.log(`[Backend] ${this.id}: ${amps} A gemerkt (wird beim nächsten Start verwendet)`);
      return;
    }
    if (st.state !== 'CHARGING') {
      // Session wartet noch auf das Auto: Backend erlaubt Strom erst im Ladezustand
      this._schedulePending(amps);
      return;
    }
    if (this.hasCurrentEndpoint) {
      const { status, body } = await this.client.request('POST', `/api/wallbox/${this.id}/current`, { current: amps });
      if (status === 200 && body.ok !== false) return;
      if (status !== 404) throw new Error(`Ladestrom abgelehnt (${status}): ${body.error || ''}`);
      this.hasCurrentEndpoint = false;
      this.log('[Backend] Endpunkt /current fehlt – nutze Stopp + Neustart (siehe BACKEND-ERWEITERUNG.md)');
    }
    // Fallback ohne /current-Endpunkt: Session beenden und mit neuem Strom neu starten
    await this.setEnabled(false);
    await this._start(amps);
  }

  async _start(amps) {
    const { status, body } = await this.client.request('POST', `/api/wallbox/${this.id}/start`, { current: amps });
    if (status === 200 && body.ok !== false) return;
    // Das Backend legt die Session an und geht in "Warten auf Auto"; danach
    // scheitert sein eigenes setCurrent mit "Nicht im Ladezustand." (400).
    // Die Session existiert trotzdem -> als Erfolg werten und den Strom
    // nachziehen, sobald das Auto lädt.
    if (status === 400) {
      const st = await this.getStatus().catch(() => null);
      if (st && (st.session || st.busy)) {
        this.log(`[Backend] ${this.id}: Session angelegt, wartet auf Auto (${st.state})`);
        this._schedulePending(amps);
        return;
      }
    }
    throw new Error(`Start abgelehnt (${status}): ${body.error || ''}`);
  }

  /** Merkt sich den Wunschstrom und setzt ihn, sobald das Backend im Zustand CHARGING ist. */
  _schedulePending(amps, intervalMs = 30000) {
    this.pendingAmps = amps;
    this.log(`[Backend] ${this.id}: ${amps} A werden gesetzt, sobald das Auto lädt`);
    if (this.pendingTimer) return;
    this.pendingTimer = setInterval(() => this._applyPending().catch((err) => {
      this.log(`[Backend] ${this.id}: Strom nachziehen fehlgeschlagen: ${err.message}`);
    }), intervalMs);
    if (this.pendingTimer.unref) this.pendingTimer.unref();
  }

  async _applyPending() {
    if (this.pendingAmps == null) return this._clearPending();
    const st = await this.getStatus();
    if (!st.session && !st.busy) {
      this.log(`[Backend] ${this.id}: Session beendet – gemerkter Strom verworfen`);
      return this._clearPending();
    }
    if (st.state !== 'CHARGING') return; // weiter warten
    const amps = this.pendingAmps;
    this._clearPending();
    if (!this.hasCurrentEndpoint) {
      this.log(`[Backend] ${this.id}: lädt mit Backend-Maximum (ohne /current-Endpunkt kein Nachregeln)`);
      return;
    }
    const { status, body } = await this.client.request('POST', `/api/wallbox/${this.id}/current`, { current: amps });
    if (status === 404) {
      this.hasCurrentEndpoint = false;
      this.log(`[Backend] ${this.id}: lädt mit Backend-Maximum (Endpunkt /current fehlt, siehe BACKEND-ERWEITERUNG.md)`);
      return;
    }
    if (status !== 200 || body.ok === false) throw new Error(`Ladestrom abgelehnt (${status}): ${body.error || ''}`);
    this.log(`[Backend] ${this.id}: Ladestrom ${amps} A gesetzt`);
  }

  _clearPending() {
    this.pendingAmps = null;
    if (this.pendingTimer) clearInterval(this.pendingTimer);
    this.pendingTimer = null;
  }

  stop() {
    this._clearPending();
  }
}

/** Nur-Lese-Wallbox (P30C): hat bewusst KEIN setEnabled / setCurrent. */
class BackendReadOnlyWallbox {
  constructor(client, id) {
    this.client = client;
    this.id = id;
  }

  async getStatus() {
    return toStatus(await this.client.getWallbox(this.id));
  }
}

module.exports = { BackendClient, BackendWallbox, BackendReadOnlyWallbox, toStatus };
