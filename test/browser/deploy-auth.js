// Sign-in + API helpers shared by the authenticated specs-deploy journeys.
//
// Two ways in, matching the two kinds of deploy (docs/DEPLOY-TESTING.md):
//   form auth      — SMOKE_EMAIL/SMOKE_PASSWORD, POST /login (Mongo trial, picup VPS)
//   captured state — SMOKE_STORAGE_STATE from save-session.js (Firebase deploys)
//
// A second identity (SMOKE_STUDENT_*) exists so the student half of the loop is
// exercised by an ACTUAL second account. Submitting as the course owner would
// pass while every permission boundary went untested — the owner can do
// everything, so it proves nothing about what a student can do.

async function signInWithForm(page, baseURL, email, password) {
  await page.goto('/login');
  await page.fill('input[name="email"], input[type="email"]', email);
  await page.fill('input[name="password"], input[type="password"]', password);
  await Promise.all([
    page.waitForURL((u) => !/\/login/.test(u.toString()), { timeout: 30_000 }),
    page.click('button[type="submit"], input[type="submit"]'),
  ]);
  if (/\/login/.test(page.url())) throw new Error('sign-in failed for ' + email);
}

// Tolerant unwrapping: these endpoints variously answer {course},{data},{lesson}
// or the bare object, and it differs by route. A spec that guesses wrong reports
// a confusing downstream failure instead of the real one.
function unwrap(body, key) {
  if (!body) return null;
  return body[key] || body.data || (body.id ? body : null);
}

function apiFor(page, baseURL) {
  return async function api(method, path, payload) {
    const res = await page.request.fetch(new URL(path, baseURL).toString(), {
      method,
      headers: { 'Content-Type': 'application/json' },
      data: payload ? JSON.stringify(payload) : undefined,
    });
    return { status: res.status(), body: await res.json().catch(() => ({})) };
  };
}

// A 200 from this framework does NOT mean the write happened. A schema failure
// answers 200 with the errors tucked into `flash.validation`, which is exactly
// how #204 shipped: Add Students returned 200, added nobody, and every
// status-only assertion agreed it was fine. Same trap caught a silently
// rejected feedback POST while writing these specs. Assert with this, not
// with `expect(status).toBe(200)`.
function assertOk(expect, res, what) {
  expect(res.status, what + ' — HTTP ' + res.status + ': '
    + JSON.stringify(res.body).slice(0, 300)).toBe(200);
  const flash = (res.body && res.body.flash) || {};
  expect(flash.validation, what
    + ' — 200 but the payload was REJECTED (validation flash): '
    + JSON.stringify(flash.validation)).toBeFalsy();
  const err = (res.body && (res.body.error || (flash.error && flash.error.length))) || null;
  expect(err, what + ' — 200 with an error flash: ' + JSON.stringify(err)).toBeFalsy();
}

module.exports = { signInWithForm, apiFor, unwrap, assertOk };
