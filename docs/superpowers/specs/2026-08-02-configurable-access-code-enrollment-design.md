# Configurable, self-consistent course access-code enrollment — design

_2026-08-02. Restore the instructor "Share Access Code" UI (removed in `c6be18f`), gate the whole access-code enrollment feature behind one config flag, and enforce that gate on both the UI and the server so the two halves can never drift out of sync again._

## Problem / context

trinket-oss has a self-service course-enrollment path where an instructor mints an **access code** and students enter it (or click a join link) to enrol. On the picup/MIAuthors line this is currently **half-present and dead-ended**:

- **Student side is live:** the `<join-course>` "enter an access code" component still renders on the home + library pages (`lib/views/home.html`, `lib/views/courses/library.html`).
- **Instructor side was removed:** commit **`c6be18f` "Remove access code UI from course Users panel"** (Steve, 2026-05-22) deleted the 35-line "Share Access Code" `<fieldset>` from `public/partials/course_editor.html`. The backend (`generateAccessCode`/`getAccessCode` controllers) and the `usersControl.js` wiring were left intact — only the template UI went.

Net: students see a code box no instructor can produce a code for — exactly the dead-end upstream issue trinketapp/trinket-oss#27 describes, here self-inflicted. Upstream `trinketapp/main` still has both halves (the panel lives in a collapsible "Share Access Code" section).

Deployment reality also matters: mandi/uindy enrol via **LTI (Canvas roster)** or **uploaded student lists** and don't want open self-enrol; picup (public) is the one place code-based self-enrol is genuinely useful (no LMS, no SMTP). So the fix is not "restore it" or "delete it" but **"make it a clean, deployment-configurable, self-consistent feature."**

## The feature flag

- **`features.accessCodeEnrollment`** — boolean, added to `config/default.yaml` under the existing `features:` block. **Stock default: `false`** (opt-in).
- One flag governs **both** halves (instructor mint-code UI + student enter-code UI + the server endpoints). They are never independently toggleable — that coupling is the whole point.
- **Per-deploy:** mandi/uindy inherit the `false` default (no change needed). **picup opts in** by setting `features.accessCodeEnrollment: true` in its own config on the VPS (`config/local.yaml` or the compose `NODE_CONFIG` env) — picup runs repo defaults, not a `deploys/` overlay, so this is a one-line picup-side config touch.

## Exposing the flag to the Angular client

The enrollment UI is client-side Angular, so the flag must reach the browser. Mirror the **existing `assetsEnabled` pattern** (`lib/views/base.html:84`):

```
assetsEnabled        : {{ 'true' if config.features.assets else 'false' }},
accessCodeEnrollment : {{ 'true' if config.features.accessCodeEnrollment else 'false' }}
```

Client reads it via `trinketConfig.get('accessCodeEnrollment')`, exposed on the relevant `$scope`s so templates can `ng-if` on it.

## Client UI gating (both halves)

1. **Instructor — restore + gate.** Re-add the "Share Access Code" `<fieldset>` to `public/partials/course_editor.html` (recover the 35 lines from `c6be18f`, adapted to the current surrounding markup, which drifted via `0a2c7b5`/etc.), wrapped so it only renders when the flag is on (`ng-if="accessCodeEnrollment"`). The `$scope.generateAccessCode()` / `accessCode` / `accessCodeUrl` / `formToggles.accessCode` wiring in `usersControl.js` is still present and is reused unchanged.
2. **Student — gate.** Wrap the `<join-course>` component render in `lib/views/home.html` and `lib/views/courses/library.html` in `ng-if="accessCodeEnrollment"` so the enter-a-code box disappears when off.

## Server enforcement (true "off")

Hiding UI is not disabling. When the flag is `false`, the server rejects the four access-code endpoints so a direct request, a stale code, or a shared link cannot enrol anyone. A small shared guard (a route `pre` or an early check reading `config.features.accessCodeEnrollment`) applied to:

| Endpoint | Handler | When flag off |
|---|---|---|
| `GET /api/courses/{courseId}/accessCode` | `course.getAccessCode` | **404** |
| `POST /api/courses/{courseId}/accessCode` | `course.generateAccessCode` | **404** |
| `POST /api/courses/join` | `course.join` | **404** |
| `GET /courses/join/{accessCode}` | `classes.joinFromLink` | friendly flash ("Course join-by-code is not enabled") + **redirect home**, not a raw 404 (it's a browser navigation) |

The three JSON API routes return 404 (the feature doesn't exist when off); the browser link route redirects with a flash so a student clicking a stale link gets a sensible page.

## Testing

- **Server (the real guarantee) — integration, both backends** (`make test-mongo` + `make test-firestore`): with the flag **off**, each of the four endpoints rejects (404 / redirect); with the flag **on**, `generateAccessCode` returns a code, `GET accessCode` returns it, and `POST /courses/join` + `joinFromLink` enrol the user as `course-student`. Toggle the flag per-test via config override.
- **Client UI gating — lighter browser check:** with the flag on, the instructor "Share Access Code" panel and the student join box are present; with it off, both are absent.
- **Manual click-through before the PR (the "local server" gate):** a `make mongo` stack (`:3000`) — create a course as instructor, flag **on**: expand Share Access Code → Generate → copy code → as a second user enter the code → confirm enrolment; flag **off**: confirm both UIs gone and the endpoints 404.

## Branch / PR

- Branch **`feat/configurable-access-code-enrollment`** off **`picup/main`** (`3b6feb9`).
- **No convergence dependency** (this is reverting a picup-line commit + config/template/controller-guard work all present on `picup/main`), so it's a **clean, direct PR to picup** — unlike `console.input()`.
- The PR closes the new picup tracking issue.

## Out of scope (YAGNI)

- No per-course toggle — a single deployment-level flag is enough.
- No changes to the LTI or upload-student-list enrollment paths.
- No changes to the email-invitation path (separate feature, SMTP-gated).
- No rework of the access-code generation algorithm or the `<join-course>` component internals — only gating around them.
