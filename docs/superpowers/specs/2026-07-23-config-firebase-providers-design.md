# Config-driven Firebase sign-in providers

**Date:** 2026-07-23
**Branch:** `feature/config-firebase-providers` (off `picup/main`)
**Status:** design — awaiting review

## Problem

The FirebaseUI login widget (`lib/views/login-firebase.html`) hardcodes its
`signInOptions` list to **both** email/password and Google:

```js
signInOptions: [
  firebase.auth.EmailAuthProvider.PROVIDER_ID,
  firebase.auth.GoogleAuthProvider.PROVIDER_ID
],
```

FirebaseUI renders exactly this list; it does **not** consult the Firebase
console to discover which providers a project has actually enabled. So a
deployment whose Firebase project only enables Google (e.g. uindy) still shows
an email/password form — a dead button that fails at the backend with
`auth/operation-not-allowed`.

Deployments need different provider sets:

| Deploy | Auth provider | Sign-in buttons wanted |
|--------|---------------|------------------------|
| mandi  | firebase      | Google **and** email/password |
| uindy  | firebase      | Google only |
| picup  | local         | n/a — uses `login.html`, not FirebaseUI |

## Approach

Make the widget's provider list **config-driven**, then set the value per
deployment through the **existing** `deploys/<name>/config/` overlay mechanism
(`config/deploy-dir.js`). No new config-delivery mechanism is introduced — this
is a one-value hardcode being lifted into config that the deploy overlay already
knows how to override.

Rejected alternative — view-shadowing a full per-deploy copy of
`login-firebase.html` (`deploys/<name>/views/`): works with zero committed-code
change, but forks a ~140-line template per deployment, so every future login-page
fix (email-verification flow, etc.) must be re-applied to each copy. Shadowing is
the right tool for genuinely per-deploy *pages*; it is the wrong tool for a single
shared config value. Not chosen.

## Design

Three small changes to committed code, plus one private-repo overlay value.

### 1. `config/default.yaml`

Add under `auth.firebase:` a `providers` list, defaulting to both (preserves
current behavior for every existing firebase deploy):

```yaml
  firebase:
    # Sign-in methods FirebaseUI shows, in order. Must be kept in sync with the
    # providers actually enabled in the Firebase console — the app cannot
    # auto-discover them. Supported: 'google', 'password'. Override per deploy
    # (e.g. ['google'] for a Google-only deployment).
    providers: ['google', 'password']
    projectId: ''
    clientConfig:
      ...
```

### 2. `lib/controllers/auth.js` — `loginPage`

Thread the list into the view alongside the `firebaseConfig` it already injects:

```js
return request.success({
  firebaseConfig: firebaseConfig,
  authEmulatorUrl: process.env.FIREBASE_AUTH_EMULATOR_URL || null,
  authProviders: (config.auth.firebase && config.auth.firebase.providers) || ['google']
});
```

Fallback to `['google']` (never an empty list) if config is somehow absent.

### 3. `lib/views/login-firebase.html`

Replace the literal `signInOptions` array with a builder that maps injected
provider names to FirebaseUI `PROVIDER_ID`s, guarding against an empty/unknown
list (never render a login box with zero buttons):

```js
var providerIds = {
  google:   firebase.auth.GoogleAuthProvider.PROVIDER_ID,
  password: firebase.auth.EmailAuthProvider.PROVIDER_ID
};
var wanted = {% if authProviders %}{{ authProviders | json | safe }}{% else %}['google']{% endif %};
var signInOptions = wanted.map(function(name){ return providerIds[name]; }).filter(Boolean);
if (!signInOptions.length) { signInOptions = [providerIds.google]; }
...
ui.start('#firebaseui-auth-container', {
  signInOptions: signInOptions,
  ...
```

### 4. Per-deploy overlay (private deploy repos, not this tree)

- **uindy** `deploys/uindy/config/…`: `auth: { firebase: { providers: ['google'] } }`
- **mandi**: no change needed (inherits `['google','password']`); may set it
  explicitly for clarity.
- **picup**: unaffected — `auth.provider: local` renders `login.html`; this key
  is inert for local-auth deploys. This is what makes the design work uniformly
  across GCP and non-GCP deployments: the config key is simply ignored where
  FirebaseUI isn't used.

## Testing

- **Controller:** assert `loginPage` includes `authProviders` in its view
  context, defaulting to both providers under stock config and honoring an
  override.
- **Manual verification:** with `providers: ['google']`, the login page shows
  only the Google button; with the default, both. (FirebaseUI rendering itself
  isn't unit-testable here.)

## Risks / notes

- **Config must match the console.** The list controls the *UI* only; the
  Firebase backend still enforces its own enabled-providers. If they disagree the
  failure mode is the current one (a button that errors), just now operator-fixable
  via config rather than code. The default.yaml comment states this obligation.
- Backward-compatible: default is the current both-providers behavior, so mandi
  and any other existing firebase deploy are unchanged until they opt in.
- Order in the array = display order in the widget.

## Out of scope

- The `local` provider's `login.html` form (separate template, separate flow).
- Auto-syncing the UI list from the Firebase console (not exposed to the client
  SDK; operator responsibility).
