// src/upload.js
//
// Upload-Modul fuer das Wallbox-Backend  (FormData/multer-Version)
// ----------------------------------------------------------------
// Passt zum Frontend in public/index.html:
//   POST /api/login   Body {password}                -> {ok, token}
//   POST /api/upload  Header X-Auth-Token            -> {ok, file, target}
//                     FormData-Feld "file" (multipart)
//
// Einbindung in src/server.js (siehe EINBINDUNG-UPLOAD.md):
//   import { registerUploadRoutes } from './upload.js';
//   registerUploadRoutes(app);
//
// Benoetigt:  npm install multer
// ES-Modul (package.json: "type": "module")

import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Projektwurzel = ein Verzeichnis ueber src/
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

// --- Konfiguration ---------------------------------------------------------

// Passwort kommt aus der .env: UPLOAD_PASSWORD=...
// Wird erst zur Laufzeit gelesen, nicht beim Import (dotenv-Reihenfolge).
function getUploadPassword() {
  return process.env.UPLOAD_PASSWORD || '';
}

// Maximale Dateigroesse (Standard 10 MB), ueber .env anpassbar
function getMaxUploadBytes() {
  return Number(process.env.UPLOAD_MAX_BYTES || 10 * 1024 * 1024);
}

// Stufe 3: kritische Dateien, die NIE ueberschrieben werden duerfen
const BLOCKED_FILES = new Set([
  '.env',
  'config.yml',
  'config.yaml',
  'server.js',
  'upload.js',
  'package.json',
  'package-lock.json',
]);

// Stufe 1: Web-Dateien -> landen in public/
const WEB_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
  '.woff', '.woff2', '.ttf',
]);

// Stufe 2: Dokumentation -> landet in der Projektwurzel
const DOC_EXTENSIONS = new Set([
  '.md', '.txt',
]);

// --- Session-Verwaltung (einfach, im Speicher) -----------------------------

const sessions = new Map(); // token -> ablaufZeitpunkt (ms)
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 Stunde

function createSession() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// Zeitkonstanter Passwortvergleich gegen Timing-Angriffe
function passwordMatches(input) {
  const pw = getUploadPassword();
  if (!pw) return false;
  const a = Buffer.from(String(input ?? ''));
  const b = Buffer.from(pw);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// --- Whitelist-Entscheidung ------------------------------------------------

// Liefert { ok, dir, base } bei Erfolg, sonst { ok:false, reason }.
function classifyFile(rawName) {
  // Nur den reinen Dateinamen verwenden, keine Pfadanteile
  const base = path.basename(String(rawName || ''));

  // Leerer oder versteckter Sonderfall
  if (!base || base === '.' || base === '..') {
    return { ok: false, reason: 'Ungueltiger Dateiname.' };
  }

  // Path-Traversal-Schutz: keine Trenner, kein .. im Originalnamen
  if (String(rawName).includes('..') || String(rawName).includes('/') || String(rawName).includes('\\')) {
    return { ok: false, reason: 'Pfadangaben im Dateinamen sind nicht erlaubt.' };
  }

  // Stufe 3: kritische Dateien blockieren (case-insensitive)
  if (BLOCKED_FILES.has(base.toLowerCase())) {
    return { ok: false, reason: `Datei "${base}" ist gesperrt und kann nicht hochgeladen werden.` };
  }

  const ext = path.extname(base).toLowerCase();

  // Stufe 1: Web-Dateien -> public/
  if (WEB_EXTENSIONS.has(ext)) {
    return { ok: true, dir: PUBLIC_DIR, base };
  }

  // Stufe 2: Dokumentation -> Projektwurzel
  if (DOC_EXTENSIONS.has(ext)) {
    return { ok: true, dir: PROJECT_ROOT, base };
  }

  // Alles andere: abgelehnt
  return { ok: false, reason: `Dateityp "${ext || '(ohne)'}" ist nicht erlaubt.` };
}

// Stellt sicher, dass das Ziel wirklich innerhalb des erlaubten Ordners liegt
function isInsideAllowed(targetPath, allowedDir) {
  const resolved = path.resolve(targetPath);
  const allowed = path.resolve(allowedDir);
  return resolved === allowed || resolved.startsWith(allowed + path.sep);
}

// --- Routen registrieren ---------------------------------------------------

export function registerUploadRoutes(app, opts = {}) {
  // opts.validateToken: optionale externe Token-Prüfung (z.B. von server.js).
  //   Wird sie übergeben, nutzt die Upload-Route DIESE statt der eigenen
  //   Session-Verwaltung — so gilt EIN Login für Admin UND Upload.
  // opts.skipLogin: wenn true, registriert upload.js KEIN eigenes /api/login
  //   (server.js stellt dann das einheitliche Login bereit).
  const externalValidate = typeof opts.validateToken === 'function' ? opts.validateToken : null;
  const skipLogin = !!opts.skipLogin;

  // Sicherstellen, dass public/ existiert
  try {
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  } catch (e) {
    console.error('[upload] public/ konnte nicht angelegt werden:', e.message);
  }

  if (!externalValidate && !getUploadPassword()) {
    console.warn('[upload] WARNUNG: UPLOAD_PASSWORD ist nicht gesetzt - Upload bleibt gesperrt.');
  }

  // Token-Prüfung: extern (server.js) bevorzugt, sonst eigene Sessions
  const checkToken = (token) => externalValidate ? externalValidate(token) : isValidSession(token);

  // multer: Datei im Speicher entgegennehmen (wir schreiben selbst,
  // damit Whitelist + Backup VOR dem Schreiben greifen).
  const uploadMw = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: getMaxUploadBytes(), files: 1 },
  });

  // ---- POST /api/login ----------------------------------------------------
  // Nur registrieren, wenn server.js NICHT bereits ein einheitliches Login
  // bereitstellt (skipLogin). Verhindert doppelte, widersprüchliche Logins.
  if (!skipLogin) {
    app.post('/api/login', express.json(), (req, res) => {
      const { password } = req.body || {};
      if (!passwordMatches(password)) {
        return res.status(401).json({ ok: false, error: 'Falsches Passwort.' });
      }
      const token = createSession();
      res.json({ ok: true, token });
    });
  }

  // ---- POST /api/upload ---------------------------------------------------
  // Erwartet multipart/form-data mit Feld "file" (so sendet index.html).
  // Token via Header X-Auth-Token.
  app.post('/api/upload', (req, res) => {
    // 1) Auth pruefen — VOR dem Einlesen der Datei (kein Upload ohne Login)
    const token = req.get('X-Auth-Token');
    if (!checkToken(token)) {
      return res.status(401).json({ ok: false, error: 'Nicht angemeldet oder Sitzung abgelaufen.' });
    }

    // 2) Datei via multer einlesen (Groessenlimit greift hier)
    uploadMw.single('file')(req, res, (err) => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? `Datei zu gross (max. ${Math.round(getMaxUploadBytes() / 1024 / 1024)} MB).`
          : 'Upload fehlgeschlagen: ' + err.message;
        return res.status(400).json({ ok: false, error: msg });
      }

      const file = req.file;
      if (!file || !file.buffer || !file.buffer.length) {
        return res.status(400).json({ ok: false, error: 'Kein Dateiinhalt empfangen (Feld "file" fehlt oder leer).' });
      }

      // 3) Dateiname pruefen (Whitelist, Stufe 1-3)
      const decision = classifyFile(file.originalname);
      if (!decision.ok) {
        return res.status(400).json({ ok: false, error: decision.reason });
      }

      const targetPath = path.join(decision.dir, decision.base);

      // 4) Doppelter Sicherheitscheck: Ziel innerhalb des erlaubten Ordners
      if (!isInsideAllowed(targetPath, decision.dir)) {
        return res.status(400).json({ ok: false, error: 'Zielpfad ausserhalb des erlaubten Bereichs.' });
      }

      // 5) Backup der vorhandenen Datei anlegen
      try {
        if (fs.existsSync(targetPath)) {
          fs.copyFileSync(targetPath, targetPath + '.bak');
        }
      } catch (e) {
        return res.status(500).json({ ok: false, error: 'Backup fehlgeschlagen: ' + e.message });
      }

      // 6) Datei schreiben
      try {
        fs.writeFileSync(targetPath, file.buffer);
      } catch (e) {
        return res.status(500).json({ ok: false, error: 'Schreiben fehlgeschlagen: ' + e.message });
      }

      const zielOrdner = decision.dir === PUBLIC_DIR ? 'public/' : 'Projektwurzel';
      console.log(`[upload] ${decision.base} -> ${zielOrdner} (${file.buffer.length} Bytes)`);
      res.json({
        ok: true,
        file: decision.base,
        target: zielOrdner,
        bytes: file.buffer.length,
      });
    });
  });
}
