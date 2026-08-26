> **STATUS (2026-08-15):** archived draft. The bug is FIXED in this repo's main
> (movematerial via the hapi-20 port fixes; shortCode tracked as our #151 —
> latent, zero call sites). Still live in trinketapp/main; file upstream only
> if/when we re-engage there (our PR #25 there was closed unmerged).

# `shortCode` length mismatch: `hashify()` uses 12 chars, `verifyShortCode()` uses 10 — regenerates trinket shortCodes on update

> Draft issue for **trinketapp/trinket-oss**. Found in `trinketapp/main` (`lib/models/trinket.js`). Tweak as needed before submitting.

## Summary

In `lib/models/trinket.js`, `hashify()` generates a **12**-character `shortCode`, but `verifyShortCode()` recomputes a **10**-character value and `delete`s the stored `shortCode` when the two don't strictly match. A 10-character string can never `!==`-match a 12-character one, so `verifyShortCode()` **always** deletes the `shortCode` — which is then regenerated (with a fresh `Date.now()`), **changing the trinket's `shortCode` (and its public URL)** on the code paths that call it.

## Details

`hashify()` ([`lib/models/trinket.js:115`](lib/models/trinket.js#L115)) — sets a **12**-char `shortCode` when one isn't already present:

```js
function hashify() {
  var seed  = this.generateSeed();
  this.hash = crypto.createHash('sha1').update(seed).digest('hex');

  if (!this.shortCode) {
    this.shortCode = crypto.createHash('sha1').update(seed + Date.now()).digest('hex').substring(0, 12);
  }
}
```

`verifyShortCode(timestamp)` ([`lib/models/trinket.js:174`](lib/models/trinket.js#L174)) — recomputes **10** chars and deletes on mismatch:

```js
function verifyShortCode(timestamp) {
  var seed = this.generateSeed();

  var shortCode = crypto.createHash('sha1').update(seed + timestamp).digest('hex').substring(0, 10);

  if (shortCode !== this.shortCode) {
    delete this.shortCode;
  }
}
```

`verifyShortCode()` is live — called from the trinket controller at [`lib/controllers/trinket.js:349`](lib/controllers/trinket.js#L349) and [`:404`](lib/controllers/trinket.js#L404), passing `request.payload._timestamp`. After it deletes `shortCode`, `hashify()` (invoked during save, [`lib/models/trinket.js:100`](lib/models/trinket.js#L100)) regenerates a new 12-char value with a fresh `Date.now()` — so the `shortCode` changes.

## Impact

On the two controller paths that call `verifyShortCode()`, a trinket's `shortCode` is regenerated **every time** — even when the seed is unchanged — because the 12-vs-10 length difference alone guarantees the strict-inequality. This changes the trinket's public identifier / URL.

## Expected vs. actual

- **Expected:** `verifyShortCode()` keeps the existing `shortCode` when the seed (and timestamp) are unchanged, and only triggers regeneration when the seed actually changes.
- **Actual:** it always deletes/regenerates, because it compares a freshly computed **10**-char value against the stored **12**-char value.

## Likely cause

It looks like `hashify()` was changed from 10 → 12 characters at some point without a corresponding update to `verifyShortCode()` (still 10).

## Possible fix

Align the lengths — change `verifyShortCode()`'s `.substring(0, 10)` to `.substring(0, 12)` (or switch to a prefix comparison). Then an unchanged seed + timestamp recomputes the same 12-char value → match → keep; a changed seed → mismatch → regenerate, as intended.

## Question for maintainers

Was the 12-char length in `hashify()` (or the 10 in `verifyShortCode()`) intentional? I'd like to confirm the intended `shortCode` length and the intended `verifyShortCode()` semantics before proposing a patch — hence opening this for discussion rather than a direct PR.

## How this was found

Surfaced while modernizing the test suite (porting the trinket model tests to a current runner). The legacy test asserted the **10**-char length — consistent with the older `hashify()` — so the drift to 12 went unnoticed because the suite wasn't being run.
