# Fixing embed links after importing your trinkets

*For instructors who used to embed trinkets from trinket.io and have now imported
them into this site.*

When you import trinkets, each one gets a **new address** here. Your old embed
code still points at trinket.io, so it keeps loading the old copy — the one you
can no longer edit.

This guide covers the three situations, quickest first.

---

## 1. Did you import a whole course? Then you're probably done

If you imported a **course** (not just individual trinkets), the importer already
found the trinket embeds inside your course pages and repointed them at this
site. Open a page or two and check.

You only need the rest of this guide for embeds you put somewhere **else** — your
own LMS page, a department website, a syllabus, a Google Doc.

---

## 2. The quick fix: add `/legacy` to the address

You do **not** need to look up the new code. Keep the old address, change the
site, and add `/legacy` after it:

```
old:  https://trinket.io/embed/python3/abc123def0

new:  https://YOUR-SITE/legacy/embed/python3/abc123def0
                        ^^^^^^^
```

Replace `YOUR-SITE` with the address you use for this site.

That link finds the trinket by its old code and forwards to its new home. Any
options on the end of the address are kept, so this still works:

| Old | New |
|---|---|
| `https://trinket.io/embed/python3/abc123def0` | `https://YOUR-SITE/legacy/embed/python3/abc123def0` |
| `https://trinket.io/embed/python3/abc123def0?outputOnly=true` | `https://YOUR-SITE/legacy/embed/python3/abc123def0?outputOnly=true` |
| `https://trinket.io/embed/glowscript/abc123def0` | `https://YOUR-SITE/legacy/embed/glowscript/abc123def0` |

If you don't know which language it was, you can leave that part out:
`https://YOUR-SITE/legacy/embed/abc123def0`

**In an `<iframe>`,** change only the `src`:

```html
<iframe src="https://YOUR-SITE/legacy/embed/python3/abc123def0"
        width="100%" height="600" frameborder="0"></iframe>
```

---

## 3. The tidy fix: copy the new embed code

Better for anything students will use all term — a syllabus, a course page, a
public site.

1. Sign in and open **My Trinkets**.
2. Open the trinket you want.
3. Click **Share**.
4. Copy the **embed code** and paste it in place of the old one.

That gives you the trinket's real address here, which won't depend on the old
one at all.

**Why this is worth doing:** the `/legacy` link is a forwarding address. It works,
but it's a redirect — and see the note below about shared courses.

---

## If several of you imported the same course

This matters for shared courseware, such as a Matter & Interactions course that
more than one instructor imported.

The old code identifies *the trinket you imported from*, not *your copy*. If you
and a colleague both imported the same course, your copies **share the same old
code**. A `/legacy` link can therefore land on **your colleague's copy** rather
than yours.

You won't notice at first — the copies start out identical. You'd notice later,
after you edit yours and the embedded version doesn't change.

**So:** for anything you'll rely on — a course page, a syllabus, anything students
use — take a minute to use the **Share** embed code (section 3). Save `/legacy`
for quickly checking that an old link still resolves.

---

## If the link doesn't work

**"Not found" / a 404 page**

- **The trinket wasn't imported here.** `/legacy` only knows trinkets that came in
  through an import. One you created fresh on this site has no old code — use
  **Share** instead.
- **A typo in the code.** It's the long string on the end of the old trinket.io
  address, e.g. `abc123def0`.
- **The trinket was deleted.** Deleted trinkets are skipped.

**It goes to the wrong trinket**

Almost certainly the shared-course situation above. Use the **Share** embed code
for your own copy.

**It still shows the old trinket.io version**

The address probably still says `trinket.io`. Check the `src` inside the
`<iframe>`, not just the visible text — and note your browser may have cached the
old page, so reload.

---

## Quick reference

| Situation | What to do |
|---|---|
| Imported a whole course | Nothing — embeds in course pages were repointed for you |
| Old embed elsewhere, want it working now | Change the site and add `/legacy` |
| Anything students use all term | Open the trinket → **Share** → copy the embed code |
| Trinket created here, never imported | **Share** — `/legacy` won't find it |

---

## Notes for administrators

The moving parts, for anyone supporting the above.

**Routes** (`config/routes.js`):

```
GET /legacy/embed/{lang}/{shortCode}   trinket.legacyEmbedRedirect
GET /legacy/embed/{shortCode}          trinket.legacyEmbedRedirect
GET /legacy/{lang}/{shortCode}         trinket.legacyRedirect
```

`resolveLegacy()` in `lib/controllers/trinket.js` looks up `legacyShortCode`,
filters deleted records, and issues a **301** to the canonical
`/embed/{lang}/{shortCode}`, preserving the query string. Because it's permanent,
browsers cache it.

**Where the old code comes from:** import stores the source code on each record as
`legacyShortCode` (`lib/models/trinket.js`, indexed and **sparse**).

**Why a `/legacy` link can hit the wrong copy:** `resolveLegacy()` calls
`findByLegacyShortCodes([code])`, which is **not owner-scoped**. When several
users import the same course, multiple live trinkets share one `legacyShortCode`;
the handler takes the first and logs
`Multiple trinkets share legacyShortCode "..."`. Owner-scoped variants
(`findByOwnerAndLegacyShortCode`) exist and are used by the import de-duplication,
but a redirect has no user context to scope by when the link is opened
anonymously — which is the normal case for an embed.

**Course material is rewritten at import time**, separately from the redirect:
`lib/util/embedRewrite.js` handles both embed shapes — `/embed/{lang}/{shortCode}`
(remapped through the import's `legacyMap`) and shortcode-less sandbox embeds
`/embed/{lang}` (host rewritten only). `lib/controllers/imports.js` builds that
map and runs a second pass for references that didn't resolve first time.
