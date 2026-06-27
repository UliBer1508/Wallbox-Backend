// src/stripe.js
//
// SCHICHT 3b — ABRECHNUNGSLAYER (Konsument der Fassade)
// =====================================================
// Kapselt die gesamte Bezahllogik: Stripe-Vorautorisierung (manual
// capture), Partial Capture mit Deckel, Mindestbetrag-Stornierung,
// Rechnungserzeugung. Reagiert auf Fassaden-Events.
//
// Schichtentrennung (siehe WALLBOX-ARCHITEKTUR-KONZEPT.md Abschnitt 6):
//   - Kennt NUR die Fassade (facade.js) und die DB (db.js).
//   - Kennt KEINE Modbus-Register, spricht nie mit manager/keba direkt.
//   - Will es wissen, wie viel geladen wurde, fragt es facade.getState()
//     oder hört auf das energyUpdated/limitReached/chargingStopped-Event.
//
// Der Stripe-Client ist INJIZIERBAR (Dependency Injection):
//   - Auf dem PC: echter Stripe-Client (import Stripe from 'stripe').
//   - In der Sandbox/Test: ein Fake-Client (kein echtes Geld, kein Key).
// Dadurch ist die ganze Abrechnungslogik offline testbar.
//
// ES-Modul.

// ---------------------------------------------------------------------------
// Bezahl-Resultate (maschinenlesbar)
// ---------------------------------------------------------------------------

export const PAYMENT_RESULT = Object.freeze({
  CAPTURED: 'captured',     // Betrag abgebucht
  CANCELLED: 'cancelled',   // unter Mindestbetrag → Auth freigegeben, nichts abgebucht
  FREE: 'free',             // Bezahl-Schalter aus → keine Abrechnung
  ERROR: 'error',
});

export class BillingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Abrechnungslayer
// ---------------------------------------------------------------------------

export class StripeBilling {
  /**
   * @param {object} deps
   * @param {object} deps.facade   Schicht-3-Fassade (für getState, Events)
   * @param {object} deps.db       Datenschicht (db.js) — Sessions, Invoices
   * @param {object} deps.stripe   Stripe-Client (echt ODER Fake-Client)
   * @param {object} [deps.config] Preis/Reserve/Mindestbetrag-Defaults
   * @param {string} [deps.publicBaseUrl] für Stripe-Rückleitungs-URLs
   */
  constructor({ facade, db, stripe, config = {}, publicBaseUrl = '' } = {}) {
    if (!db) throw new BillingError('DB_MISSING', 'StripeBilling: db fehlt');
    if (!stripe) throw new BillingError('STRIPE_MISSING', 'StripeBilling: stripe-Client fehlt');
    this.facade = facade;
    this.db = db;
    this.stripe = stripe;
    this.publicBaseUrl = publicBaseUrl;
    // Defaults; zur Laufzeit werden die DB-Settings bevorzugt (s. _settings()).
    this._fallback = {
      pricePerKwh: config.pricePerKwh ?? 0.45,
      reserveAmountEur: config.reserveAmountEur ?? 35,
      currency: config.currency ?? 'eur',
      minCaptureEur: config.minCaptureEur ?? 0.5,
    };

    if (facade && typeof facade.on === 'function') this._wireEvents();
  }

  // Aktuelle Settings: DB hat Vorrang vor den Konstruktor-Defaults.
  _settings() {
    const g = (k, d) => {
      const v = this.db.getSetting(k);
      return v === undefined ? d : v;
    };
    return {
      pricePerKwh: g('price_per_kwh', this._fallback.pricePerKwh),
      reserveAmountEur: g('reserve_amount', this._fallback.reserveAmountEur),
      currency: g('currency', this._fallback.currency),
      minCaptureEur: g('min_capture_eur', this._fallback.minCaptureEur),
    };
  }

  // Auf Fassaden-Events hören: bei Limit/Stop automatisch abrechnen.
  _wireEvents() {
    this.facade.on('limitReached', async ({ wallboxId, sessionId }) => {
      // Der Manager leitet nach limitReached selbst den Stop ein; die
      // eigentliche Abrechnung passiert beim chargingStopped-Event (finaler kWh).
      this.db.log('limitReached', { wallboxId, sessionId });
    });

    this.facade.on('chargingStopped', async ({ wallboxId, sessionId, finalKWh }) => {
      try {
        await this.settle(sessionId, finalKWh);
      } catch (e) {
        this.db.logError('SETTLE_FAILED', { wallboxId, sessionId, details: e.message });
      }
    });

    this.facade.on('errorOccurred', ({ wallboxId, code, details }) => {
      this.db.logError(code || 'ERROR', { wallboxId, details });
    });
  }

  // -------------------------------------------------------------------------
  // 1) Vorautorisierung (vor dem Laden)
  // -------------------------------------------------------------------------

  /**
   * Reserviert Geld per Stripe (manual capture). Bei modus 'limit' wird
   * genau das Limit reserviert, bei 'voll' der Reservierungsbetrag.
   *
   * @returns {Promise<{ checkoutUrl, paymentRef, reservedEur }>}
   */
  async authorize(session) {
    const st = this._settings();
    const reservedEur = session.mode === 'limit' && session.limit_amount
      ? Number(session.limit_amount)
      : Number(st.reserveAmountEur);

    const amountCents = Math.round(reservedEur * 100);
    const successUrl = `${this.publicBaseUrl}/guest?wb=${session.wallbox_id}&paid=ok&sid=${session.id}`;
    const cancelUrl = `${this.publicBaseUrl}/guest?wb=${session.wallbox_id}&paid=cancel&sid=${session.id}`;

    const checkout = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      payment_intent_data: { capture_method: 'manual' },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: st.currency,
          unit_amount: amountCents,
          product_data: { name: `Ladung ${session.wallbox_name || session.wallbox_id}` },
        },
      }],
      customer_email: session.guest_email || undefined,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { sessionId: session.id, wallboxId: session.wallbox_id },
    });

    this.db.updateSession(session.id, { payment_ref: checkout.id });
    this.db.log('authorize', {
      wallboxId: session.wallbox_id, sessionId: session.id,
      details: { reservedEur, checkoutId: checkout.id },
    });

    return { checkoutUrl: checkout.url, paymentRef: checkout.id, reservedEur };
  }

  // -------------------------------------------------------------------------
  // 2) Freigabe-Prüfung (nach Stripe-Rückkehr, vor Ladestart)
  // -------------------------------------------------------------------------

  /**
   * Prüft, ob die Reservierung wirklich steht (requires_capture).
   * @returns {Promise<{ ok, paymentIntentId }>}
   */
  async confirmAuthorized(session) {
    const checkout = await this.stripe.checkout.sessions.retrieve(session.payment_ref);
    const piId = typeof checkout.payment_intent === 'string'
      ? checkout.payment_intent : checkout.payment_intent?.id;
    if (!piId) return { ok: false, paymentIntentId: null };

    const pi = await this.stripe.paymentIntents.retrieve(piId);
    const ok = pi.status === 'requires_capture';
    // PaymentIntent-ID als payment_ref ablegen (für Capture/Cancel später)
    this.db.updateSession(session.id, { payment_ref: piId, paid: ok });
    return { ok, paymentIntentId: piId };
  }

  // -------------------------------------------------------------------------
  // 3) Abrechnung (nach Ladeende) — Partial Capture mit Deckel
  // -------------------------------------------------------------------------

  /**
   * Rechnet eine Session final ab.
   *   - Bei free_charge (Bezahl-Schalter aus): keine Stripe-Aktion, FREE.
   *   - Capture-Deckel: bei modus 'limit' nie mehr als das Limit (in kWh)
   *     berechnen — schützt vor Über-Abbuchung (Bug-2-Erkenntnis).
   *   - Betrag < Mindestbetrag → Auth canceln (komplette Freigabe).
   *   - Sonst: Partial Capture des echten Betrags, Rest freigeben.
   *   - Schreibt eine Rechnung (invoices) bei tatsächlicher Abbuchung.
   *
   * @param {string} sessionId
   * @param {number} finalKWh   gemessene Energie der Session
   * @returns {Promise<{ result, captured, invoice }>}
   */
  async settle(sessionId, finalKWh) {
    const session = this.db.getSession(sessionId);
    if (!session) throw new BillingError('SESSION_UNKNOWN', `Session ${sessionId} unbekannt`);

    // Schon abgerechnet? (idempotent — z.B. wenn Event doppelt feuert)
    if (session.status === 'completed' || session.status === 'cancelled') {
      return { result: session.captured > 0 ? PAYMENT_RESULT.CAPTURED : PAYMENT_RESULT.CANCELLED,
               captured: session.captured ?? 0, invoice: this.db.getInvoiceBySession(sessionId) };
    }

    const st = this._settings();
    const nowIso = new Date().toISOString();

    // --- Capture-Deckel: bei 'limit' nie über das kWh-Limit hinaus ---
    const cappedKwh = (session.mode === 'limit' && session.limit_kwh)
      ? Math.min(finalKWh, session.limit_kwh)
      : finalKWh;
    const energyKwh = Math.max(0, +Number(cappedKwh).toFixed(3));
    const amount = +(energyKwh * st.pricePerKwh).toFixed(2);

    // --- Bezahl-Schalter aus: kein Stripe, nur protokollieren ---
    if (session.free_charge) {
      this.db.updateSession(sessionId, {
        energy_kwh: energyKwh, amount, captured: 0, status: 'completed',
        paid: false, ended_at: nowIso, note: 'Gratis-Ladung (Bezahlung aus)',
      });
      this.db.log('settle_free', { wallboxId: session.wallbox_id, sessionId, details: { energyKwh } });
      return { result: PAYMENT_RESULT.FREE, captured: 0, invoice: null };
    }

    const piId = session.payment_ref;

    // --- Unter Mindestbetrag: Auth canceln, nichts abbuchen ---
    if (amount < st.minCaptureEur) {
      if (piId) {
        try { await this.stripe.paymentIntents.cancel(piId); } catch (e) {
          this.db.logError('CANCEL_FAILED', { sessionId, details: e.message });
        }
      }
      this.db.updateSession(sessionId, {
        energy_kwh: energyKwh, amount, captured: 0, status: 'cancelled',
        paid: false, ended_at: nowIso, note: `Unter Mindestbetrag (${st.minCaptureEur} €) → storniert`,
      });
      this.db.log('settle_cancelled', { wallboxId: session.wallbox_id, sessionId, details: { amount } });
      return { result: PAYMENT_RESULT.CANCELLED, captured: 0, invoice: null };
    }

    // --- Partial Capture: echten Betrag abbuchen, Rest freigeben ---
    let captured = amount;
    if (piId) {
      const captureCents = Math.round(amount * 100);
      try {
        await this.stripe.paymentIntents.capture(piId, { amount_to_capture: captureCents });
      } catch (e) {
        this.db.logError('CAPTURE_FAILED', { sessionId, details: e.message });
        throw new BillingError('CAPTURE_FAILED', e.message);
      }
    }

    this.db.updateSession(sessionId, {
      energy_kwh: energyKwh, amount, captured, status: 'completed',
      paid: true, ended_at: nowIso,
    });

    // --- Rechnung schreiben ---
    const invoice = this.db.createInvoice({
      session_id: sessionId,
      wallbox_id: session.wallbox_id,
      wallbox_name: session.wallbox_name,
      guest_name: session.guest_name,
      guest_email: session.guest_email,
      energy_kwh: energyKwh,
      price_per_kwh: st.pricePerKwh,
      amount,
      captured,
      currency: st.currency,
      payment_ref: piId,
    });

    this.db.log('settle_captured', {
      wallboxId: session.wallbox_id, sessionId,
      details: { energyKwh, captured, invoice_no: invoice.invoice_no },
    });

    return { result: PAYMENT_RESULT.CAPTURED, captured, invoice };
  }

  // -------------------------------------------------------------------------
  // 4) Abbruch (Zahlung nie abgeschlossen, Auth-Timeout)
  // -------------------------------------------------------------------------

  async cancelAuthorization(sessionId) {
    const session = this.db.getSession(sessionId);
    if (!session) return { ok: false };
    if (session.payment_ref) {
      try { await this.stripe.paymentIntents.cancel(session.payment_ref); }
      catch (e) { this.db.logError('CANCEL_FAILED', { sessionId, details: e.message }); }
    }
    this.db.updateSession(sessionId, {
      status: 'cancelled', paid: false, ended_at: new Date().toISOString(),
      note: 'Vorautorisierung abgebrochen',
    });
    return { ok: true };
  }
}

export default StripeBilling;
