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

This describes an **LTI 1.3** connection. If your platform only supports
**LTI 1.1** (see below), there is no gradebook integration at all — not even
the "needs grading" marker — and you review students' work in trinket.

## Everyday use (tool already connected)

### Adding an assignment

1. In your LMS course, create an assignment/activity whose submission type is
   the external tool (✅ Canvas: Assignment → Submission Type → **External
   Tool** → **Find** → pick the tool **by its registered name** — it is the
   tool title your admin registered, not necessarily "trinket";
   ⬜ Moodle: Activity → External tool; ⬜ Brightspace: Existing Activities →
   external learning tool).
2. Trinket's **picker** opens *inside the dialog* — after a blank pause of
   ~10 seconds (the LMS↔trinket sign-in handshake; blank means loading, not
   broken). Choose the course assignment students should start from.
3. **Canvas: check "Load This Tool In A New Tab."** Modern browsers block
   third-party cookies by default, so an *embedded* assignment shows students
   an anonymous (Sign Up / Log In) view instead of their own work. The
   new-tab launch works everywhere. Then Save & Publish.
4. ⚠️ A tool link added to a **Module** is an ungraded content launch — fine
   for course material, but it creates **no gradebook column and no
   needs-grading flow**. Graded work must be an *Assignment*.

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
   * ✅ **Canvas** (verified 2026-08-24, self-hosted): Admin → Developer Keys
     → **+ Developer Key → LTI Registration** → paste the link → confirm →
     flip the key **ON** → install the app (Admin → Settings → Apps → + App →
     **By Client ID**). Hosted Canvas may require Instructure to have enabled
     dynamic registration; the manual appendix below always works.
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

### Legacy LTI 1.1 (when your platform won't let you install a 1.3 tool)

Some platforms reserve LTI 1.3 for the vendor or central IT — a course admin
simply cannot create the Developer Key it needs. **WileyPLUS-hosted Canvas** is
the case we have verified: course admins can self-install key/secret (1.1)
tools, but not 1.3 ones. Trinket supports 1.1 for exactly this situation.

**What you give up.** No gradebook integration at all — not even the "needs
grading" marker that 1.3 posts. Review students' work in trinket's course page
instead. (Neither version posts a score; see the grading note at the top.)

**What still works.** Sign-in, automatic enrolment into the trinket course, and
your LMS role carrying over (teacher → course admin, student → student).

1. On trinket, **sign in as the instructor who owns the course** — the course
   dropdown lists only your own courses. Open **`/lti/connect`** →
   **Generate key & secret** → choose the course. You get three values: a
   **consumer key**, a **shared secret**, and a **config URL**.
   ⚠️ **The secret is shown once and cannot be retrieved.** Copy it now. If you
   lose it, mint a new pair — the old one keeps working until an operator
   disables it.
2. ✅ **Canvas** (verified 2026-08-26, both self-hosted and WileyPLUS-hosted):
   Course (or Admin) → **Settings → Apps → + App** → Configuration Type
   **By URL** → paste the name, consumer key, shared secret, and config URL.
3. If Canvas says *"This tool has already been installed in this context"*,
   that is expected when you also have a 1.3 trinket tool — the check is per
   **domain**, and both live on the same host. Choose **Yes, Install Tool**.
4. Add a module item or an assignment pointing at the tool, and tick **Load
   This Tool In A New Tab** (browsers block third-party cookies by default).
5. Launch once to confirm. You land on your trinket course page; students land
   there too and are enrolled automatically.

**A 1.1 placement targets a course, not a single assignment.** There is no
deep-link picker in 1.1, so students arrive at the course page and open the
assignment from there — unlike 1.3, where each placement points at one specific
trinket.

The 1.1 tool launches at **`<host>/lti11/launch`**, deliberately distinct from
1.3's `<host>/lti/launch`, so a 1.3 and a 1.1 trinket tool can coexist in the
same course without the LMS confusing them.

## Roles: who becomes an instructor?

Your LMS role carries over: launching as Teacher/TA/Designer makes you a
trinket course admin; students arrive as students. (Deployments may
additionally restrict who gets instructor authority — ask your trinket
operator if an instructor launch lands you as a student.)

## Troubleshooting

* **Students see Sign Up / Log In inside an embedded assignment** — the
  browser is blocking third-party cookies (default in current Chrome and
  Safari). Edit the assignment and enable **Load This Tool In A New Tab**.
* **The external-tool picker dialog is empty** — before suspecting the
  registration, try another browser (a content blocker or browser bug can
  stop the dialog's tool list from loading; the registration is usually fine).
* **Clicked the tool and got a blank white dialog** — it is loading; the
  picker takes ~10 seconds to appear. Don't close it.
* **No grade column appeared for a module link** — module links are ungraded
  by design; create an Assignment with External Tool submission instead.
* **Two identical tool names in the picker** — duplicate registrations (e.g.
  an old server's). Ask your admin to remove or rename the stale one; picking
  it launches into the wrong server.
* **Launch fails with an OIDC/state error** — usually clock skew or a
  half-finished registration; retry once, then re-check the three URLs.
* **Student says "I see someone else's code"** — they don't; each student has
  their own copy. The *original* is what you picked in the picker.
* **A score didn't appear** — trinket doesn't post scores (see grading above);
  the "needs grading" marker + review link is the expected behavior.
* **Names/emails look like placeholders** — the LMS registration isn't
  sending name/email; ask your admin to raise the tool's privacy level.
* **(1.1) A launch lands on trinket's home page instead of your course** — the
  LMS bound that placement to a *different* trinket tool. Canvas matches
  placements by URL/domain, and a 1.1 tool installed before 2026-08-26 shared
  its launch URL with the 1.3 tool. Re-install from the config URL (it now
  advertises `/lti11/launch`) and **create a new module item** — editing the
  existing one does not re-bind it.
* **(1.1) The course dropdown at `/lti/connect` is empty or lists the wrong
  courses** — you are signed in as a different trinket account from the one
  that owns the course. Sign in as the owner and mint the key again.
* **(1.1) No "needs grading" marker appears** — correct: 1.1 connections have
  no gradebook integration at all. Review the work in trinket.
