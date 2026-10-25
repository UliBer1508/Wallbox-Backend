// src/server.js
//
// SCHICHT 4 (Backend) — REST-API & Auslieferung
// =============================================
// Verdrahtet alle Schichten und stellt die HTTP-API bereit:
//   config.js → keba.js (Schicht 1) → manager.js (Schicht 2)
//             → facade.js (Schicht 3) → stripe.js (Schicht 3b) + db.js
//
// server.js redet mit der FASSADE (Schicht 3) und mit db/stripe —
// NIEMALS direkt mit manager.js oder keba.js. (Schichtentrennung.)
//
// Features:
//   - Liefert index.html (Admin) + guest.html (Gäste, ?wb=p30c|p30x) aus
//   - Login gegen users-Tabelle (db.js), Token-basiert, gilt auf allen
//     drei Ansichten (Admin + beide Gäste-Seiten) = voller Admin-Zugang
//   - Bezahl-Schalter pro Box (pay_required_*), serverseitig erzwungen
//   - Bezahl-Schalter wird NUR von Hand umgelegt (keine Auto-Rücksetzung mehr,
//     25.10.2026: sie setzte nur die DB, nicht den Manager -> Anzeige "an",
//     Box aber offen)
//   - E-Mail an NOTIFY_EMAIL (.env), wenn bei Bezahlung AN ein Auto angesteckt
//     wird oder die Sperre/der Stopp nicht greift
//   - Stripe-Gäste-Flow (request/confirm/stop) + Live-Status
//   - bindet upload.js ein (Datei-Upload, eigenes Login dort bleibt kompatibel)
//
// ES-Modul. Benötigt: express, cors, dotenv, stripe, better-sqlite3, modbus-serial

import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cfg from './config.js';
import { KebaCharger } from './keba.js';
import { WallboxManager } from './manager.js';
import { WallboxFacade } from './facade.js';
import { WallboxDB } from './db.js';
import { StripeBilling } from './stripe.js';
import { Mailer } from './mailer.js';
import { listServices, startService, stopService } from './services.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

// ---------------------------------------------------------------------------
// Admin-Token-Sessions (im Speicher; einfache, robuste Lösung)
// ---------------------------------------------------------------------------

const adminSessions = new Map();   // token -> { username, expires }
const ADMIN_TTL_MS = 8 * 60 * 60 * 1000;   // 8 Stunden

function createAdminToken(username) {
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.set(token, { username, expires: Date.now() + ADMIN_TTL_MS });
  return token;
}
function validAdmin(token) {
  if (!token) return null;
  const s = adminSessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { adminSessions.delete(token); return null; }
  return s;
}
function getToken(req) {
  return req.get('X-Auth-Token') || (req.body && req.body.token) || req.query.token || '';
}
// Middleware: Admin-Login erzwingen
function requireAdmin(req, res, next) {
  const s = validAdmin(getToken(req));
  if (!s) return res.status(401).json({ ok: false, error: 'Nicht angemeldet.' });
  req.admin = s;
  next();
}

// ---------------------------------------------------------------------------
// Backend zusammenbauen
// ---------------------------------------------------------------------------

/**
 * Baut die ganze Schichtenkette + Express-App.
 * @param {object} [opts]
 * @param {object} [opts.driverFactory]  (cfg) => Schicht-1-Treiber. Default: echte KebaCharger.
 *                                        In der Sandbox wird hier mock-keba injiziert.
 * @param {object} [opts.stripeClient]   Stripe-Client. Default: echter Stripe (aus .env).
 * @param {string} [opts.dbFile]         SQLite-Datei. Default: sessions.db.
 * @param {object} [opts.dbDatabase]     better-sqlite3-Ersatz (nur Tests).
 * @returns {Promise<{ app, db, facade, manager, billing }>}
 */
export async function buildServer(opts = {}) {
  // --- Schicht 1: Treiber pro Box ---
  const driverFactory = opts.driverFactory ?? ((c) => new KebaCharger({
    host: c.host, port: c.port, unitId: c.unitId, name: c.name,
  }));
  const units = cfg.wallboxes.map((c) => ({ cfg: c, driver: driverFactory(c) }));

  // --- Schicht 2: Manager ---
  const manager = new WallboxManager({ units, middle: cfg.middle });

  // --- Schicht 3: Fassade ---
  const facade = new WallboxFacade(manager, {
    wallboxIds: cfg.wallboxes.map((w) => w.id),
    minCurrentA: Math.min(...cfg.wallboxes.map((w) => w.minCurrentA ?? 6)),
    maxCurrentA: Math.max(...cfg.wallboxes.map((w) => w.maxCurrentA ?? 16)),
  });

  // --- Datenschicht ---
  const db = new WallboxDB({ file: opts.dbFile, Database: opts.dbDatabase, defaults: cfg });

  // Beim ersten Start: Default-Admin anlegen, falls noch kein User existiert.
  // Passwort aus .env ADMIN_PASSWORD (Fallback: 'admin' — UNBEDINGT ändern!).
  if (db.countUsers() === 0) {
    const pw = process.env.ADMIN_PASSWORD || 'admin';
    db.createUser('admin', pw);
    if (!process.env.ADMIN_PASSWORD) {
      console.warn('[server] WARNUNG: Kein ADMIN_PASSWORD in .env — Default-Login admin/admin. Bitte ändern!');
    }
  }

  // --- Schicht 3b: Stripe-Abrechnung ---
  const stripeClient = opts.stripeClient ?? await makeRealStripe();
  const billing = new StripeBilling({
    facade, db, stripe: stripeClient, config: cfg.payment,
    publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  });

  // E-Mail-Versand (Gmail). Ohne MAIL_USER/MAIL_PASS in .env ist er deaktiviert
  // und das System läuft normal weiter (nur ohne Quittungs-Mails).
  const mailer = new Mailer({
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
    fromName: process.env.MAIL_FROM_NAME || 'Steinbock Chalets',
    logger: db,
  });
  mailer.verify().catch(() => {});

  // --- Nach Ladeende: DB-Session abschliessen + Quittung ---
  facade.on('chargingStopped', ({ wallboxId, sessionId }) => {
    // DB-Session sauber abschliessen (verhindert haengende 'active'-Sessions)
    try {
      const sess = sessionId ? db.getSession(sessionId) : db.getActiveSession(wallboxId);
      if (sess && (sess.status === 'active' || sess.status === 'pending')) {
        db.updateSession(sess.id, { status: 'completed', ended_at: new Date().toISOString() });
        db.log('session_closed', { wallboxId, sessionId: sess.id, details: 'chargingStopped' });
      }
    } catch (e) { db.log('session_close_error', { wallboxId, details: e.message }); }
    // KEINE Auto-Rücksetzung des Bezahl-Schalters mehr (25.10.2026).
    // Grund: sie setzte nur die DB auf "Bezahlung an", der Manager blieb im
    // Lese-Modus -> Anzeige "an", Box aber offen. Ausserdem gilt: Bezahlung AUS
    // = Uli selbst, bleibt aus, bis er es im Admin umlegt.
    // Quittungs-Mail verschicken. settle() (in stripe.js) erzeugt die Rechnung
    // ebenfalls über das chargingStopped-Event — daher kurz warten, dann die
    // fertige Rechnung holen und mailen. Fehler blockieren nichts.
    setTimeout(async () => {
      try {
        const sid = sessionId || db.getActiveSession(wallboxId)?.id;
        if (!sid) return;
        const inv = db.getInvoiceBySession(sid);
        if (inv && inv.guest_email) {
          await mailer.sendReceipt(inv);
        } else {
          db.log('mail_no_invoice', { wallboxId, sessionId: sid, details: 'keine Rechnung/Email (evtl. unter Mindestbetrag storniert)' });
        }
      } catch (e) { db.log('mail_after_stop_error', { wallboxId, details: e.message }); }
    }, 800);
  });
  // Protokoll: Lade-Events in die DB
  facade.on('chargingStarted', ({ wallboxId, sessionId }) => db.log('chargingStarted', { wallboxId, sessionId }));

  // --- Warte-auf-Auto: Gast bezahlt, aber kein Auto angesteckt ---
  // Bei Timeout (10 Min) ODER Abbruch durch den Gast: Stripe-Reservierung
  // komplett freigeben (cancelAuthorization setzt die Session auf 'cancelled'
  // und bucht nichts ab). Kein Geld wird berechnet, da 0 kWh geladen wurden.
  facade.on('waitTimeout', async ({ wallboxId, sessionId }) => {
    try {
      if (sessionId) await billing.cancelAuthorization(sessionId);
      db.log('wait_timeout', { wallboxId, sessionId, details: 'kein Auto in der Wartezeit angesteckt' });
    } catch (e) { db.log('wait_timeout_error', { wallboxId, sessionId, details: e.message }); }
  });
  facade.on('requestCancelled', async ({ wallboxId, sessionId }) => {
    try {
      if (sessionId) await billing.cancelAuthorization(sessionId);
      db.log('request_cancelled', { wallboxId, sessionId, details: 'Gast hat abgebrochen / Vormerkung verworfen' });
    } catch (e) { db.log('request_cancelled_error', { wallboxId, sessionId, details: e.message }); }
  });
  facade.on('waitingForCar', ({ wallboxId, sessionId }) => db.log('waiting_for_car', { wallboxId, sessionId }));

  // === BENACHRICHTIGUNG an den Betreiber ==================================
  // Empfänger aus .env: NOTIFY_EMAIL=adresse1,adresse2 (nicht im Code, da Repo).
  //  - Auto angesteckt bei Bezahlung AN  -> Mail (max. 1 pro Box in 10 Min)
  //  - Sperre/Stopp greift nicht (LOCK_FAILED, STOP_FORCED) -> Alarm-Mail
  //    (max. 1 pro Box und Fehlerart in 30 Min)
  // Bei Bezahlung AUS (= Uli selbst) wird NICHTS verschickt.
  // In den ersten 60 s nach dem Start keine Einsteck-Mails: der erste Poll
  // meldet ein bereits steckendes Auto sonst bei jedem Neustart als "neu".
  const notifyTo = (process.env.NOTIFY_EMAIL || '').split(',').map((s) => s.trim()).filter(Boolean);
  const NOTIFY_STARTUP_QUIET_MS = (cfg.middle.notifyStartupQuietSec ?? 60) * 1000;
  const NOTIFY_PLUG_DEBOUNCE_MS = (cfg.middle.notifyPlugDebounceMin ?? 10) * 60 * 1000;
  const NOTIFY_ALARM_DEBOUNCE_MS = 30 * 60 * 1000;
  const NOTIFY_PLUG_DELAY_MS = (cfg.middle.notifyPlugDelaySec ?? 15) * 1000;   // kurz warten: lädt es / greift die Sperre?
  const serverStartTs = Date.now();
  const lastNotice = new Map();             // "plug:p30c" -> ts

  function debounced(key, ms) {
    const last = lastNotice.get(key) || 0;
    if (Date.now() - last < ms) return true;
    lastNotice.set(key, Date.now());
    return false;
  }
  function zeitText(ts = Date.now()) {
    return new Date(ts).toLocaleString('de-AT', { timeZone: 'Europe/Vienna' });
  }
  const payOn = (id) => db.getSetting(`pay_required_${id}`) !== false;
  const boxName = (id) => cfg.wallboxes.find((w) => w.id === id)?.name || id;

  async function sendPlugNotice(wallboxId, plugTs) {
    try {
      if (!payOn(wallboxId)) return;
      const st = await facade.getState(wallboxId).catch(() => null);
      const hw = st?.hardware || {};
      if (!hw.plugged) return;   // inzwischen wieder abgesteckt -> keine Mail
      const sess = db.getActiveSession(wallboxId);
      const fsm = st?.fsmState || 'unbekannt';
      const watt = Math.round(hw.watt ?? 0);
      let lage;
      if (sess && !sess.free_charge) {
        lage = `Bezahlte Session von ${sess.guest_name || 'Gast'}`
          + (sess.guest_email ? ` (${sess.guest_email})` : '')
          + `, Modus: ${sess.mode === 'limit' ? `bis ${sess.limit_amount} EUR` : 'voll laden'}.`;
      } else if (sess && sess.free_charge) {
        lage = `Gratis-Session (${sess.guest_name || 'Admin'}) - von dir gestartet.`;
      } else if (fsm === 'REQUESTED') {
        lage = 'Gast ist gerade beim Bezahlen (noch nicht bezahlt). Die Box bleibt gesperrt.';
      } else {
        lage = 'KEINE bezahlte Session. Die Box ist gesperrt - es wird nicht geladen.';
      }
      const text =
`Auto angesteckt an ${boxName(wallboxId)}

Zeit:      ${zeitText(plugTs)}
Lage:      ${lage}
Jetzt:     ${watt > 50 ? `lädt mit ${watt} W` : 'lädt nicht'} (Zustand ${fsm})

Admin: ${process.env.PUBLIC_BASE_URL || 'http://localhost:8080'}`;
      const r = await mailer.sendNotice(notifyTo, `🔌 Auto angesteckt: ${boxName(wallboxId)}`, text);
      db.log('notify_plug', { wallboxId, details: { ok: r.ok, skipped: !!r.skipped, lage } });
    } catch (e) { db.log('notify_plug_error', { wallboxId, details: e.message }); }
  }

  facade.on('cablePlugged', ({ wallboxId, ts }) => {
    if (Date.now() - serverStartTs < NOTIFY_STARTUP_QUIET_MS) return;
    if (!payOn(wallboxId)) return;
    if (debounced(`plug:${wallboxId}`, NOTIFY_PLUG_DEBOUNCE_MS)) return;
    const t = setTimeout(() => sendPlugNotice(wallboxId, ts), NOTIFY_PLUG_DELAY_MS);
    if (t.unref) t.unref();
  });

  facade.on('errorOccurred', ({ wallboxId, code, details }) => {
    if (code !== 'LOCK_FAILED' && code !== 'STOP_FORCED') return;
    if (wallboxId && !payOn(wallboxId)) return;
    if (debounced(`alarm:${code}:${wallboxId}`, NOTIFY_ALARM_DEBOUNCE_MS)) return;
    const was = code === 'LOCK_FAILED'
      ? 'Die Sperre konnte NICHT gesetzt werden (Modbus-Fehler). Es könnte ohne Bezahlung geladen werden.'
      : 'Ein Stopp hat nicht gegriffen, die Session wurde zwangsweise beendet und die Box gesperrt.';
    const text =
`ACHTUNG ${boxName(wallboxId)}

Zeit:    ${zeitText()}
Problem: ${was}
Details: ${details || '-'}

Bitte im Admin prüfen: ${process.env.PUBLIC_BASE_URL || 'http://localhost:8080'}`;
    mailer.sendNotice(notifyTo, `⚠️ Wallbox-Alarm: ${boxName(wallboxId)}`, text)
      .then((r) => db.log('notify_alarm', { wallboxId, details: { code, ok: r.ok } }))
      .catch(() => {});
  });
  // ========================================================================

  // --- Live-Energie: während des Ladens energy_kwh + amount laufend setzen ---
  // (Ohne diesen Handler bliebe die Live-Anzeige bei 0 kWh / 0 €, bis die
  //  Session endet. Das Event liefert die seit Ladebeginn gemessene Energie.)
  facade.on('energyUpdated', ({ wallboxId, sessionId, kWh }) => {
    try {
      if (!sessionId || kWh == null) return;
      const price = Number(db.getSetting('price_per_kwh')) || 0;
      const energy = Math.max(0, Number(kWh));
      const amount = +(energy * price).toFixed(2);
      db.updateSession(sessionId, { energy_kwh: energy, amount });
    } catch (e) { db.log('energy_update_error', { wallboxId, sessionId, details: e.message }); }
  });

  // --- Manager starten (verbindet Boxen, beginnt Polling) ---
  await manager.start();

  // Initialen Bezahl-Modus aus der DB an den Manager geben (Lese-/Sperr-Modus).
  for (const w of cfg.wallboxes) {
    const req = db.getSetting(`pay_required_${w.id}`) !== false; // Default: true
    try { await manager.setPayRequired(w.id, req); } catch (e) { db.log('pay_init_error', { wallboxId: w.id, details: e.message }); }
  }

  // === GRATIS-DOKUMENTATION (Auto-Ladung bei Bezahlung AUS) ================
  // Steckt bei pay_required=false ein Auto an, ohne dass jemand etwas klickt
  // (Tesla-Ueberschuss-Modus), wird das jetzt als Gratis-Session dokumentiert:
  //   - Einstecken  -> Session 'Auto-Ladung' anlegen (free_charge=1)
  //   - alle 30 s   -> kWh + Ersparnis-Betrag aus Zaehlerstand aktualisieren
  //   - Abstecken   -> Session mit finalen kWh abschliessen
  // Der Start-Zaehlerstand wird in der note gespeichert (start_total_kwh=...),
  // dadurch ueberlebt die Messung auch einen Backend-Neustart exakt
  // (Prinzip: Abrechnung ueber Gesamtzaehlerstand, wie ueberall im Projekt).
  // Der Bezahl-Schalter wird hierbei bewusst NICHT zurueckgesetzt — der
  // Tesla-Modus bleibt an, bis er im Admin umgelegt wird (wie bisher).

  const AUTO_GUEST_NAME = 'Auto-Ladung';
  const AUTO_UPDATE_MS = 30 * 1000;   // Live-Aktualisierung alle 30 s

  function autoNoteStartKwh(note) {
    const m = String(note || '').match(/start_total_kwh=([\d.]+)/);
    return m ? Number(m[1]) : null;
  }
  function findOpenAutoSession(wallboxId) {
    const s = db.getActiveSession(wallboxId);
    return (s && s.free_charge && s.guest_name === AUTO_GUEST_NAME) ? s : null;
  }
  function priceNow() { return Number(db.getSetting('price_per_kwh')) || 0; }

  function openAutoSession(wallboxId, totalKwh) {
    if (db.getSetting(`pay_required_${wallboxId}`) !== false) return null; // nur bei Bezahlung AUS
    if (db.getActiveSession(wallboxId)) return null;                       // es laeuft schon eine Session
    const id = 's_auto_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const wb = cfg.wallboxes.find((w) => w.id === wallboxId);
    db.createSession({
      id, wallbox_id: wallboxId, wallbox_name: wb?.name,
      guest_name: AUTO_GUEST_NAME, mode: 'voll', free_charge: 1, status: 'active',
      note: `auto-gratis;start_total_kwh=${totalKwh ?? ''}`,
      started_at: new Date().toISOString(),
    });
    db.log('auto_session_start', { wallboxId, sessionId: id, details: { start_total_kwh: totalKwh } });
    return id;
  }

  function closeAutoSession(sess, { totalKwh = null, kwhSincePlug = null, reason = '' } = {}) {
    const startKwh = autoNoteStartKwh(sess.note);
    let energy;
    if (totalKwh != null && startKwh != null) energy = Math.max(0, totalKwh - startKwh);
    else if (kwhSincePlug != null) energy = Math.max(0, kwhSincePlug);
    else energy = Math.max(0, sess.energy_kwh ?? 0);   // Fallback: letzter Live-Stand
    const amount = +(energy * priceNow()).toFixed(2);
    db.updateSession(sess.id, {
      energy_kwh: energy, amount,
      status: 'completed', ended_at: new Date().toISOString(),
      note: (sess.note ? sess.note + ' ' : '') + (reason ? `[${reason}]` : ''),
    });
    db.log('auto_session_end', { wallboxId: sess.wallbox_id, sessionId: sess.id, details: { energy, amount, reason } });
  }

  // Einstecken -> Gratis-Session anlegen (nur wenn Bezahlung AUS, keine Session)
  facade.on('cablePlugged', ({ wallboxId, totalKwh }) => {
    try { openAutoSession(wallboxId, totalKwh); }
    catch (e) { db.log('auto_session_start_error', { wallboxId, details: e.message }); }
  });

  // Abstecken -> offene Gratis-Session mit finalen kWh abschliessen
  facade.on('cableDisconnected', ({ wallboxId, kwhSincePlug, totalKwh }) => {
    try {
      const sess = findOpenAutoSession(wallboxId);
      if (sess) closeAutoSession(sess, { totalKwh, kwhSincePlug, reason: 'abgesteckt' });
    } catch (e) { db.log('auto_session_end_error', { wallboxId, details: e.message }); }
  });

  // Live-Aktualisierung: kWh + Ersparnis der offenen Gratis-Sessions
  async function updateAutoSessions() {
    for (const w of cfg.wallboxes) {
      try {
        const sess = findOpenAutoSession(w.id);
        if (!sess) continue;
        const st = await facade.getState(w.id);
        const totalKwh = st?.hardware?.totalKwh;
        const startKwh = autoNoteStartKwh(sess.note);
        if (totalKwh == null || startKwh == null) continue;
        const energy = Math.max(0, totalKwh - startKwh);
        db.updateSession(sess.id, { energy_kwh: energy, amount: +(energy * priceNow()).toFixed(2) });
      } catch (e) { db.log('auto_session_update_error', { wallboxId: w.id, details: e.message }); }
    }
  }
  const autoTimer = setInterval(updateAutoSessions, AUTO_UPDATE_MS);
  if (autoTimer.unref) autoTimer.unref();

  // Neustart-Wiederaufnahme (verzoegert, damit der erste Poll-Zyklus durch ist):
  //   - offene Gratis-Session + Auto steckt noch + Bezahlung AUS -> weiterfuehren
  //     (kWh stimmen exakt, da Start-Zaehlerstand in der note steht)
  //   - offene Gratis-Session, aber Auto weg oder Bezahlung AN -> abschliessen
  //   - keine Session, aber Auto steckt + Bezahlung AUS -> jetzt anlegen
  setTimeout(async () => {
    for (const w of cfg.wallboxes) {
      try {
        const st = await facade.getState(w.id);
        if (!st?.hardware) continue;   // noch kein Snapshot -> nicht raten
        const plugged = !!st.hardware.plugged;
        const totalKwh = st.hardware.totalKwh ?? null;
        const payOff = db.getSetting(`pay_required_${w.id}`) === false;
        const sess = findOpenAutoSession(w.id);
        if (sess && (!plugged || !payOff)) {
          closeAutoSession(sess, { totalKwh: plugged ? totalKwh : null, reason: 'nach Neustart geschlossen' });
        } else if (!sess && payOff && plugged) {
          openAutoSession(w.id, totalKwh);
        }
      } catch (e) { db.log('auto_session_recover_error', { wallboxId: w.id, details: e.message }); }
    }
  }, 15 * 1000);

  const autoGratis = { open: openAutoSession, close: closeAutoSession, find: findOpenAutoSession };
  // ========================================================================

  // === AUTO-AUFRÄUMER für hängende Sessions ===============================
  // Sicherheitsnetz gegen Abstürze/Stromausfall. Schliesst NUR die DB-Session
  // (Hardware wird NIE angefasst). Regeln bewusst konservativ:
  //   - pending + älter als X Min  -> beenden (Zahlung kam nie)
  //   - active  + Auto ABGESTECKT  -> beenden (Auto weg, Session blieb)
  //   - Auto ANGESTECKT (egal wie lange) -> NIEMALS anfassen (Tesla-Überschuss!)
  //   - Strom fliesst (watt>50)    -> NIEMALS anfassen (lädt gerade)
  const CLEANUP_INTERVAL_MS = (cfg.middle.cleanupIntervalSec ?? 180) * 1000;   // alle 3 Min prüfen
  const CLEANUP_UNPLUG_GRACE_MS = (cfg.middle.cleanupUnplugGraceSec ?? 120) * 1000; // 2 Min Karenz bei abgestecktem Auto

  async function runSessionCleanup() {
    try {
      if (db.getSetting('cleanup_enabled') === false) return;   // per Admin abschaltbar
      const pendingMin = Number(db.getSetting('cleanup_pending_minutes')) || 15;
      const now = Date.now();
      const open = db.listOpenSessions();
      for (const s of open) {
        const startTs = s.started_at ? new Date(s.started_at).getTime() : 0;
        const alterMs = now - startTs;
        // Live-Zustand der Box holen (Auto angesteckt? Strom?)
        let plugged = false, watt = 0, st = null;
        try {
          st = await facade.getState(s.wallbox_id);
          plugged = !!st?.hardware?.plugged;
          watt = st?.hardware?.watt ?? 0;
        } catch { /* Box nicht erreichbar -> vorsichtshalber NICHT anfassen */ continue; }

        // SCHUTZ (25.10.2026, Fehler 3.2): Gehört die Session gerade dem
        // Manager (wartet auf Auto, lädt, stoppt), NIEMALS hier beenden. Der
        // Manager hat eigene Timeouts. Früher wurde eine bezahlte Session nach
        // 2 Min ohne Auto geschlossen; steckte der Gast später an, lud er,
        // aber settle() sah "completed" und buchte nichts ab.
        const owned = st?.session?.sessionId === s.id;
        if (owned && ['WAITING_FOR_CAR', 'CHARGING', 'STOPPING'].includes(st?.fsmState)) continue;

        // Unbezahlte Vormerkung, die der Manager noch hält (REQUESTED): über den
        // Manager abbrechen (gibt Reservierung frei, Box bleibt gesperrt) — sonst
        // bliebe die Box in REQUESTED hängen und kein Gast könnte mehr starten.
        if (s.status === 'pending' && owned && st?.fsmState === 'REQUESTED' &&
            alterMs > pendingMin * 60 * 1000) {
          await facade.cancelRequest(s.wallbox_id, s.id).catch(() => {});
          db.log('session_auto_cleanup', { wallboxId: s.wallbox_id, sessionId: s.id,
            details: `pending > ${pendingMin} Min, Vormerkung im Manager abgebrochen` });
          continue;
        }

        // SCHUTZ: Auto angesteckt oder Strom fliesst -> niemals beenden.
        if (plugged || watt > 50) continue;

        let beenden = false, grund = '';
        if (s.status === 'pending' && alterMs > pendingMin * 60 * 1000) {
          beenden = true; grund = `pending > ${pendingMin} Min, Zahlung nie abgeschlossen`;
        } else if (s.status === 'active' && !plugged && alterMs > CLEANUP_UNPLUG_GRACE_MS) {
          beenden = true; grund = 'active, aber kein Auto angesteckt';
        }

        if (beenden) {
          db.updateSession(s.id, {
            status: 'completed',
            ended_at: new Date().toISOString(),
            note: (s.note ? s.note + ' ' : '') + '[auto-aufgeräumt]',
          });
          db.log('session_auto_cleanup', { wallboxId: s.wallbox_id, sessionId: s.id, details: grund });
        }
      }
    } catch (e) {
      db.log('cleanup_error', { details: e.message });
    }
  }
  const cleanupTimer = setInterval(runSessionCleanup, CLEANUP_INTERVAL_MS);
  if (cleanupTimer.unref) cleanupTimer.unref();   // blockiert Prozess-Ende nicht
  // ========================================================================

  // --- Express ---
  const app = express();
  app.use(cors());
  app.use(express.json());

  registerRoutes(app, { db, facade, billing, manager, autoGratis });

  // upload.js einbinden (falls vorhanden). Wir geben unsere Token-Prüfung
  // mit, damit EIN Login für Admin UND Datei-Upload gilt, und unterdrücken
  // das doppelte /api/login aus upload.js.
  try {
    const { registerUploadRoutes } = await import('./upload.js');
    registerUploadRoutes(app, {
      validateToken: (token) => !!validAdmin(token),
      skipLogin: true,
    });
  } catch (e) {
    console.warn('[server] upload.js nicht eingebunden:', e.message);
  }

  return { app, db, facade, manager, billing };
}

// Echten Stripe-Client lazy laden (nur wenn gebraucht).
async function makeRealStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.warn('[server] WARNUNG: STRIPE_SECRET_KEY fehlt — Bezahlung wird fehlschlagen.');
  }
  const Stripe = (await import('stripe')).default;
  return new Stripe(key || 'sk_test_missing');
}

// ---------------------------------------------------------------------------
// Routen
// ---------------------------------------------------------------------------

function registerRoutes(app, { db, facade, billing, manager, autoGratis }) {
  const wbIds = new Set(cfg.wallboxes.map((w) => w.id));
  const wbCfg = (id) => cfg.wallboxes.find((w) => w.id === id);

  // --- Statische Seiten ---
  app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
  app.get(['/guest', '/guest.html'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'guest.html')));
  app.use(express.static(PUBLIC_DIR));

  // --- Login (gegen users-Tabelle) ---
  // Hinweis: upload.js bringt ein eigenes /api/login (Passwort aus .env) mit.
  // Diese Route hier wird ZUERST registriert und gewinnt → einheitlicher
  // Admin-Login über die users-Tabelle für alle drei Ansichten.
  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    // Erlaubt auch reines Passwort-Login (Kompatibilität mit altem Upload-Login):
    const user = username
      ? db.verifyUser(username, password)
      : db.verifyUser('admin', password);
    if (!user) return res.status(401).json({ ok: false, error: 'Login fehlgeschlagen.' });
    const token = createAdminToken(user.username);
    db.log('login', { details: { username: user.username } });
    res.json({ ok: true, token, username: user.username });
  });

  app.get('/api/me', (req, res) => {
    const s = validAdmin(getToken(req));
    res.json({ ok: !!s, username: s?.username || null });
  });

  // --- Live-Status beider Boxen (für Admin + Gäste-Seite) ---
  app.get('/api/state', async (req, res) => {
    try {
      const payload = await buildState(facade, db);
      res.json(payload);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- Einstellungen lesen (öffentlich: Preis; Schalterzustand mitliefern) ---
  app.get('/api/settings', (req, res) => {
    res.json({
      price_per_kwh: db.getSetting('price_per_kwh'),
      reserve_amount: db.getSetting('reserve_amount'),
      currency: db.getSetting('currency'),
      pay_required_p30c: db.getSetting('pay_required_p30c'),
      pay_required_p30x: db.getSetting('pay_required_p30x'),
      cleanup_enabled: db.getSetting('cleanup_enabled') !== false,   // Default: an
      cleanup_pending_minutes: Number(db.getSetting('cleanup_pending_minutes')) || 15,
    });
  });

  // --- Einstellungen ändern (nur Admin) ---
  app.post('/api/settings', requireAdmin, (req, res) => {
    const b = req.body || {};
    if (b.price_per_kwh != null) db.setSetting('price_per_kwh', Number(b.price_per_kwh));
    if (b.reserve_amount != null) db.setSetting('reserve_amount', Number(b.reserve_amount));
    if (b.cleanup_enabled != null) db.setSetting('cleanup_enabled', !!b.cleanup_enabled);
    if (b.cleanup_pending_minutes != null) {
      const m = Math.max(1, Math.min(240, Number(b.cleanup_pending_minutes) || 15));
      db.setSetting('cleanup_pending_minutes', m);
    }
    db.log('settings_changed', { details: b });
    res.json({ ok: true });
  });

  // --- Bezahl-Schalter pro Box (nur Admin) ---
  app.post('/api/wallbox/:id/payment', requireAdmin, async (req, res) => {
    const id = req.params.id;
    if (!wbIds.has(id)) return res.status(400).json({ ok: false, error: 'Unbekannte Box.' });
    const required = !!(req.body && req.body.required);
    db.setSetting(`pay_required_${id}`, required);
    db.log('pay_switch', { wallboxId: id, details: { required } });
    // Manager informieren: bei "aus" nur lesen (Tesla laedt frei), bei "an" sperren.
    try { await manager.setPayRequired(id, required); } catch (e) { db.log('pay_switch_error', { wallboxId: id, details: e.message }); }
    // Gratis-Dokumentation: Schalter AUS + Auto steckt bereits -> Gratis-Session
    // jetzt oeffnen (Zaehlerstand ab diesem Moment). Schalter AN -> offene
    // Gratis-Session mit finalen kWh abschliessen.
    try {
      const st = await facade.getState(id);
      const totalKwh = st?.hardware?.totalKwh ?? null;
      if (!required) {
        if (st?.hardware?.plugged) autoGratis.open(id, totalKwh);
      } else {
        const sess = autoGratis.find(id);
        if (sess) autoGratis.close(sess, { totalKwh, reason: 'Bezahlung eingeschaltet' });
      }
    } catch (e) { db.log('auto_session_toggle_error', { wallboxId: id, details: e.message }); }
    res.json({ ok: true, wallboxId: id, pay_required: required });
  });

  // --- Lade-Verlauf ---
  app.get('/api/sessions', (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 50);
    res.json({ sessions: db.listSessions(limit).map(sessionRow) });
  });

  // --- Rechnungen / Protokolle / Fehler (nur Admin) ---
  app.get('/api/invoices', requireAdmin, (req, res) =>
    res.json({ invoices: db.listInvoices(Number(req.query.limit) || 100) }));
  app.get('/api/logs', requireAdmin, (req, res) =>
    res.json({ logs: db.listLogs(Number(req.query.limit) || 200) }));
  app.get('/api/errors', requireAdmin, (req, res) =>
    res.json({ errors: db.listErrors(Number(req.query.limit) || 200) }));

  // --- NSSM-Dienste-Dashboard (nur Admin) ---
  // Findet automatisch alle NSSM-Dienste dieses PCs (services.js) und zeigt
  // Status + optional Link/Anzeigename aus services.json. Start/Stop nur fuer
  // real existierende, als steuerbar markierte Dienste.
  app.get('/api/services', requireAdmin, async (req, res) => {
    try {
      const list = await listServices();
      res.json(list);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  app.post('/api/services/:name/start', requireAdmin, async (req, res) => {
    try {
      const result = await startService(req.params.name);
      res.json({ ok: true, ...result });
    } catch (e) {
      const code = e.code === 'SERVICE_FORBIDDEN' ? 403 : 500;
      res.status(code).json({ ok: false, error: e.message });
    }
  });
  app.post('/api/services/:name/stop', requireAdmin, async (req, res) => {
    try {
      const result = await stopService(req.params.name);
      res.json({ ok: true, ...result });
    } catch (e) {
      const code = e.code === 'SERVICE_FORBIDDEN' ? 403 : 500;
      res.status(code).json({ ok: false, error: e.message });
    }
  });

  // --- Admin: manuelles Start/Stop (nur Admin) ---
  app.post('/api/wallbox/:id/start', requireAdmin, async (req, res) => {
    try {
      const id = req.params.id;
      const ampere = Number(req.body?.current) || (wbCfg(id)?.maxCurrentA ?? 16);
      // Offene Auto-Gratis-Session vorher abschliessen (sonst zwei aktive Sessions)
      const openAuto = autoGratis.find(id);
      if (openAuto) {
        const st = await facade.getState(id).catch(() => null);
        autoGratis.close(openAuto, { totalKwh: st?.hardware?.totalKwh ?? null, reason: 'Admin-Start' });
      }
      const { sessionId } = await facade.requestCharge(id, { modus: 'voll' });
      // Admin-Start = direkt laden, ohne Zahlung; als free_charge markieren
      db.createSession({
        id: sessionId, wallbox_id: id, wallbox_name: wbCfg(id)?.name,
        guest_name: 'Admin', mode: 'voll', free_charge: 1, status: 'active',
        started_at: new Date().toISOString(),
      });
      await facade.startCharge(id, sessionId);
      // Fehler 3.1 (20.10.): nach startCharge steht die Box in WAITING_FOR_CAR,
      // setCurrent ist erst in CHARGING erlaubt -> früher HTTP 400, obwohl der
      // Start klappte. Jetzt ignoriert; geladen wird mit maxCurrentA der Box.
      await facade.setCurrent(id, ampere).catch(() => {});
      res.json({ ok: true, sessionId });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.post('/api/wallbox/:id/stop', requireAdmin, async (req, res) => {
    try {
      const id = req.params.id;
      const active = db.getActiveSession(id);
      await facade.stopCharge(id, active?.id);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // --- TEMP TEST-ENDPUNKT: Box hart sperren (Default-Sperre testen) ----------
  // Schickt writeEnable(false)+writeCurrent(0) direkt, unabhaengig vom Zustand.
  // Testzweck: prueft, ob die Sperre einen ladewilligen Tesla draussen haelt.
  // Nach dem Test wieder entfernen.
  app.post('/api/wallbox/:id/block', requireAdmin, async (req, res) => {
    try {
      const id = req.params.id;
      const r = await manager.blockWallbox(id);
      res.json({ ok: true, wallbox: id, ...r });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // --- GÄSTE-FLOW -----------------------------------------------------------

  // 1) Anfrage: Session vormerken. Je nach Bezahl-Schalter mit/ohne Stripe.
  app.post('/api/guest/request', async (req, res) => {
    try {
      const id = req.query.wb || req.body?.wb;
      if (!wbIds.has(id)) return res.status(400).json({ ok: false, error: 'Unbekannte Box.' });

      const { guestName, guestEmail, mode, limitAmount } = req.body || {};
      const payRequired = db.getSetting(`pay_required_${id}`) !== false;
      const price = db.getSetting('price_per_kwh');
      const limitKwh = (mode === 'limit' && limitAmount) ? Number(limitAmount) / price : null;

      // Offene Auto-Gratis-Session vorher abschliessen (sonst zwei aktive Sessions)
      const openAuto = autoGratis.find(id);
      if (openAuto) {
        const st = await facade.getState(id).catch(() => null);
        autoGratis.close(openAuto, { totalKwh: st?.hardware?.totalKwh ?? null, reason: 'Gast-Start' });
      }

      // Vormerkung an der Fassade (Box wird gestoppt gehalten)
      const { sessionId } = await facade.requestCharge(id, {
        modus: mode === 'limit' ? 'limit' : 'voll',
        limit: limitKwh || undefined,
      });

      // Session in DB
      const session = db.createSession({
        id: sessionId, wallbox_id: id, wallbox_name: wbCfg(id)?.name,
        guest_name: guestName || null, guest_email: guestEmail || null,
        mode: mode === 'limit' ? 'limit' : 'voll',
        limit_amount: mode === 'limit' ? Number(limitAmount) : null,
        limit_kwh: limitKwh,
        free_charge: payRequired ? 0 : 1,
        status: payRequired ? 'pending' : 'active',
        started_at: new Date().toISOString(),
      });

      if (!payRequired) {
        // Bezahl-Schalter aus → sofort laden, kein Stripe
        await facade.startCharge(id, sessionId);
        db.log('guest_free_start', { wallboxId: id, sessionId });
        return res.json({ ok: true, sessionId, free: true });
      }

      // Bezahlung nötig → Stripe-Checkout
      const { checkoutUrl } = await billing.authorize(session);
      res.json({ ok: true, sessionId, checkoutUrl });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // 2) Bestätigung nach Stripe-Rückkehr → Ladung starten
  app.post('/api/guest/confirm/:sid', async (req, res) => {
    try {
      const sid = req.params.sid;
      const session = db.getSession(sid);
      if (!session) return res.status(404).json({ ok: false, error: 'Session unbekannt.' });

      if (!session.free_charge) {
        const conf = await billing.confirmAuthorized(session);
        if (!conf.ok) return res.status(402).json({ ok: false, error: 'Zahlung nicht autorisiert.' });
      }
      await facade.startCharge(session.wallbox_id, sid);
      db.updateSession(sid, { status: 'active' });
      res.json({ ok: true, session: sessionRow(db.getSession(sid)) });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // 3) Stop → Abrechnung (settle passiert via chargingStopped-Event)
  app.post('/api/guest/stop/:sid', async (req, res) => {
    try {
      const sid = req.params.sid;
      const session = db.getSession(sid);
      if (!session) return res.status(404).json({ ok: false, error: 'Session unbekannt.' });
      await facade.stopCharge(session.wallbox_id, sid);
      // settle wird durch das chargingStopped-Event ausgelöst; kurz warten,
      // damit die Quittung schon die finalen Werte hat.
      await new Promise((r) => setTimeout(r, 200));
      const fresh = db.getSession(sid);
      res.json({ ok: true, session: sessionRow(fresh), captured: fresh.captured });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // 3b) Abbrechen aus dem Warte-Screen (Gast hat bezahlt, aber kein Auto
  //     angesteckt und bricht ab). Reservierung-Freigabe via requestCancelled.
  app.post('/api/guest/cancel/:sid', async (req, res) => {
    try {
      const sid = req.params.sid;
      const session = db.getSession(sid);
      if (!session) return res.status(404).json({ ok: false, error: 'Session unbekannt.' });
      await facade.cancelRequest(session.wallbox_id, sid);
      const fresh = db.getSession(sid);
      res.json({ ok: true, session: sessionRow(fresh) });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // 4) Live-Status einer Session (für die Gäste-Anzeige, Polling)
  app.get('/api/session-status', async (req, res) => {
    try {
      const id = req.query.wb;
      const sid = req.query.session;
      const st = await facade.getState(id);
      const session = sid ? db.getSession(sid) : db.getActiveSession(id);
      res.json({
        state: st?.hardware?.state || st?.fsmState || 'unknown',
        fsmState: st?.fsmState || 'unknown',
        waitingForCar: st?.fsmState === 'WAITING_FOR_CAR',
        power_w: st?.hardware?.watt ?? 0,
        energy_session_kwh: session?.energy_kwh ?? 0,
        price_per_kwh: db.getSetting('price_per_kwh'),
        modus: session?.mode,
        limit_kwh: session?.limit_kwh,
        started_at: session?.started_at,
        betrag: session?.amount,
        status: session?.status,
        captured: session?.captured,
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}

// ---------------------------------------------------------------------------
// Hilfen: Zustand & Zeilen-Formatierung (Feldnamen wie von Frontends erwartet)
// ---------------------------------------------------------------------------

async function buildState(facade, db) {
  const all = await facade.getAllState();   // [{ wallboxId, name, hardware, session, ... }]
  const wallboxen = [];
  for (const c of cfg.wallboxes) {
    const st = all.find((s) => String(s.wallboxId) === String(c.id)) || {};
    const hw = st.hardware || {};
    const active = db.getActiveSession(c.id);
    wallboxen.push({
      id: c.id,
      name: c.name,
      ip: c.host,
      online: !!st.connected,
      state: hw.state || st.fsmState || 'unknown',
      fsmState: st.fsmState || 'unknown',
      waitingForCar: st.fsmState === 'WAITING_FOR_CAR',
      power: hw.watt ?? 0,
      currents: [hw.l1 ?? 0, hw.l2 ?? 0, hw.l3 ?? 0],
      totalEnergy: hw.totalKwh ?? null,
      carConnected: !!hw.plugged,
      pay_required: db.getSetting(`pay_required_${c.id}`) !== false,
      pluggedSince: st.pluggedSince ?? null,
      pluggedKwh: st.pluggedKwh ?? null,
      session: active ? {
        id: active.id, guestName: active.guest_name,
        energyKwh: active.energy_kwh, amount: active.amount,
        mode: active.mode, limitAmount: active.limit_amount,
        free: !!active.free_charge,
        startedAt: active.started_at,
        status: active.status,
      } : null,
    });
  }
  return {
    pricePerKwh: db.getSetting('price_per_kwh'),
    currency: db.getSetting('currency'),
    reserveAmount: db.getSetting('reserve_amount'),
    wallboxen,
  };
}

function sessionRow(s) {
  if (!s) return null;
  return {
    id: s.id, wallbox_id: s.wallbox_id, wallbox_name: s.wallbox_name,
    guest_name: s.guest_name, mode: s.mode,
    limit_amount: s.limit_amount, limitAmount: s.limit_amount,
    energy_kwh: s.energy_kwh, energyKwh: s.energy_kwh,
    amount: s.amount, captured: s.captured,
    status: s.status, paid: !!s.paid, free: !!s.free_charge,
    started_at: s.started_at, ended_at: s.ended_at, note: s.note,
  };
}

// ---------------------------------------------------------------------------
// Direktstart (node src/server.js)
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  // .env laden
  try { (await import('dotenv')).config(); } catch { /* dotenv optional */ }
  const { app } = await buildServer();
  const port = cfg.system.httpPort || 8080;
  app.listen(port, () => {
    console.log(`Wallbox-Backend läuft auf http://localhost:${port}`);
    console.log(`  Admin:  http://localhost:${port}/`);
    console.log(`  Gäste:  http://localhost:${port}/guest?wb=p30c  (oder ?wb=p30x)`);
  });
}

export default buildServer;
