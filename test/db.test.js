// test/db.test.js
// Tests für die Datenschicht (db.js).
// Ausführen: node --experimental-sqlite --test test/db.test.js
// Nutzt den node:sqlite-Adapter statt better-sqlite3 (Sandbox-Umgebung).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WallboxDB } from '../src/db.js';
import SqliteAdapter from './sqlite-adapter.mjs';

// Frische In-Memory-DB pro Test
function freshDB(defaults) {
  return new WallboxDB({ file: ':memory:', Database: SqliteAdapter, defaults });
}

const cfgDefaults = {
  payment: { pricePerKwh: 0.45, reserveAmountEur: 35, currency: 'eur', minCaptureEur: 0.5 },
};

// --- USERS -------------------------------------------------------------------

test('users: anlegen, prüfen, falsches Passwort', () => {
  const db = freshDB();
  const u = db.createUser('uli', 'geheim123');
  assert.equal(u.username, 'uli');
  assert.ok(db.verifyUser('uli', 'geheim123'));          // richtig
  assert.equal(db.verifyUser('uli', 'falsch'), null);    // falsch
  assert.equal(db.verifyUser('niemand', 'x'), null);     // existiert nicht
  db.close();
});

test('users: mehrere Admins möglich', () => {
  const db = freshDB();
  db.createUser('uli', 'pw1');
  db.createUser('partner', 'pw2');
  assert.equal(db.countUsers(), 2);
  assert.ok(db.verifyUser('partner', 'pw2'));
  const list = db.listUsers();
  assert.equal(list.length, 2);
  assert.ok(!('pw_hash' in list[0]));   // Hash wird NICHT mit ausgeliefert
  db.close();
});

test('users: doppelter Name wirft', () => {
  const db = freshDB();
  db.createUser('uli', 'pw');
  assert.throws(() => db.createUser('uli', 'pw2'));
  db.close();
});

test('users: Passwort ändern', () => {
  const db = freshDB();
  db.createUser('uli', 'alt');
  assert.ok(db.changePassword('uli', 'neu'));
  assert.equal(db.verifyUser('uli', 'alt'), null);
  assert.ok(db.verifyUser('uli', 'neu'));
  db.close();
});

test('users: Hash ist nicht das Klartext-Passwort', () => {
  const db = freshDB();
  db.createUser('uli', 'geheim');
  const row = db.db.prepare('SELECT pw_hash FROM users WHERE username=?').get('uli');
  assert.ok(!row.pw_hash.includes('geheim'));
  assert.ok(row.pw_hash.length >= 64);
  db.close();
});

// --- SETTINGS ----------------------------------------------------------------

test('settings: Defaults werden geseedet', () => {
  const db = freshDB(cfgDefaults);
  assert.equal(db.getSetting('price_per_kwh'), 0.45);
  assert.equal(db.getSetting('currency'), 'eur');
  assert.equal(db.getSetting('pay_required_p30c'), true);
  assert.equal(db.getSetting('pay_required_p30x'), true);
  db.close();
});

test('settings: setzen/lesen, Typen bleiben erhalten', () => {
  const db = freshDB();
  db.setSetting('price_per_kwh', 0.50);
  db.setSetting('pay_required_p30x', false);
  assert.equal(db.getSetting('price_per_kwh'), 0.50);
  assert.equal(db.getSetting('pay_required_p30x'), false);   // bool bleibt bool
  db.close();
});

test('settings: Defaults überschreiben nicht vorhandene Werte', () => {
  const db = freshDB(cfgDefaults);
  db.setSetting('price_per_kwh', 0.99);
  // erneutes Seeden (simuliert Neustart) darf 0.99 nicht überschreiben
  db._seedSettings(cfgDefaults);
  assert.equal(db.getSetting('price_per_kwh'), 0.99);
  db.close();
});

// --- SESSIONS ----------------------------------------------------------------

test('sessions: anlegen, lesen, String-ID bleibt String', () => {
  const db = freshDB();
  const s = db.createSession({
    id: 's_abc123', wallbox_id: 'p30c', wallbox_name: 'P30C Gaeste',
    guest_name: 'Familie Huber', mode: 'limit', limit_amount: 5,
    started_at: new Date().toISOString(),
  });
  assert.equal(s.id, 's_abc123');
  assert.equal(s.wallbox_id, 'p30c');
  assert.equal(s.status, 'active');
  assert.equal(s.paid, 0);
  const back = db.getSession('s_abc123');
  assert.equal(back.guest_name, 'Familie Huber');
  db.close();
});

test('sessions: aktive Session pro Box finden', () => {
  const db = freshDB();
  db.createSession({ id: 's_1', wallbox_id: 'p30c', status: 'active', started_at: '2026-01-01T10:00:00Z' });
  db.createSession({ id: 's_2', wallbox_id: 'p30c', status: 'completed', started_at: '2026-01-01T09:00:00Z' });
  const active = db.getActiveSession('p30c');
  assert.equal(active.id, 's_1');
  db.close();
});

test('sessions: aktualisieren (kWh, Betrag, Abschluss)', () => {
  const db = freshDB();
  db.createSession({ id: 's_x', wallbox_id: 'p30c', status: 'active', started_at: new Date().toISOString() });
  db.updateSession('s_x', { energy_kwh: 4.48, amount: 2.0, captured: 2.0, status: 'completed', paid: true, ended_at: new Date().toISOString() });
  const s = db.getSession('s_x');
  assert.equal(s.energy_kwh, 4.48);
  assert.equal(s.captured, 2.0);
  assert.equal(s.status, 'completed');
  assert.equal(s.paid, 1);
  db.close();
});

test('sessions: free_charge-Flag (Bezahl-Schalter aus)', () => {
  const db = freshDB();
  db.createSession({ id: 's_free', wallbox_id: 'p30x', status: 'active', free_charge: true, started_at: new Date().toISOString() });
  assert.equal(db.getSession('s_free').free_charge, 1);
  db.close();
});

test('sessions: Liste neueste zuerst', () => {
  const db = freshDB();
  db.createSession({ id: 's_a', wallbox_id: 'p30c', started_at: '2026-01-01T08:00:00Z' });
  db.createSession({ id: 's_b', wallbox_id: 'p30c', started_at: '2026-01-01T10:00:00Z' });
  const list = db.listSessions();
  assert.equal(list[0].id, 's_b');   // neueste zuerst
  db.close();
});

// --- INVOICES ----------------------------------------------------------------

test('invoices: Belegnummer fortlaufend pro Jahr', () => {
  const db = freshDB();
  db.createSession({ id: 's_1', wallbox_id: 'p30c', started_at: new Date().toISOString() });
  db.createSession({ id: 's_2', wallbox_id: 'p30c', started_at: new Date().toISOString() });
  const i1 = db.createInvoice({ session_id: 's_1', energy_kwh: 4.48, price_per_kwh: 0.45, amount: 2.0, captured: 2.0 });
  const i2 = db.createInvoice({ session_id: 's_2', energy_kwh: 2.0, price_per_kwh: 0.45, amount: 0.9, captured: 0.9 });
  const year = new Date().getFullYear();
  assert.equal(i1.invoice_no, `${year}-00001`);
  assert.equal(i2.invoice_no, `${year}-00002`);
  db.close();
});

test('invoices: Rechnung zur Session finden, PDF-Pfad nachtragen', () => {
  const db = freshDB();
  db.createSession({ id: 's_1', wallbox_id: 'p30c', started_at: new Date().toISOString() });
  const inv = db.createInvoice({ session_id: 's_1', energy_kwh: 4.48, price_per_kwh: 0.45, amount: 2.0, captured: 2.0 });
  assert.equal(db.getInvoiceBySession('s_1').id, inv.id);
  assert.equal(inv.pdf_path, null);
  assert.ok(db.setInvoicePdf(inv.id, '/belege/2026-00001.pdf'));
  assert.equal(db.getInvoice(inv.id).pdf_path, '/belege/2026-00001.pdf');
  db.close();
});

// --- LOGS & ERRORS -----------------------------------------------------------

test('logs: schreiben und lesen', () => {
  const db = freshDB();
  db.log('chargingStarted', { wallboxId: 'p30c', sessionId: 's_1' });
  db.log('chargingStopped', { wallboxId: 'p30c', sessionId: 's_1', details: { kwh: 4.48 } });
  const logs = db.listLogs();
  assert.equal(logs.length, 2);
  assert.equal(logs[0].event, 'chargingStopped');   // neueste zuerst
  assert.ok(logs[0].details.includes('4.48'));        // JSON serialisiert
  db.close();
});

test('errors: schreiben und lesen', () => {
  const db = freshDB();
  db.logError('OUT_OF_SYNC', { wallboxId: 'p30c', details: 'Soll laden, Ist ready' });
  const errs = db.listErrors();
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, 'OUT_OF_SYNC');
  db.close();
});

test('pruneOld: löscht Einträge älter als 90 Tage', () => {
  const db = freshDB();
  // alten Log direkt einfügen (101 Tage alt)
  const alt = new Date(Date.now() - 101 * 86400000).toISOString();
  db.db.prepare(`INSERT INTO logs (ts, level, event) VALUES (?,?,?)`).run(alt, 'info', 'altes_event');
  db.log('neues_event');   // jetzt
  const res = db.pruneOld(90);
  assert.equal(res.logs, 1);                  // genau der alte gelöscht
  assert.equal(db.listLogs().length, 1);      // der neue bleibt
  assert.equal(db.listLogs()[0].event, 'neues_event');
  db.close();
});
