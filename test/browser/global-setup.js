const { request } = require('@playwright/test');
const path = require('path');

// Hermetic login against the local `make gcp` stack's Firebase Auth emulator —
// the same seam the vitest `flow` harness uses (test/helpers/flow.cjs
// mintFirebaseToken): sign up (or sign in) a fixture account, mark its email
// verified, mint a fresh ID token, then exchange it at POST /api/auth/session for
// a real yar session cookie. The stack runs open-signup (no requireApprovedAccount),
// so any email auto-creates an account. No Google popup, no real project.
const BASE     = process.env.TRINKET_BASE_URL || 'http://localhost:3001';
const AUTH_EMU = process.env.FIREBASE_AUTH_EMULATOR_URL || 'http://localhost:9099';
const EMAIL    = process.env.SMOKE_EMAIL || 'smoke-tester@example.com';
const PASSWORD = 'emu-smoke-000000'; // emulator-only; >= 6 chars

async function mintVerifiedIdToken(ctx) {
  const acct = `${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:`;
  const body = { email: EMAIL, password: PASSWORD, returnSecureToken: true };

  let res = await ctx.post(`${acct}signUp?key=fake-api-key`, { data: body });
  let json = await res.json();
  if (json.error && /EMAIL_EXISTS/.test(json.error.message || '')) {
    res = await ctx.post(`${acct}signInWithPassword?key=fake-api-key`, { data: body });
    json = await res.json();
  }
  if (!json.idToken) throw new Error('auth emulator gave no idToken: ' + JSON.stringify(json.error || json));

  // Admin-mark email verified (POST /api/auth/session rejects unverified emails),
  // then re-sign-in so the fresh token carries email_verified:true.
  await ctx.post(`${acct}update?key=fake-api-key`, {
    headers: { Authorization: 'Bearer owner' },
    data: { localId: json.localId, emailVerified: true },
  });
  res = await ctx.post(`${acct}signInWithPassword?key=fake-api-key`, { data: body });
  json = await res.json();
  if (!json.idToken) throw new Error('auth emulator re-sign-in failed: ' + JSON.stringify(json.error || json));
  return json.idToken;
}

module.exports = async () => {
  const ctx = await request.newContext({ baseURL: BASE });
  const idToken = await mintVerifiedIdToken(ctx);
  const res = await ctx.post('/api/auth/session', { data: { idToken } });
  if (!res.ok()) {
    throw new Error(`POST /api/auth/session failed: ${res.status()} ${await res.text()}`);
  }
  await ctx.storageState({ path: path.join(__dirname, '.auth-state.json') });
  await ctx.dispose();
  console.log(`[global-setup] logged in as ${EMAIL} @ ${BASE}`);
};
