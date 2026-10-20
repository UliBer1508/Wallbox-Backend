'use strict';
/**
 * Selbsttest ohne Wallbox, ohne Backend und ohne Sinric Pro:
 * startet ein simuliertes Wallbox-Backend auf Port 5080, das sich wie das
 * echte verhält (Start -> "Warten auf Auto" + 400 "Nicht im Ladezustand."),
 * und prüft Login, Status, Start/Stopp, Ladestrom, Token-Erneuerung und
 * den Schreibschutz der Gäste-Wallbox.
 */
const assert = require('assert');
const http = require('http');
const SinricPro = require('sinricpro').default;
const { BackendClient, BackendWallbox, BackendReadOnlyWallbox } = require('./backend-wallbox');
const { startAlexaBridge, percentToAmps } = require('./alexa-bridge');

// ---------------- Simuliertes Backend ----------------
const calls = [];
let validToken = 'tok-1';
let currentEndpoint = true;
const boxes = {
  p30x: { id: 'p30x', online: true, power: 0, carConnected: true, pay_required: false, session: null, fsmState: 'IDLE' },
  p30c: { id: 'p30c', online: true, power: 7400, carConnected: true, pay_required: true, session: { id: 'g1' }, fsmState: 'CHARGING' },
};
const carStartsCharging = (id) => { boxes[id].fsmState = 'CHARGING'; boxes[id].power = 11000; };

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', Connection: 'close' }); res.end(JSON.stringify(obj)); };
    const authed = req.headers['x-auth-token'] === validToken;

    if (req.method === 'POST' && req.url === '/api/login') {
      if (body.password !== 'geheim') return send(401, { ok: false, error: 'Login fehlgeschlagen.' });
      calls.push(['login']);
      return send(200, { ok: true, token: validToken });
    }
    if (req.method === 'GET' && req.url === '/api/state') {
      return send(200, { wallboxen: Object.values(boxes) });
    }
    const m = req.url.match(/^\/api\/wallbox\/(\w+)\/(start|stop|current)$/);
    if (req.method === 'POST' && m) {
      if (m[2] === 'current' && !currentEndpoint) return send(404, {});
      if (!authed) return send(401, { ok: false, error: 'Nicht angemeldet.' });
      const [, id, action] = m;
      const b = boxes[id];
      calls.push([action, id, body.current]);
      if (action === 'start') {
        // wie das echte Backend: Session + Warten auf Auto, dann scheitert setCurrent
        b.session = { id: 's' + calls.length };
        b.fsmState = 'WAITING_FOR_CAR';
        return send(400, { ok: false, error: 'Nicht im Ladezustand.' });
      }
      if (action === 'stop') { b.session = null; b.power = 0; b.fsmState = 'IDLE'; return send(200, { ok: true }); }
      if (action === 'current') {
        if (b.fsmState !== 'CHARGING') return send(400, { ok: false, error: 'Nicht im Ladezustand.' });
        return send(200, { ok: true });
      }
    }
    send(404, {});
  });
});

(async () => {
  await new Promise((r) => server.listen(5080, '127.0.0.1', r));
  const client = new BackendClient({ baseUrl: 'http://127.0.0.1:5080', username: 'admin', password: 'geheim' });
  const p30x = new BackendWallbox(client, 'p30x', { defaultAmps: 16 });
  const p30c = new BackendReadOnlyWallbox(client, 'p30c');

  // Umrechnung mit Backend-Grenze 16 A
  assert.strictEqual(percentToAmps(100, 16), 16);
  assert.strictEqual(percentToAmps(50, 16), 8);
  assert.strictEqual(percentToAmps(10, 16), 6);
  console.log('Umrechnung Prozent -> Ampere: OK');

  // Status
  assert.strictEqual((await p30x.getStatus()).charging, false);
  const sc = await p30c.getStatus();
  assert.strictEqual(sc.charging, true);
  assert.strictEqual(sc.powerW, 7400);
  console.log('Status lesen: OK');

  // Strom ohne Session -> nur merken
  await p30x.setCurrent(10);
  assert.strictEqual(calls.length, 0);

  // Ein -> Backend antwortet 400, Session existiert aber -> Erfolg, Strom vorgemerkt
  await p30x.setEnabled(true);
  assert.deepStrictEqual(calls, [['login'], ['start', 'p30x', 10]]);
  assert.strictEqual(p30x.pendingAmps, 10);
  console.log('Start mit "Warten auf Auto" wird als Erfolg erkannt: OK');

  // Strom während "Warten auf Auto" -> nur vormerken, kein Backend-Aufruf
  await p30x.setCurrent(12);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(p30x.pendingAmps, 12);

  // Auto lädt noch nicht -> nichts passiert
  await p30x._applyPending();
  assert.strictEqual(calls.length, 2);

  // Auto lädt -> vorgemerkter Strom wird gesetzt
  carStartsCharging('p30x');
  await p30x._applyPending();
  assert.deepStrictEqual(calls.at(-1), ['current', 'p30x', 12]);
  assert.strictEqual(p30x.pendingAmps, null);
  console.log('Strom wird nach Ladebeginn nachgezogen: OK');

  // Strom während des Ladens, Token zwischendurch abgelaufen
  validToken = 'tok-2';
  await p30x.setCurrent(14);
  assert.deepStrictEqual(calls.slice(-2), [['login'], ['current', 'p30x', 14]]);
  console.log('Ladestrom während des Ladens + Neu-Anmeldung: OK');

  // Backend ohne /current -> Fallback Stopp + Neustart
  currentEndpoint = false;
  await p30x.setCurrent(16);
  assert.deepStrictEqual(calls.slice(-2), [['stop', 'p30x', undefined], ['start', 'p30x', 16]]);
  console.log('Fallback Stopp + Neustart: OK');

  // Aus
  await p30x.setEnabled(false);
  assert.deepStrictEqual(calls.at(-1), ['stop', 'p30x', undefined]);
  // Aus ohne Session -> kein Aufruf
  const n = calls.length;
  await p30x.setEnabled(false);
  assert.strictEqual(calls.length, n);
  p30x.stop();
  console.log('Stopp über Backend: OK');

  // Box hängt in WAITING_FOR_CAR ohne aktive Session (Fall vom 20.10.2026):
  // "ein" darf keinen zweiten Start auslösen
  boxes.p30x.fsmState = 'WAITING_FOR_CAR';
  boxes.p30x.session = null;
  const m0 = calls.length;
  await p30x.setEnabled(true);
  assert.strictEqual(calls.length, m0);
  // "aus" in diesem Zustand: kein Fehler, kein Stopp-Aufruf
  await p30x.setEnabled(false);
  assert.strictEqual(calls.length, m0);
  boxes.p30x.fsmState = 'IDLE';
  console.log('Hängender Wartezustand ohne Session: kein Doppelstart: OK');

  // Gäste-Wallbox hat keine Schreibmethoden
  assert.strictEqual(typeof p30c.setEnabled, 'undefined');
  assert.strictEqual(typeof p30c.setCurrent, 'undefined');

  // Alexa-Logik mit simuliertem Sinric Pro
  currentEndpoint = true;
  const added = [];
  SinricPro.add = (d) => added.push(d);
  SinricPro.begin = async () => {};
  SinricPro.onConnected = () => {};
  SinricPro.onDisconnected = () => {};
  const bridge = await startAlexaBridge(
    { appKey: 'k', appSecret: 's', privateDeviceId: 'a'.repeat(24), guestDeviceId: 'b'.repeat(24), maxAmps: 16 },
    { p30x, p30c },
    () => {},
  );
  const [autoLaden, gaeste] = added;
  const before = calls.length;
  assert.strictEqual(await autoLaden.powerStateCallback('x', true), true);
  assert.deepStrictEqual(calls.at(-1), ['start', 'p30x', 16]);
  assert.strictEqual(await autoLaden.powerLevelCallback('x', 50), true); // wartet auf Auto -> vorgemerkt
  assert.strictEqual(p30x.pendingAmps, 8);
  assert.strictEqual(await gaeste.powerStateCallback('y', true), false);
  assert.ok(calls.slice(before).every((c) => c[1] !== 'p30c'), 'Gäste-Wallbox darf nie geschaltet werden');
  p30x.stop();
  bridge.stop();
  console.log('Alexa-Befehle und Gäste-Sperre: OK');

  console.log('\nSelbsttest erfolgreich.');
  server.close(() => setTimeout(() => process.exit(0), 100));
})().catch((err) => {
  console.error('Selbsttest FEHLGESCHLAGEN:', err);
  process.exit(1);
});
