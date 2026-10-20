'use strict';
/**
 * Startdatei für den eigenständigen Betrieb (NSSM-Dienst "alexa-bridge").
 * Liest die Einstellungen aus .env im selben Ordner.
 * Gesteuert wird ausschließlich über das Wallbox-Backend (kein direktes Modbus).
 */
const fs = require('fs');
const path = require('path');
const { BackendClient, BackendWallbox, BackendReadOnlyWallbox } = require('./backend-wallbox');
const { startAlexaBridge } = require('./alexa-bridge');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

function log(msg) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

async function main() {
  loadEnv(path.join(__dirname, '.env'));
  const env = process.env;

  if (!env.BACKEND_PASSWORD) {
    throw new Error('BACKEND_PASSWORD fehlt in .env (Admin-Passwort des Wallbox-Backends)');
  }

  const client = new BackendClient({
    baseUrl: env.BACKEND_URL || 'http://127.0.0.1:8080',
    username: env.BACKEND_USER || 'admin',
    password: env.BACKEND_PASSWORD,
  });
  const maxAmps = Number(env.MAX_AMPS || 16);

  const p30x = new BackendWallbox(client, env.WALLBOX_PRIVAT || 'p30x', { defaultAmps: maxAmps, log });
  const p30c = new BackendReadOnlyWallbox(client, env.WALLBOX_GAESTE || 'p30c');

  if (process.argv.includes('--test')) {
    // Nur lesen + Login prüfen, nichts schalten
    for (const box of [p30x, p30c]) {
      try {
        log(`${box.id}: ${JSON.stringify(await box.getStatus())}`);
      } catch (err) {
        log(`FEHLER ${box.id}: ${err.message}`);
      }
    }
    try {
      await client._login();
      log('Backend-Login: OK');
    } catch (err) {
      log(`FEHLER ${err.message}`);
    }
    return;
  }

  const bridge = await startAlexaBridge(
    {
      appKey: env.SINRIC_APP_KEY,
      appSecret: env.SINRIC_APP_SECRET,
      privateDeviceId: env.SINRIC_DEVICE_P30X,
      guestDeviceId: env.SINRIC_DEVICE_P30C,
      pollSeconds: Number(env.POLL_SECONDS || 30),
      maxAmps,
    },
    { p30x, p30c },
    log,
  );

  const shutdown = () => {
    log('Alexa-Bridge wird beendet');
    bridge.stop();
    p30x.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log(`Start fehlgeschlagen: ${err.message}`);
  process.exit(1);
});
