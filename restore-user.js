/**
 * restore-user.js — Re-insert a user into credits.json on the production server.
 *
 * Run this ONCE on Hostinger after a deploy overwrote credits.json:
 *   node restore-user.js
 *
 * Safe to run multiple times — it only inserts if the user is missing or
 * updates if they exist (won't reduce credits below what you specify).
 */

const fs = require('fs');
const path = require('path');

const CREDITS_PATH = path.join(__dirname, 'credits.json');

// ── CONFIGURE THE USER TO RESTORE ──────────────────────────────────
const USER_TO_RESTORE = {
  email: 'bambang@gmail.com',
  password: '123',
  credits_balance: 20,       // minimum credits to ensure
  created_at: '2026-07-17T14:17:09.020Z'
};
// ────────────────────────────────────────────────────────────────────

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(CREDITS_PATH, 'utf8'));
  } catch (err) {
    return { users: {}, transactions: [], packages: [] };
  }
}

function writeDB(data) {
  fs.writeFileSync(CREDITS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ── Main ───────────────────────────────────────────────────────────
const db = readDB();
const email = USER_TO_RESTORE.email;
const existing = db.users[email];

if (existing) {
  console.log(`✅ ${email} already exists.`);
  console.log(`   Current balance: ${existing.credits_balance} credits`);

  // Bump credits if below minimum
  if (existing.credits_balance < USER_TO_RESTORE.credits_balance) {
    const diff = USER_TO_RESTORE.credits_balance - existing.credits_balance;
    existing.credits_balance = USER_TO_RESTORE.credits_balance;
    existing.updated_at = new Date().toISOString();
    console.log(`   ⬆️  Bumped to ${USER_TO_RESTORE.credits_balance} credits (+${diff})`);
  }

  // Ensure password is set
  if (!existing.password) {
    existing.password = USER_TO_RESTORE.password;
    console.log(`   🔑 Password set to "${USER_TO_RESTORE.password}"`);
  }
} else {
  // Create new user
  db.users[email] = {
    email: email,
    password: USER_TO_RESTORE.password,
    credits_balance: USER_TO_RESTORE.credits_balance,
    created_at: USER_TO_RESTORE.created_at,
    updated_at: new Date().toISOString()
  };
  console.log(`✅ ${email} created with ${USER_TO_RESTORE.credits_balance} credits.`);
  console.log(`   Password: "${USER_TO_RESTORE.password}"`);
}

writeDB(db);

// ── Verify ─────────────────────────────────────────────────────────
const verify = readDB();
const user = verify.users[email];
console.log('');
console.log('── Verification ──');
console.log(`  Email:    ${user.email}`);
console.log(`  Password: ${user.password}`);
console.log(`  Balance:  ${user.credits_balance} credits`);
console.log(`  Created:  ${user.created_at}`);
console.log('');
console.log('✅ Done — user ready for login.');
