# Using trinket from your LMS — instructor guide

*(Draft — per-platform steps marked ✅ are verified by a real launch; ⬜ are
written from platform documentation and awaiting a test launch.)*

Trinket connects to your LMS (Canvas, Moodle, Brightspace/D2L, …) via LTI 1.3.
Once connected:

* You add trinket **assignments directly from your LMS** — a picker lets you
  choose the exercise when you create the assignment.
* Students click the assignment in the LMS and are **signed in and enrolled
  automatically** — no separate trinket accounts to manage.
* Each student works in their **own copy** of the assignment trinket.
* When a student submits, their work appears in your LMS gradebook for review.

## ⚠️ How grading works (read this first)

**Trinket never assigns scores.** When a student submits, trinket marks the
LMS gradebook entry as **"needs grading"** and attaches a link that opens the
student's actual work (their code, runnable) right inside your grader —
SpeedGrader in Canvas, the equivalent elsewhere. **You review the work there
and enter the score in the LMS yourself.** If you expect auto-graded points to
appear, this is the surprise to un-surprise yourself about now.

## Everyday use (tool already connected)

### Adding an assignment

1. In your LMS course, create an assignment/activity whose submission type is
   the external tool, and pick **trinket** (in Canvas: Assignment →
   Submission Type → External Tool; ⬜ Moodle: Activity → External tool;
   ⬜ Brightspace: Existing Activities → external learning tool).
2. Trinket's **picker** opens: choose the trinket or course material students
   should start from. What you pick becomes each student's starting point.
3. Save/publish in the LMS as usual.

### What students experience

* First click: account created (from their LMS name/email) + enrolled, landed
  in **their own copy** of the assignment — nothing they do affects your
  original or each other's copies.
* They write and run code in the browser, and **Submit** when done.
* They can reopen and keep working until you close things off on the LMS side
  (availability/lock dates are the LMS's, and the LMS enforces them).

### Reviewing and grading

1. The gradebook entry flips to **needs grading** on submission.
2. Open it in your grader — the student's submitted trinket is embedded,
   runnable, exactly as they left it.
3. Enter the score in the LMS. (Trinket does not write scores — see above.)

## Connecting your LMS to trinket (one-time, admin-level)

You need LMS admin rights (or an admin's help) for this part. Trinket
supports **LTI Dynamic Registration** — most modern LMSes connect by being
given a single URL.

1. On trinket, sign in as an instructor and open **`/lti/connect`** — it
   issues your **registration link** (a URL containing a one-time token).
2. Paste that link into your LMS's dynamic-registration screen:
   * ⬜ **Moodle**: Site administration → Plugins → Activity modules →
     External tool → Manage tools → paste into "Tool URL…" → **Add LTI
     Advantage**. Activate the tool when it appears.
   * ⬜ **Brightspace/D2L**: Admin Tools → **Manage Extensibility** → LTI
     Advantage → **Register Tool** → choose **Dynamic** → paste the link.
     Then create a **Deployment** (Admin Tools → External Learning Tools) and
     add the org units that may use it.
   * ⬜ **Canvas**: hosted Canvas requires admin-enabled dynamic registration
     (Developer Keys → Inherited → LTI Registration) or manual setup — see
     the manual appendix below.
3. Launch once from a course to confirm; trinket recognizes the platform and
   signs you in with an instructor role.

### Manual setup (when dynamic registration isn't available)

Give your LMS admin these three URLs (replace `<host>` with your trinket
server, e.g. `https://rba-uindy.spvi.net`):

| Purpose | URL |
|---|---|
| OpenID Connect initiation | `<host>/lti/login` |
| Target link / redirect URI | `<host>/lti/launch` |
| Tool public keys (JWKS) | `<host>/lti/jwks` |

**Privacy level must send name + email** (Canvas: "Public") — trinket uses
them to create/link the student's account. Without email, accounts get a
placeholder identity. ✅ Canvas manual setup is fully documented for admins in
[LTI-REGISTRATION.md](LTI-REGISTRATION.md) (developer key + client ID +
deployment).

## Roles: who becomes an instructor?

Your LMS role carries over: launching as Teacher/TA/Designer makes you a
trinket course admin; students arrive as students. (Deployments may
additionally restrict who gets instructor authority — ask your trinket
operator if an instructor launch lands you as a student.)

## Troubleshooting

* **Launch fails with an OIDC/state error** — usually clock skew or a
  half-finished registration; retry once, then re-check the three URLs.
* **Student says "I see someone else's code"** — they don't; each student has
  their own copy. The *original* is what you picked in the picker.
* **A score didn't appear** — trinket doesn't post scores (see grading above);
  the "needs grading" marker + review link is the expected behavior.
* **Names/emails look like placeholders** — the LMS registration isn't
  sending name/email; ask your admin to raise the tool's privacy level.
