// test/stripe.test.js
// Tests für den Abrechnungslayer (stripe.js).
// node --experimental-sqlite --test test/stripe.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WallboxDB } from '../src/db.js';
import { StripeBilling, PAYMENT_RESULT } from '../src/stripe.js';
import SqliteAdapter from './sqlite-adapter.mjs';
import { makeFakeStripe } from './fake-stripe.mjs';

const cfgDefaults = {
  payment: { pricePerKwh: 0.45, reserveAmountEur: 35, currency: 'eur', minCaptureEur: 0.5 },
};

function setup() {
  const db = new WallboxDB({ file: ':memory:', Database: SqliteAdapter, defaults: cfgDefaults });
  const stripe = makeFakeStripe();
  const facade = new EventEmitter();   // Fassade als Event-Quelle simulieren
  const billing = new StripeBilling({
    facade, db, stripe,
    config: { pricePerKwh: 0.45, reserveAmountEur: 35, currency: 'eur', minCaptureEur: 0.5 },
    publicBaseUrl: 'https://test.local',
  });
  return { db, stripe, facade, billing };
}

function mkSession(db, over = {}) {
  return db.createSession({
    id: over.id || 's_test', wallbox_id: 'p30c', wallbox_name: 'P30C Gaeste',
    guest_name: 'Test Gast', guest_email: 't@e.at',
    mode: over.mode || 'limit', limit_amount: over.limit_amount ?? 5,
    limit_kwh: over.limit_kwh ?? (over.limit_amount ?? 5) / 0.45,
    status: 'active', free_charge: over.free_charge ? 1 : 0,
    started_at: new Date().toISOString(), ...over,
  });
}

// --- Vorautorisierung --------------------------------------------------------

test('authorize: reserviert Limit-Betrag bei modus=limit', async () => {
  const { db, billing, stripe } = setup();
  const s = mkSession(db, { mode: 'limit', limit_amount: 5 });
  const res = await billing.authorize(s);
  assert.ok(res.checkoutUrl.includes('fake.stripe'));
  assert.equal(res.reservedEur, 5);
  assert.equal(stripe.calls[0][1].amount, 500);   // 5 € = 500 Cent
});

test('authorize: reserviert Reservierungsbetrag bei modus=voll', async () => {
  const { db, billing, stripe } = setup();
  const s = mkSession(db, { mode: 'voll', limit_amount: null, limit_kwh: null });
  const res = await billing.authorize(s);
  assert.equal(res.reservedEur, 35);
  assert.equal(stripe.calls[0][1].amount, 3500);
});

// --- Freigabe-Prüfung --------------------------------------------------------

test('confirmAuthorized: erkennt requires_capture', async () => {
  const { db, billing } = setup();
  const s = mkSession(db);
  await billing.authorize(s);
  const conf = await billing.confirmAuthorized(db.getSession(s.id));
  assert.equal(conf.ok, true);
  assert.ok(conf.paymentIntentId.startsWith('pi_fake'));
});

// --- Abrechnung: Normalfall --------------------------------------------------

test('settle: bucht echten Betrag ab, schreibt Rechnung', async () => {
  const { db, billing, stripe } = setup();
  const s = mkSession(db, { mode: 'voll', limit_amount: null, limit_kwh: null });
  await billing.authorize(s);
  await billing.confirmAuthorized(db.getSession(s.id));

  const res = await billing.settle(s.id, 4.48);   // 4,48 kWh geladen
  assert.equal(res.result, PAYMENT_RESULT.CAPTURED);
  assert.equal(res.captured, 2.02);               // 4,48 × 0,45 = 2,016 → 2,02
  assert.ok(res.invoice);
  assert.match(res.invoice.invoice_no, /^\d{4}-00001$/);

  // Stripe wurde mit dem echten Betrag captured (202 Cent)
  const cap = stripe.calls.find(c => c[0] === 'capture');
  assert.equal(cap[1].amount_to_capture, 202);

  // Session ist abgeschlossen + bezahlt
  const back = db.getSession(s.id);
  assert.equal(back.status, 'completed');
  assert.equal(back.paid, 1);
});

// --- Abrechnung: Capture-Deckel (die Bug-2-Erkenntnis!) ----------------------

test('settle: Capture-Deckel — bei limit nie über das kWh-Limit hinaus', async () => {
  const { db, billing, stripe } = setup();
  // Limit 2 € = 4,444 kWh. Gemessen wurden fälschlich 6 kWh.
  const s = mkSession(db, { mode: 'limit', limit_amount: 2, limit_kwh: 2 / 0.45 });
  await billing.authorize(s);
  await billing.confirmAuthorized(db.getSession(s.id));

  const res = await billing.settle(s.id, 6.0);   // 6 kWh gemessen (zu viel!)
  // Gedeckelt auf 2/0.45 = 4.444 kWh → 4.444 × 0.45 = 2,00 €, NICHT 2,70 €
  assert.equal(res.captured, 2.0);
  const cap = stripe.calls.find(c => c[0] === 'capture');
  assert.equal(cap[1].amount_to_capture, 200);   // genau 2 €, gedeckelt
});

// --- Abrechnung: unter Mindestbetrag -----------------------------------------

test('settle: unter Mindestbetrag → storniert, nichts abgebucht', async () => {
  const { db, billing, stripe } = setup();
  const s = mkSession(db, { mode: 'voll', limit_amount: null, limit_kwh: null });
  await billing.authorize(s);
  await billing.confirmAuthorized(db.getSession(s.id));

  const res = await billing.settle(s.id, 0.5);   // 0,5 × 0,45 = 0,225 € < 0,50
  assert.equal(res.result, PAYMENT_RESULT.CANCELLED);
  assert.equal(res.captured, 0);
  assert.ok(stripe.calls.some(c => c[0] === 'cancel'));   // Auth wurde gecancelt
  assert.equal(db.getSession(s.id).status, 'cancelled');
  assert.equal(db.getInvoiceBySession(s.id), null);       // keine Rechnung
});

// --- Abrechnung: Bezahl-Schalter aus -----------------------------------------

test('settle: free_charge → keine Stripe-Aktion, FREE', async () => {
  const { db, billing, stripe } = setup();
  const s = mkSession(db, { mode: 'voll', limit_amount: null, limit_kwh: null, free_charge: true });
  // free_charge braucht keine Authorize

  const res = await billing.settle(s.id, 10.0);
  assert.equal(res.result, PAYMENT_RESULT.FREE);
  assert.equal(res.captured, 0);
  assert.equal(stripe.calls.length, 0);          // Stripe NICHT angefasst
  const back = db.getSession(s.id);
  assert.equal(back.status, 'completed');
  assert.equal(back.energy_kwh, 10.0);           // Energie trotzdem protokolliert
  assert.ok(back.note.includes('Gratis'));
});

// --- Idempotenz --------------------------------------------------------------

test('settle: doppelter Aufruf bucht nicht doppelt ab', async () => {
  const { db, billing, stripe } = setup();
  const s = mkSession(db, { mode: 'voll', limit_amount: null, limit_kwh: null });
  await billing.authorize(s);
  await billing.confirmAuthorized(db.getSession(s.id));

  await billing.settle(s.id, 4.48);
  const captureCount1 = stripe.calls.filter(c => c[0] === 'capture').length;
  await billing.settle(s.id, 4.48);   // nochmal (z.B. Event doppelt)
  const captureCount2 = stripe.calls.filter(c => c[0] === 'capture').length;
  assert.equal(captureCount1, captureCount2);   // kein zweiter Capture
});

// --- Event-Verdrahtung -------------------------------------------------------

test('chargingStopped-Event löst settle automatisch aus', async () => {
  const { db, billing, facade, stripe } = setup();
  const s = mkSession(db, { mode: 'voll', limit_amount: null, limit_kwh: null });
  await billing.authorize(s);
  await billing.confirmAuthorized(db.getSession(s.id));

  // Fassade feuert chargingStopped → settle wird automatisch gerufen
  facade.emit('chargingStopped', { wallboxId: 'p30c', sessionId: s.id, finalKWh: 4.48 });
  await new Promise(r => setTimeout(r, 50));   // async-Handler abwarten

  assert.equal(db.getSession(s.id).status, 'completed');
  assert.ok(stripe.calls.some(c => c[0] === 'capture'));
});

test('errorOccurred-Event landet in der Fehlertabelle', async () => {
  const { db, facade } = setup();
  facade.emit('errorOccurred', { wallboxId: 'p30c', code: 'OUT_OF_SYNC', details: 'test' });
  await new Promise(r => setTimeout(r, 20));
  const errs = db.listErrors();
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, 'OUT_OF_SYNC');
});

// --- Abbruch -----------------------------------------------------------------

test('cancelAuthorization: gibt Reservierung frei', async () => {
  const { db, billing, stripe } = setup();
  const s = mkSession(db);
  await billing.authorize(s);
  const res = await billing.cancelAuthorization(s.id);
  assert.equal(res.ok, true);
  assert.ok(stripe.calls.some(c => c[0] === 'cancel'));
  assert.equal(db.getSession(s.id).status, 'cancelled');
});
