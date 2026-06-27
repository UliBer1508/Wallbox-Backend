// src/mailer.js
//
// SCHICHT 3c — E-MAIL-VERSAND (Quittungen)
// ========================================
// Verschickt Lade-Quittungen per Gmail-SMTP (nodemailer).
//
// Konfiguration kommt aus der .env:
//   MAIL_USER      = steinbockchalets@gmail.com
//   MAIL_PASS      = <16-stelliges Google App-Passwort> (NICHT das Konto-Passwort!)
//   MAIL_FROM_NAME = "Steinbock Chalets" (optional, Default unten)
//
// WICHTIG:
//   - Das Konto braucht 2-Faktor-Authentifizierung + ein App-Passwort.
//   - Schlägt der Versand fehl, wirft dieses Modul NICHT hart — der Aufrufer
//     (server.js) soll die Abrechnung dadurch nie blockieren lassen.
//   - Ist MAIL_USER/MAIL_PASS nicht gesetzt, ist der Mailer "disabled" und
//     tut nichts (loggt nur). So läuft das System auch ohne Mail-Konfig.
//
// ES-Modul.

import nodemailer from 'nodemailer';

export class Mailer {
  /**
   * @param {object} opts
   * @param {string} [opts.user]     Gmail-Adresse (MAIL_USER)
   * @param {string} [opts.pass]     App-Passwort (MAIL_PASS)
   * @param {string} [opts.fromName] Anzeigename des Absenders
   * @param {object} [opts.logger]   optionales Log-Objekt mit .log()/.logError()
   */
  constructor({ user, pass, fromName = 'Steinbock Chalets', logger = null } = {}) {
    this.user = user;
    this.pass = pass;
    this.fromName = fromName;
    this.logger = logger;
    this.enabled = !!(user && pass);

    if (this.enabled) {
      this.transport = nodemailer.createTransport({
        service: 'gmail',
        auth: { user, pass },
      });
    }
  }

  _log(event, details) {
    try { this.logger?.log?.(event, { details }); } catch { /* egal */ }
  }
  _logErr(event, details) {
    try { this.logger?.logError?.(event, { details }); } catch { /* egal */ }
  }

  /**
   * Prüft die SMTP-Verbindung (optional beim Start aufrufbar).
   * @returns {Promise<boolean>}
   */
  async verify() {
    if (!this.enabled) return false;
    try { await this.transport.verify(); this._log('mail_verify_ok', 'SMTP bereit'); return true; }
    catch (e) { this._logErr('mail_verify_failed', e.message); return false; }
  }

  /**
   * Verschickt eine Lade-Quittung. Wirft NIE — gibt {ok} zurück.
   * @param {object} inv  Rechnungsobjekt (aus db.createInvoice / getInvoiceBySession)
   * @returns {Promise<{ok:boolean, skipped?:boolean, error?:string}>}
   */
  async sendReceipt(inv) {
    if (!this.enabled) { this._log('mail_skipped', 'Mailer nicht konfiguriert'); return { ok: false, skipped: true }; }
    if (!inv || !inv.guest_email) { this._log('mail_skipped', 'keine Empfänger-Adresse'); return { ok: false, skipped: true }; }

    const cur = (inv.currency || 'eur').toUpperCase() === 'EUR' ? '€' : (inv.currency || '').toUpperCase();
    const fmt = (n) => Number(n ?? 0).toFixed(2).replace('.', ',');
    const fmt3 = (n) => Number(n ?? 0).toFixed(3).replace('.', ',');
    const datum = new Date(inv.created_at || Date.now()).toLocaleString('de-DE', { timeZone: 'Europe/Vienna' });
    const betrag = inv.captured != null ? inv.captured : inv.amount;

    const subject = `Ihre Ladequittung – ${inv.wallbox_name || inv.wallbox_id} (${fmt(betrag)} ${cur})`;

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1c2722;">
        <h2 style="color:#2f7d4f;margin-bottom:4px;">Steinbock Chalets</h2>
        <p style="color:#7a8580;margin-top:0;">Quittung für Ihren Ladevorgang</p>
        <table style="width:100%;border-collapse:collapse;margin-top:16px;">
          <tr><td style="padding:8px 0;color:#7a8580;">Rechnungsnummer</td><td style="padding:8px 0;text-align:right;font-weight:bold;">${inv.invoice_no || '–'}</td></tr>
          <tr><td style="padding:8px 0;color:#7a8580;">Datum</td><td style="padding:8px 0;text-align:right;">${datum}</td></tr>
          <tr><td style="padding:8px 0;color:#7a8580;">Ladestation</td><td style="padding:8px 0;text-align:right;">${inv.wallbox_name || inv.wallbox_id}</td></tr>
          <tr><td style="padding:8px 0;color:#7a8580;border-top:1px solid #e3ddd0;">Geladene Energie</td><td style="padding:8px 0;text-align:right;border-top:1px solid #e3ddd0;">${fmt3(inv.energy_kwh)} kWh</td></tr>
          <tr><td style="padding:8px 0;color:#7a8580;">Preis pro kWh</td><td style="padding:8px 0;text-align:right;">${fmt(inv.price_per_kwh)} ${cur}</td></tr>
          <tr><td style="padding:12px 0;font-weight:bold;font-size:18px;border-top:2px solid #2f7d4f;">Betrag</td><td style="padding:12px 0;text-align:right;font-weight:bold;font-size:18px;color:#2f7d4f;border-top:2px solid #2f7d4f;">${fmt(betrag)} ${cur}</td></tr>
        </table>
        <p style="color:#7a8580;font-size:13px;margin-top:20px;">Vielen Dank, dass Sie bei Steinbock Chalets geladen haben.</p>
      </div>`;

    const text =
`Steinbock Chalets – Ladequittung

Rechnungsnummer: ${inv.invoice_no || '-'}
Datum:           ${datum}
Ladestation:     ${inv.wallbox_name || inv.wallbox_id}
Geladene Energie:${fmt3(inv.energy_kwh)} kWh
Preis pro kWh:   ${fmt(inv.price_per_kwh)} ${cur}
Betrag:          ${fmt(betrag)} ${cur}

Vielen Dank, dass Sie bei Steinbock Chalets geladen haben.`;

    try {
      await this.transport.sendMail({
        from: `"${this.fromName}" <${this.user}>`,
        to: inv.guest_email,
        subject,
        text,
        html,
      });
      this._log('mail_sent', `Quittung an ${inv.guest_email} (${inv.invoice_no})`);
      return { ok: true };
    } catch (e) {
      this._logErr('mail_send_failed', `${inv.guest_email}: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }
}

export default Mailer;
