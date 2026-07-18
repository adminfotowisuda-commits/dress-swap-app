/**
 * test-webhook.js — Simulate a DOKU Legacy webhook notification locally.
 *
 * Usage:  node test-webhook.js
 *
 * Sends a POST to the DOKU webhook endpoint with a flat Legacy payload
 * so we can verify the credits-adding logic works end-to-end.
 */

const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = '/api/payments/doku-callback';
const WEBHOOK_URL = `http://localhost:${PORT}${WEBHOOK_PATH}`;

// ── Test payload: DOKU Legacy flat format ──────────────────────────
// STATUSCODE '0000' = success
// AMOUNT 10000 → maps to pkg_trial_10k → 10 credits
const testPayload = {
  TRANSIDMERCHANT: 'INV-TEST-WEBHOOK-' + Date.now(),
  STATUSCODE: '0000',
  AMOUNT: '10000.00',
  EMAIL: 'moci@gmail.com'
};

console.log('╔══════════════════════════════════════════════════════╗');
console.log('║  🧪 DOKU Webhook Local Test                         ║');
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
    const credits = require('./credits.json');
    const user = credits.users['moci@gmail.com'];
    if (user) {
      console.log(`  User:  ${user.email}`);
      console.log(`  Balance: ${user.credits_balance} credits`);
    } else {
      console.log('  User moci@gmail.com not found in credits.json');
    }

    // Check if transaction was recorded
    const txn = credits.transactions.find(t => t.invoice_number === testPayload.TRANSIDMERCHANT);
    if (txn) {
      console.log(`  Transaction found: ${txn.invoice_number} | status=${txn.status} | +${txn.amount} credits`);
      console.log('✅ Credits successfully added!');
    } else {
      console.log(`  ⚠️  No transaction recorded for invoice ${testPayload.TRANSIDMERCHANT}`);
      console.log('     (this is expected if the server is not running)');
    }
  } catch (err) {
    console.error('❌ Could not reach the server:', err.message);
    console.error('');
    console.error('   Make sure the server is running:');
    console.error('     node server.js');
  }
})();
