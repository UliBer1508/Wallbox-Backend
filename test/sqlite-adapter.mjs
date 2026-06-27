// test/sqlite-adapter.mjs
//
// Test-Hilfe: bildet die better-sqlite3-Schnittstelle auf das in Node 22+
// eingebaute node:sqlite ab. NUR FÜR TESTS in dieser Sandbox-Umgebung
// (hier lässt sich better-sqlite3 nicht kompilieren — nodejs.org ist blockiert).
//
// Auf dem echten PC läuft db.js unverändert gegen das ECHTE better-sqlite3.
// Dieser Adapter wird dort NICHT gebraucht.

import { DatabaseSync } from 'node:sqlite';

// Eine Klasse, die sich wie `new Database(file)` aus better-sqlite3 verhält.
export default class BetterSqlite3Compat {
  constructor(file = ':memory:') {
    this._db = new DatabaseSync(file);
  }
  pragma(_str) { /* WAL/foreign_keys: in node:sqlite teils default/irrelevant für Tests */ }
  exec(sql) { return this._db.exec(sql); }
  prepare(sql) { return this._db.prepare(sql); }
  close() { return this._db.close(); }
}
