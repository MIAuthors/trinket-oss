// globalSetup for the deploy suite: when no standing credentials are supplied,
// mint a per-run instructor and student, hand them to the specs through the same
// SMOKE_* variables they already read, and record them for teardown.
//
// Opt-out by design — setting SMOKE_EMAIL/SMOKE_PASSWORD keeps the standing-account
// path, which is what CI needs until it has a way to get a gcloud token
// (workload identity federation). Nothing here changes how a spec signs in.
const { request } = require('@playwright/test');
const fs   = require('fs');
const path = require('path');
const ephemeral = require('./ephemeral-identity');

const RECORD = path.join(__dirname, '.auth', 'ephemeral-run.json');

module.exports = async () => {
  const baseURL = process.env.TRINKET_BASE_URL;
  if (process.env.SMOKE_EMAIL || !baseURL) return;      // standing accounts, or nothing to do

  // Production is refused LOUDLY and first, before any probe. This list names
  // the deploys real people use, and an operator who points the suite at one
  // should be told exactly that — not given the generic form-auth skip below,
  // which two of the three would otherwise hit.
  ephemeral.assertNotProduction(baseURL);

  const ctx = await request.newContext({ baseURL });

  // Form-auth deploys (a password field on /login) have no Firebase to mint
  // against — minting there throws, and a throw in globalSetup kills the WHOLE
  // run, anonymous specs included. Detect and bow out instead: the journeys
  // will skip for want of SMOKE_EMAIL, exactly as before this file existed.
  //
  // This probe runs BEFORE assertMintable, and the order matters. assertMintable
  // is itself a throw, so with it first a form-auth deploy whose host is not on
  // the allowlist died here and took the anonymous specs with it — the bow-out
  // below could never be reached. It only ever appeared to work from
  // trial-merge.spvi.net, which is already permitted. Found by @drewsday against
  // the PICUP VPS staging box.
  const login = await (await ctx.get(new URL('/login', baseURL).toString())).text();
  if (/type="password"/.test(login)) {
    console.log('  ephemeral identities: form-auth deploy, nothing to mint (set SMOKE_EMAIL to run journeys here)');
    await ctx.dispose();
    return;
  }

  // Refuse before creating anything, not after. Still ahead of every mint, which
  // is what that promise means; a form-auth deploy has no Firebase to mint
  // against at all, so the allowlist was gating a path that could not be taken.
  ephemeral.assertMintable(baseURL);

  const instructor = await ephemeral.mint(ctx, baseURL, 'teacher');
  const student    = await ephemeral.mint(ctx, baseURL, 'learner');
  await ctx.dispose();

  process.env.SMOKE_EMAIL            = instructor.email;
  process.env.SMOKE_PASSWORD         = instructor.password;
  process.env.SMOKE_STUDENT_EMAIL    = student.email;
  process.env.SMOKE_STUDENT_PASSWORD = student.password;

  // Teardown runs in its own process, so the run is recorded on disk rather than
  // in memory. .auth/ is gitignored; the file is deleted by the teardown.
  fs.mkdirSync(path.dirname(RECORD), { recursive: true });
  fs.writeFileSync(RECORD, JSON.stringify({ baseURL, identities: [instructor, student] }), { mode: 0o600 });
  console.log('  ephemeral identities minted: ' + instructor.email + ', ' + student.email);
};

module.exports.RECORD = RECORD;
