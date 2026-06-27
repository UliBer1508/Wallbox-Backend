import Database from "better-sqlite3";
const db = new Database("sessions.db", { readonly: true });
const r = db.prepare("SELECT ts,event,details FROM logs WHERE event LIKE 'mail%' ORDER BY rowid DESC LIMIT 5").all();
console.log(JSON.stringify(r, null, 2));
db.close();
