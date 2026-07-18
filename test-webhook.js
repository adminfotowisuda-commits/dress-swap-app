/**
 * test-webhook.js — Simulate a DOKU Nested Direct webhook notification locally.
 *
 * Usage:  node test-webhook.js
 *
 * Sends a POST to the DOKU webhook endpoint with the exact nested JSON
 * payload that DOKU sends in production.
 */

const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = '/api/payments/doku-callback';
const WEBHOOK_URL = `http://localhost:${PORT}${WEBHOOK_PATH}`;

// ── Test payload: DOKU Nested Direct (production format) ──────────
// This matches the exact structure DOKU sends:
//   { order: { invoice_number, amount }, transaction: { status }, additional_info: { package_id } }
// NOTE: DOKU may NOT include customer.email in production webhooks.
// In that case the server falls back to looking up the transaction by invoice_number
// in credits.json (created when the user initiated payment). For standalone testing,
// we include customer.email so the test works without a pre-existing transaction.
const testPayload = {
  order: {
    invoice_number: 'INV-TEST-WEBHOOK-' + Date.now(),
    amount: 11000
  },
  transaction: {
    status: 'SUCCESS'
  },
  additional_info: {
    package_id: 'pkg_trial_11k'
  },
  customer: {
    email: 'bambang@gmail.com'
  }
};

console.log('╔══════════════════════════════════════════════════════╗');
console.log('║  🧪 DOKU Webhook Local Test (Nested Direct)         ║');
console.log('╠══════════════════════════════════════════════════════╣');
console.log(`║  Target: ${WEBHOOK_URL}`);
console.log(`║  Payload: ${JSON.stringify(testPayload)}`);
console.log('╚══════════════════════════════════════════════════════╝');
console.log('');

(async () => {
  try {
    const resp = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testPayload)
    });

    const text = await resp.text();
    console.log(`  Response status: ${resp.status}`);
    console.log(`  Response body:   ${text}`);
    console.log('');

    if (resp.ok) {
      console.log('✅ Webhook POST succeeded — check server console for [WEBHOOK INCOMING] and [doku-callback] logs.');
    } else {
      console.log('❌ Webhook POST failed — see response above.');
    }

    // ── Verify credits were added ──────────────────────────────────
    console.log('');
    console.log('── Verifying credits.json ──');
    // Use fresh require — flush Node's module cache to see latest write
    delete require.cache[require.resolve('./credits.json')];
    const credits = require('./credits.json');

    // Find the transaction by invoice
    const txn = credits.transactions.find(t => t.invoice_number === testPayload.order.invoice_number);
    if (txn) {
      console.log(`  Transaction found: ${txn.invoice_number} | status=${txn.status} | +${txn.amount} credits`);
      const user = credits.users[txn.email];
      if (user) {
        console.log(`  User:  ${user.email}`);
        console.log(`  Balance: ${user.credits_balance} credits`);
      }
      console.log('✅ Credits successfully added!');
    } else {
      console.log(`  ⚠️  No transaction recorded for invoice ${testPayload.order.invoice_number}`);
      console.log('     (this is expected if the server is not running)');
    }
  } catch (err) {
    console.error('❌ Could not reach the server:', err.message);
    console.error('');
    console.error('   Make sure the server is running:');
    console.error('     node server.js');
  }
})();
