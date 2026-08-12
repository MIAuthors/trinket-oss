# Per-trinket runtime setting — design

**Issue:** picup-physics/trinket-oss#128
**Follows:** #125 (worker runtime, merged 2026-08-12 as `79e0ab3`)
**Branch:** `feat/128-trinket-runtime-setting`, off `picup/main` @ `13e194c`

---

## 1. The problem

#125 gave an author two ways to choose a runtime, and both live on the **URL**:
`?runtime=worker|main`, offered through Share ▸ Link. That works, but the choice
is a property of the *program*, not of one link to it:

- a second embed of the same trinket silently loses it, and the failure mode is
  a frozen tab;
- a fork doesn't carry it;
- an LTI launch or a course copy builds its own URL and never has it.

"This program has an unbounded loop, so it needs the stoppable runtime" is true
of the trinket regardless of who opens it, how, or whether it is embedded at all.
That belongs on the trinket.

## 2. Decisions

Three questions were open in #128. All three are now settled.

### D1 — Precedence: the URL wins over the stored setting

| stored | URL | result |
|---|---|---|
| `worker` | `?runtime=main` | main |
| `main` | `?runtime=worker` | worker |
| `''` | `?runtime=worker` | worker |
| `worker` | *(none)* | worker |
| `''` | *(none)* | the deploy flag decides |

**Why.** The stored value is the author's *default*; the URL is a deliberate,
temporary act by whoever is holding it — "does this reproduce on the other
runtime?" That question is how the VPython fallback was diagnosed on
2026-08-12, and it must stay askable. It also gives the share dropdown a
coherent continuing role (§6) instead of retiring it.

**Accepted cost.** Someone else's URL can override an author's choice. Bounded
by D3: the guard still protects against a URL that selects a runtime which
cannot run the program at all.

### D2 — Forks inherit the setting

`Trinket.copy()` already carries the whole `settings` sub-document, so this is
the no-change option. It also resolves the standing
`@TODO: determine what settings should or should not be copied` in favour of the
status quo, for this field.

**Why.** A runtime choice is a property of the code, and a fork begins as a copy
of the code. If the original needed the stoppable runtime for its loop, so does
the fork.

### D3 — A stored value respects the unawaitable-call guard; a URL may override it

The router refuses the worker for programs calling `input()`, `sleep()` or
`rate()` inside a **lambda or comprehension**, where the async transform cannot
insert `await`.

- **Stored** `worker` does **not** override the guard. A saved setting affects
  every student who opens the trinket, and must not be able to permanently
  select a runtime that cannot run the program.
- **URL** `?runtime=worker` **does** override it, as it does today. The detector
  deliberately over-matches — `print(input(), [x for x in y])` is flagged though
  it would run fine — so authors need an escape from a false positive. The
  override is temporary, per-link, and a program that hangs in the worker is
  stoppable, unlike a main-thread freeze.

## 3. Router ordering

`chooseRuntime()` gains one input, `storedRuntime`, and the guard moves so that
it sits **between** the two explicit choices:

```
1. usesVPython              -> main      hard; no choice overrides it
2. queryRuntime (URL)       -> honoured  may override the guard  (D3)
3. hasUnawaitableCall       -> main      hard for everything below (D3),
                                         but ONLY when the worker was
                                         actually reachable — see below
4. storedRuntime            -> honoured  beats the deploy flag    (D1)
5. workerRuntime flag off   -> main
6. default                  -> worker
```

**Rule 3 is conditional.** The guard applies only when the worker was a real
possibility for this program:

```js
var workerPossible = (stored === 'worker') || !!opts.workerEnabled;
if (workerPossible && hasUnawaitableCall(source)) { ... }
```

Without that condition, putting the guard above rule 5 changes the *reason* for
a case that was previously reported by rule 5 — a guard-tripping program on a
deploy with the worker **off**, with no stored value and no query. The runtime
is `main` either way, but the reason flips from `config: worker runtime
disabled` to the guard's, and because `runtimeNotice()` speaks for the guard and
is silent for the flag, a student on a deploy that does not even enable the
worker would start seeing an explanation about a worker limitation. Every
deploy currently has the flag off, so this is the common case, not a corner.

With the condition, rule 6 of the table below still hits the guard — a stored
`worker` means the author asked for it and is owed the explanation — while the
no-stored, flag-off case stays with rule 5 and stays silent, exactly as before.

*(Found in review of Task 2; the original wording of this section claimed the
reordering was behaviour-preserving without qualification, which was true of
the chosen runtime but not of the reason or the notice.)*

Every branch returns a `reason` string, as today.

New reasons:

- `'trinket setting: runtime=worker'`
- `'trinket setting: runtime=main'`

**This reorders rule 3 relative to today**, where the guard sits *after* the
config-flag check. The move is behaviour-preserving for every case reachable
today: with no stored value, a program that trips the guard reached `main`
before (via the guard) and reaches `main` now, whether the flag is on or off.

### Worked cases

| program | stored | flag | URL | result | why |
|---|---|---|---|---|---|
| ordinary | `''` | off | — | main | flag off |
| ordinary | `worker` | off | — | **worker** | stored opts one trinket in |
| ordinary | `''` | on | — | worker | default |
| ordinary | `main` | on | — | **main** | stored opts one trinket out |
| ordinary | `worker` | on | `?runtime=main` | main | URL wins (D1) |
| `input()` in a lambda | `worker` | off | — | **main** | guard beats stored (D3) |
| `input()` in a lambda | `''` | on | `?runtime=worker` | worker | URL may override (D3) |
| Web VPython | `worker` | on | `?runtime=worker` | **main** | VPython is absolute |

## 4. Data model

```js
settings : {
  autofocusEnabled : { type: Boolean, default: true },
  testsEnabled     : { type: Boolean, default: false },
  runtime          : { type: String, enum: ['', 'worker', 'main'], default: '' }
}
```

on **both** `lib/models/trinket.js` and `lib/models/draft.js`. Draft is not
optional: the settings modal reads draft state in preference to trinket state
(`draft.settings.testsEnabled or trinket.settings.testsEnabled`), so omitting it
would make the control appear not to save while a draft is in play.

`''` means "no decision — follow the deploy". Chosen over `null` or an absent
key so that:

- every existing trinket acquires the field with no migration;
- a deploy that later flips `workerRuntime` still moves all its undecided
  trinkets, which is the point of having a deploy-level flag;
- "the author made no choice" stays distinguishable from "the author chose
  main", which the UI needs in order to render honestly.

`copy()` needs no change (D2).

## 5. Validation — required, not optional

`request.payload.settings` is assigned **wholesale** at two sites in
`lib/controllers/trinket.js`:

```js
if (request.payload.settings) { update.settings = request.payload.settings; }   // draft path
if (request.payload.settings) { trinket.set('settings', request.payload.settings); }
```

The draft path is `Draft.findOneAndUpdate(query, update)`, and **mongoose does
not run validators on `findOneAndUpdate`** unless `runValidators: true` is
passed. A schema `enum` therefore does **not** constrain what reaches draft
storage. The trinket path goes through `.set()` + `.save()` and is validated.

Two defences, both required:

1. **Server, on write.** Whitelist the incoming value in the controller before
   assigning, exactly as `validRuntime()` already does for the query parameter
   (`lib/controllers/trinket.js`). Anything not in `['', 'worker', 'main']`
   becomes `''`.
2. **Client, on read.** The embed whitelists the stored value before handing it
   to the router, so a value that predates or bypasses (1) degrades to "no
   stored preference" rather than reaching the routing rules.

The router itself matches `'worker'`/`'main'` exactly and ignores anything else,
which is a third layer — but it must not be the only one, because the value is
also rendered back into the settings modal as a selected `<option>`.

## 6. UI

### 6a. The settings modal — where the choice is made

`lib/views/includes/embed-settings.html` already renders a **Trinket Settings**
modal containing *Enable Tests* and *Enable Editor Autofocus*. The runtime
choice is one more row there:

```
Trinket Settings
  [x] Enable Tests                 (existing; gated canEnableTests && canUseTests)
  [x] Enable Editor Autofocus      (existing)
      Runtime  [ Site default ▾ ]  (new; gated on config.app.runtimeOption)
```

Options, matching the share dialog's wording so the two read as the same choice:

| value | label |
|---|---|
| `''` | Site default |
| `worker` | Stoppable — recommended for programs with loops |
| `main` | Original — for a program the stoppable runtime can't run |

**Gating.** Rendered only when the trinket's `lang` is in
`config.app.runtimeOption` (`[python3, pyodide]`), the same list the share
dialog uses. A control that cannot affect the trinket in front of you must not
appear — the precedent is `testsEnabled`, already gated by
`canEnableTests and canUseTests`.

**Why here and not the library detail page.** This is where the other
per-trinket settings live, it is reachable from the embed the author is already
looking at, and the save path (`data-trinket-settings` → `payload.settings`)
already exists. No new surface, no new endpoint.

### 6b. The share dialog — copy changes

The dropdown shipped in #125 says:

```
Use this site's default runtime
```

Once a stored setting exists this is wrong: the link now overrides a *trinket*
setting, not merely the site default. It becomes an override control:

```
Use this trinket's setting        (value '')
Stoppable — override for this link
Original — override for this link
```

The mechanism does not change; only the labels. This was anticipated when the
dropdown shipped — see the #128 comment of 2026-08-12.

### 6c. The runtime notice

`runtimeNotice()` (added in #125) explains *why* a program is where it is. It
must learn the new reasons, or a program on the main thread because of a saved
setting will print an explanation that names the flag instead:

- stored → worker: `Running off the main thread — Stop always works (this trinket's setting).`
- stored → main: `Running on the main thread (this trinket's setting).`

The existing "deliberately quiet" rule is unchanged: nothing is printed for an
ordinary main-thread run with no stored value.

## 7. Both database backends

`settings` is a nested sub-document. The Firestore backend handles nested
default paths generically (`firestore-backend.js`, "Nested path … build nested
default object"), so no special-casing is *expected* — but a new nested field
inside an existing sub-document round-tripping through Firestore is precisely
the kind of thing that has silently failed before (see the counters/
`expandDottedKeys` history). It gets an explicit test on both backends rather
than an assumption.

## 8. Testing

**Unit — router** (`test/unit/runtime-router.test.js`, pure, no browser):
every row of the §3 worked-cases table, plus the guard/stored interaction from
D3 in both directions, plus `reason` strings.

**Unit — notice**: the two new reasons render, and the quiet case stays quiet.

**Unit — validation**: a payload of `settings.runtime = 'nonsense'` stores `''`,
on the draft path as well as the trinket path.

**API/model**: the field persists, survives a round trip, and is carried by
`copy()` — asserted on **both** backends (§7).

**Browser** (`test/browser/specs/`): the modal row appears for python3 and not
for glowscript; setting it routes the next run accordingly with no query
parameter present; a URL parameter still beats it; the setting survives a fork.

## 9. Out of scope

- Changing which trinket types support the worker (`runtimeOption` is unchanged).
- A per-language deploy default (`workerRuntime` stays a single boolean).
  Open question 4 of #128; it composes cleanly later — a per-language default
  would slot in at rule 5, below the stored setting.
- Exposing the setting anywhere outside the embed's settings modal.
- Any change to `autofocusEnabled` / `testsEnabled` semantics.

## 10. Risks

| risk | mitigation |
|---|---|
| Unvalidated `settings` payload reaches draft storage | §5, two independent defences |
| Reordering rule 3 changes today's behaviour | §3 argues it is behaviour-preserving with no stored value; the router's existing tests must all still pass unchanged |
| New nested field fails to round-trip on Firestore | §7, explicit test on both backends |
| Share dialog and settings modal drift apart in wording | §6a/§6b use one shared vocabulary; both templates are edited in the same task |
| The Angular `share.html` mirror is forgotten again | it renders nowhere, but is kept in step deliberately — as in #125 |
