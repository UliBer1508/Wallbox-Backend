// test/server.test.js
// Integrationstest: echter server.js mit gemockten Treibern + Fake-Stripe + node:sqlite.
// node --experimental-sqlite --test test/server.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { MockKebaCharger } from './mock-keba.js';
import SqliteAdapter from './sqlite-adapter.mjs';
import { makeFakeStripe } from './fake-stripe.mjs';

let server, baseUrl, db, fakeStripe, drivers;

before(async () => {
  process.env.ADMIN_PASSWORD = 'testpass';
  drivers = new Map();
  fakeStripe = makeFakeStripe();
  const built = await buildServer({
    driverFactory: (c) => { const d = new MockKebaCharger({ name: c.name, timeFactor: 60 }); drivers.set(c.id, d); return d; },
    stripeClient: fakeStripe,
    dbFile: ':memory:',
    dbDatabase: SqliteAdapter,
    publicBaseUrl: '',
  });
  db = built.db;
  await new Promise((resolve) => { server = built.app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); }); });
});

after(() => { server?.close(); });

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Auth-Token'] = token;
  const r = await fetch(baseUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// --- Login -------------------------------------------------------------------

test('Login: falsches Passwort wird abgewiesen', async () => {
  const r = await api('POST', '/api/login', { password: 'falsch' });
  assert.equal(r.status, 401);
});

test('Login: richtiges Passwort liefert Token', async () => {
  const r = await api('POST', '/api/login', { username: 'admin', password: 'testpass' });
  assert.equal(r.status, 200);
  assert.ok(r.json.token);
});

test('Admin-Route ohne Token → 401', async () => {
  const r = await api('GET', '/api/invoices');
  assert.equal(r.status, 401);
});

test('Admin-Route mit Token → ok', async () => {
  const login = await api('POST', '/api/login', { password: 'testpass' });
  const r = await api('GET', '/api/invoices', null, login.json.token);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.invoices));
});

// --- State -------------------------------------------------------------------

test('/api/state liefert beide Boxen mit pay_required', async () => {
  const r = await api('GET', '/api/state');
  assert.equal(r.status, 200);
  assert.equal(r.json.wallboxen.length, 2);
  const ids = r.json.wallboxen.map((w) => w.id).sort();
  assert.deepEqual(ids, ['p30c', 'p30x']);
  assert.equal(r.json.wallboxen[0].pay_required, true);   // Default
});

// --- Bezahl-Schalter ---------------------------------------------------------

test('Bezahl-Schalter: nur Admin darf schalten', async () => {
  const r = await api('POST', '/api/wallbox/p30x/payment', { required: false });
  assert.equal(r.status, 401);   // ohne Token
});

test('Bezahl-Schalter: Admin schaltet P30X auf gratis', async () => {
  const login = await api('POST', '/api/login', { password: 'testpass' });
  const r = await api('POST', '/api/wallbox/p30x/payment', { required: false }, login.json.token);
  assert.equal(r.status, 200);
  assert.equal(r.json.pay_required, false);
  // im State sichtbar
  const st = await api('GET', '/api/state');
  const p30x = st.json.wallboxen.find((w) => w.id === 'p30x');
  assert.equal(p30x.pay_required, false);
});

// --- Gäste-Flow mit Bezahlung (P30C) ----------------------------------------

test('Gäste-Flow P30C: request → checkoutUrl (Stripe)', async () => {
  drivers.get('p30c').plugVehicle();
  const r = await api('POST', '/api/guest/request?wb=p30c', {
    guestName: 'Familie Huber', guestEmail: 'h@b.at', mode: 'limit', limitAmount: 5,
  });
  assert.equal(r.status, 200);
  assert.ok(r.json.checkoutUrl);          // Stripe-Checkout, weil Bezahlung an
  assert.ok(r.json.sessionId.startsWith('s_'));
});

// --- Gäste-Flow gratis (P30X, Schalter aus) ---------------------------------

test('Gäste-Flow P30X gratis: request → kein Stripe, sofort laden', async () => {
  drivers.get('p30x').plugVehicle();
  // P30X steht auf gratis (vorheriger Test)
  const r = await api('POST', '/api/guest/request?wb=p30x', {
    guestName: 'Uli', mode: 'voll',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.free, true);        // gratis-Pfad
  assert.ok(!r.json.checkoutUrl);         // KEIN Stripe
});

// --- Auto-Rücksetzung nach Ladeende -----------------------------------------

test('Auto-Rücksetzung: nach Ladeende ist P30X wieder zahlungspflichtig', async () => {
  // P30X lädt gerade gratis (vorheriger Test). Jetzt stoppen.
  const st = await api('GET', '/api/state');
  const p30x = st.json.wallboxen.find((w) => w.id === 'p30x');
  const sid = p30x.session?.id;
  assert.ok(sid, 'sollte aktive gratis-Session haben');

  // pay_required ist aktuell false
  assert.equal((await api('GET', '/api/settings')).json.pay_required_p30x, false);

  // stoppen → chargingStopped-Event → Auto-Rücksetzung
  await api('POST', `/api/guest/stop/${sid}`);
  await new Promise((r) => setTimeout(r, 400));   // Event + Poll abwarten

  // Jetzt muss pay_required wieder true sein
  const after = await api('GET', '/api/settings');
  assert.equal(after.json.pay_required_p30x, true, 'Bezahl-Schalter sollte zurückgesetzt sein');
});

// --- Sessions/Verlauf --------------------------------------------------------

test('/api/sessions liefert Lade-Verlauf', async () => {
  const r = await api('GET', '/api/sessions');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.sessions));
  assert.ok(r.json.sessions.length >= 1);
});
