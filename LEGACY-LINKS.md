# Keeping old trinket.io links working

**Audience:** instructors who imported courses or trinkets from trinket.io and
have old links embedded somewhere outside this server.

Importing does **not** preserve trinket.io short codes — each imported trinket
gets a new one and keeps the original in an indexed `legacyShortCode` field.
That field is what makes everything below work.

---

## 1. If you imported the whole course, do nothing

The importer already rewrote every trinket embed inside the imported course
material to point at this server. That is the `legacyMap` pass in
`lib/controllers/imports.js` (see `patchUnresolvedRefs` and
`lib/util/embedRewrite.js`).

This page only matters for links you pasted **somewhere else** — your LMS,
a syllabus, a department web page, a handout.

## 2. Quick fix: keep the old code, insert `/legacy`

Change the host and add `/legacy`. The short code stays exactly as it was.

```
old:  https://trinket.io/glowscript/abee451f3e
new:  https://YOUR-SERVER/legacy/glowscript/abee451f3e

old:  https://trinket.io/embed/python3/abc123def0
new:  https://YOUR-SERVER/legacy/embed/python3/abc123def0
```

Four route shapes are registered (`config/routes.js`), so the language segment
is optional in both forms:

| Route | Use |
|---|---|
| `GET /legacy/{lang}/{shortCode}` | direct link |
| `GET /legacy/{shortCode}` | direct link, language unknown |
| `GET /legacy/embed/{lang}/{shortCode}` | iframe embed |
| `GET /legacy/embed/{shortCode}` | iframe embed, language unknown |

The language segment is decorative on the way in — the redirect target is built
from the trinket's own `lang` in the database, so a wrong or missing language
still resolves.

**Query strings survive.** `?outputOnly=true`, `?start=result`,
`?showInstructions=true` and friends are re-attached to the redirect target, so
embeds keep their display options.

The response is a **301 (permanent)** to the canonical
`/{lang}/{newShortCode}` — or `/embed/{lang}/{newShortCode}`.

## 3. Better for anything long-lived: use the canonical URL

Open the trinket → **Share** → copy the link or embed code. That gives the
canonical `/{lang}/{new-code}` directly.

Prefer this for anything students rely on all term — a syllabus, a course page,
an assignment description. Two reasons:

- **The redirect is a 301, so browsers cache it.** Students end up on the
  canonical URL anyway; you may as well publish it.
- **`/legacy/...` is not owner-scoped.** See the caveat below.

---

## Caveat: legacy codes are not unique across accounts

`resolveLegacy()` (`lib/controllers/trinket.js`) looks up
`Trinket.findByLegacyShortCodes([code])` with **no owner filter**. If several
instructors imported the same source course — an M&I course, say — then several
trinkets carry the *same* `legacyShortCode`.

The redirect filters out deleted trinkets, then takes `live[0]` and logs:

```
Multiple trinkets share legacyShortCode "<code>"; redirecting to <shortCode>
```

So a `/legacy/...` link can land on **a colleague's copy** of the trinket, which
will then drift away from your own edits. Harmless for a one-off migration
convenience; not what you want in material students use all semester.

If nothing matches, or every match is deleted, the route returns **404**.

## Resolving codes in bulk

To rewrite many links at once — or to get canonical URLs for a whole
assignment set — `scripts/legacy-shortcode-map.js` maps old codes to new ones
and prints the canonical URL for each. It only reads.

```
GOOGLE_CLOUD_PROJECT=<project> FIRESTORE_PROJECT_ID=<project> \
NODE_ENV=production NODE_APP_INSTANCE=cloudrun \
node scripts/legacy-shortcode-map.js --csv abee451f3e 6fde40b288
```

Pass `--owner <userId>` to disambiguate when a legacy code has several copies —
which is exactly the case the redirect cannot handle on its own.

---

## Where this behaviour lives

| Piece | Location |
|---|---|
| `legacyShortCode` field | `lib/models/trinket.js` (indexed, sparse) |
| Batch lookup | `Trinket.findByLegacyShortCodes` / `findByOwnerAndLegacyShortCodes` |
| Redirect handler | `resolveLegacy()` in `lib/controllers/trinket.js` |
| Route registration | `config/routes.js` |
| Embed rewriting on import | `lib/util/embedRewrite.js`, `lib/controllers/imports.js` |
| Bulk code mapping | `scripts/legacy-shortcode-map.js` |
