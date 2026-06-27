// ============================================================================
// services.js — System-Dienste-Übersicht (NSSM, Auto-Discovery)
// ============================================================================
// Findet AUTOMATISCH alle NSSM-Dienste auf DIESEM PC (egal aus welchem
// Projekt) über die Windows-Registry und fragt ihren Live-Status ab.
// Bei bekannten Diensten wird ein Anzeigename + Link aus services.json
// dazugemischt — fehlt der Eintrag, erscheint der rohe Dienstname.
// Optional Start/Stop über `nssm start|stop <name>`.
//
// Pro PC lokal: Das Modul zeigt nur die Dienste der Maschine, auf der es
// läuft. Auf dem Wallbox-PC die österreichischen, auf dem München-PC die
// dortigen. Keine Standort-Zusammenführung.
//
// WICHTIG — Sicherheit:
//   - Dieses Modul hat NICHTS mit Modbus/Laden/Stripe zu tun. Es läuft NICHT
//     durch die Fassade (facade.js). Eigenständiger System-Layer.
//   - Start/Stop ist NUR für Dienste erlaubt, die die Auto-Discovery
//     tatsächlich als NSSM-Dienst gefunden hat. Ein vom Browser übergebener
//     Name wird gegen genau diese gefundene Liste geprüft, BEVOR er an die
//     Shell geht. Damit keine Command-Injection, kein Steuern fremder Dienste.
//   - services.json kann einen Dienst per "manageable": false auf nur-lesen
//     stellen (z.B. Tailscale, damit der Fernzugriff nicht abschaltbar ist).
//   - Endpunkte in server.js MÜSSEN hinter dem Admin-Login liegen.
//
// Plattform: Windows. Auf Nicht-Windows leere Liste (lokale Tests crashen nicht).
// ============================================================================

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// services.json liegt im Projekt-Wurzelverzeichnis (eine Ebene über src/).
// Sie ist jetzt OPTIONAL: nur für Anzeigename + Link bei bekannten Diensten.
const CONFIG_PATH = path.join(__dirname, '..', 'services.json');

const IS_WINDOWS = process.platform === 'win32';

const SERVICES_REG_BASE = 'HKLM\\SYSTEM\\CurrentControlSet\\Services';

// Gültiger Windows-Dienstname: Buchstaben, Ziffern, _ . - (keine Shell-Metas).
// Schutzgürtel: alles andere wird nie an nssm/sc weitergereicht.
const VALID_SERVICE_NAME = /^[A-Za-z0-9_.-]+$/;

// --- Optionale Konfiguration (Anzeigename + Link) ----------------------------

/**
 * Liest services.json frisch bei jedem Aufruf. Liefert eine Map
 * name -> {label?, url?, manageable?}. Fehlt die Datei, leere Map.
 */
async function loadOverrides() {
  const map = new Map();
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.services)) {
      for (const s of data.services) {
        if (s && typeof s.name === 'string' && s.name.trim() !== '') {
          map.set(s.name, {
            label: typeof s.label === 'string' ? s.label : null,
            url: typeof s.url === 'string' ? s.url : null,
            manageable: s.manageable !== false,
          });
        }
      }
    }
  } catch {
    // Datei fehlt oder kaputt -> keine Overrides, nur rohe Namen.
  }
  return map;
}

// --- nssm / sc / reg aufrufen ------------------------------------------------

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve(String(stdout || ''));
    });
  });
}

// --- Auto-Discovery: alle NSSM-Dienste finden --------------------------------

/**
 * Findet alle NSSM-Dienste auf diesem PC.
 *
 * Methode: `reg query HKLM\...\Services /s /f Application` durchsucht die
 * Registry. Ein echter NSSM-Dienst hat den Unterschlüssel
 *   ...\Services\<Name>\Parameters
 * mit einem Wert "Application" (Pfad zur node.exe o.ä.). Genau diese Dienste
 * sammeln wir; alle anderen Windows-Dienste werden ignoriert.
 *
 * @returns {Promise<Set<string>>} Menge der gefundenen NSSM-Dienstnamen
 */
async function discoverNssmServices() {
  const found = new Set();
  if (!IS_WINDOWS) return found;

  let out;
  try {
    // /s = rekursiv, /f Application = nach diesem Wertnamen suchen, /k? nein:
    // wir suchen den Wert "Application", der nur unter \Parameters von
    // NSSM-Diensten existiert.
    out = await run('reg', ['query', SERVICES_REG_BASE, '/s', '/f', 'Application', '/v', 'Application']);
  } catch {
    return found; // reg nicht verfügbar -> leere Menge
  }

  // Ausgabe besteht aus Blöcken wie:
  //   HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\WallboxBackend\Parameters
  //       Application    REG_EXPAND_SZ    C:\Program Files\nodejs\node.exe
  // Wir ziehen aus jeder \Services\<NAME>\Parameters-Zeile den <NAME>.
  const lines = out.split(/\r?\n/);
  const keyRe = /\\Services\\([A-Za-z0-9_.-]+)\\Parameters$/i;
  for (const line of lines) {
    const m = line.trim().match(keyRe);
    if (m && VALID_SERVICE_NAME.test(m[1])) {
      found.add(m[1]);
    }
  }
  return found;
}

/**
 * Status eines Dienstes: 'running' | 'stopped' | 'unknown'
 */
async function queryStatus(name) {
  if (!IS_WINDOWS) return 'unknown';
  if (!VALID_SERVICE_NAME.test(name)) return 'unknown';

  try {
    const out = await run('nssm', ['status', name]);
    const t = out.toUpperCase();
    if (t.includes('RUNNING')) return 'running';
    if (t.includes('STOPPED') || t.includes('PAUSED')) return 'stopped';
    return 'unknown';
  } catch {
    // Fallback sc query
  }
  try {
    const out = await run('sc', ['query', name]);
    const t = out.toUpperCase();
    if (t.includes('RUNNING')) return 'running';
    if (t.includes('STOPPED')) return 'stopped';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// --- Öffentliche API ---------------------------------------------------------

/**
 * Alle automatisch gefundenen NSSM-Dienste mit Status, gemischt mit
 * Anzeigename/Link aus services.json (falls vorhanden). Alphabetisch sortiert.
 */
export async function listServices() {
  const [names, overrides] = await Promise.all([
    discoverNssmServices(),
    loadOverrides(),
  ]);

  const sorted = [...names].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );

  return Promise.all(
    sorted.map(async (name) => {
      const o = overrides.get(name) || {};
      return {
        name,
        label: o.label || name,        // ohne Override: roher Name
        url: o.url || null,
        manageable: o.manageable !== false, // Default steuerbar
        status: await queryStatus(name),
      };
    })
  );
}

/**
 * Prüft, ob ein Name ein real existierender NSSM-Dienst ist UND steuerbar.
 * Whitelist = die Auto-Discovery-Liste selbst (nicht services.json).
 * @returns {Promise<string|null>} den validierten Namen oder null
 */
async function resolveManageable(name) {
  if (typeof name !== 'string' || !VALID_SERVICE_NAME.test(name)) return null;
  const [names, overrides] = await Promise.all([
    discoverNssmServices(),
    loadOverrides(),
  ]);
  if (!names.has(name)) return null;                  // existiert nicht als NSSM-Dienst
  const o = overrides.get(name);
  if (o && o.manageable === false) return null;       // bewusst nur-lesen
  return name;
}

export async function startService(name) {
  const ok = await resolveManageable(name);
  if (!ok) {
    const e = new Error(`Dienst nicht erlaubt oder unbekannt: ${name}`);
    e.code = 'SERVICE_FORBIDDEN';
    throw e;
  }
  if (!IS_WINDOWS) {
    const e = new Error('Dienststeuerung nur unter Windows verfügbar.');
    e.code = 'NOT_WINDOWS';
    throw e;
  }
  await run('nssm', ['start', ok]);
  return { name: ok, status: await queryStatus(ok) };
}

export async function stopService(name) {
  const ok = await resolveManageable(name);
  if (!ok) {
    const e = new Error(`Dienst nicht erlaubt oder unbekannt: ${name}`);
    e.code = 'SERVICE_FORBIDDEN';
    throw e;
  }
  if (!IS_WINDOWS) {
    const e = new Error('Dienststeuerung nur unter Windows verfügbar.');
    e.code = 'NOT_WINDOWS';
    throw e;
  }
  await run('nssm', ['stop', ok]);
  return { name: ok, status: await queryStatus(ok) };
}
