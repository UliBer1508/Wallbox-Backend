// test/fake-stripe.mjs
//
// Fake-Stripe-Client für Tests und Sandbox. Bildet exakt die Methoden nach,
// die stripe.js nutzt — ohne echten Key, ohne echtes Geld. Merkt sich alle
// Aufrufe, damit Tests prüfen können, was abgebucht/storniert wurde.

export function makeFakeStripe() {
  const calls = [];
  const intents = new Map();   // piId -> { status, amount, captured, cancelled }
  let seq = 0;

  return {
    calls,
    intents,
    checkout: {
      sessions: {
        create: async (params) => {
          seq++;
          const piId = `pi_fake_${seq}`;
          const csId = `cs_fake_${seq}`;
          intents.set(piId, {
            id: piId,
            status: 'requires_capture',
            amount: params.line_items[0].price_data.unit_amount,
            captured: null,
            cancelled: false,
          });
          calls.push(['checkout.create', { csId, piId, amount: intents.get(piId).amount }]);
          return { id: csId, url: `https://fake.stripe/${csId}`, payment_intent: piId };
        },
        retrieve: async (csId) => {
          // piId aus der Reihenfolge: wir haben ihn beim create gemerkt
          const piId = [...intents.keys()].find(k => k.endsWith(csId.split('_').pop()));
          return { id: csId, payment_intent: piId };
        },
      },
    },
    paymentIntents: {
      retrieve: async (piId) => {
        const pi = intents.get(piId);
        return pi ? { ...pi } : { id: piId, status: 'unknown' };
      },
      capture: async (piId, { amount_to_capture } = {}) => {
        const pi = intents.get(piId);
        if (!pi) throw new Error(`PI ${piId} nicht gefunden`);
        pi.status = 'succeeded';
        pi.captured = amount_to_capture;
        calls.push(['capture', { piId, amount_to_capture }]);
        return { ...pi };
      },
      cancel: async (piId) => {
        const pi = intents.get(piId);
        if (pi) { pi.status = 'canceled'; pi.cancelled = true; }
        calls.push(['cancel', { piId }]);
        return { id: piId, status: 'canceled' };
      },
    },
  };
}

export default makeFakeStripe;
