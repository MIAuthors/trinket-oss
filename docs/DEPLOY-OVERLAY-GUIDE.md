# Running your own deployment with a private config repo (`deploys/`)

Everything specific to one deployment — branding, theme, site config, secrets,
custom pages — can live in **your own private repo**, cloned into this public
checkout, with **no fork and no local patches**. You update trinket-oss by
pulling; your config stays untouched in its own repo.

This is a getting-started walkthrough; `DEPLOYING.md` → "Per-deploy customization
(`deploys/`)" is the full reference.

---

## The idea in one picture

```
<your trinket-oss checkout>
├── lib/  app.js  config/default.yaml …   <- stock code + defaults (never edit)
├── docker-compose.yml                     <- passes TRINKET_DEPLOY to the app
└── deploys/                               <- GITIGNORED; nothing here is in the public repo
    └── <name>/                            <- YOUR private config repo, cloned here
        ├── .env                           <- deploy-tooling + secrets (project, service,
        │                                     hostname, session password, LTI/OAuth keys)
        ├── config/
        │   ├── local.yaml                 <- env-independent identity (branding, features,
        │   │                                 announcement) — loads in EVERY env, incl. preview
        │   ├── local-production.yaml      <- prod-only infra (buckets, project, knownHosts)
        │   └── local-development.yaml     <- dev-only overrides (optional)
        ├── views/                         <- nunjucks templates that shadow lib/views/ (optional)
        └── public/                        <- static assets that shadow public/ (optional)
```

Turn it on by naming the folder in `TRINKET_DEPLOY`:

```bash
TRINKET_DEPLOY=<name> docker compose up --build      # docker compose
TRINKET_DEPLOY=<name> node app.js                    # bare node
TRINKET_DEPLOY=<name> bash deploy-cloudrun.sh         # Cloud Run
```

Without `TRINKET_DEPLOY` the app runs completely stock — the overlay is inert.
`config/deploy-dir.js` is the loader: it deep-merges your `config/*.yaml` over the
stock config (your values win) and shadows any view/asset by matching relative path.

---

## One-time setup

1. **Create a private repo** for your config (e.g. `<org>/trinket-deploy`), with
   whatever of these parts you need — all optional:
   ```
   .env                          (deploy-tooling + secrets)
   config/local.yaml             (identity: branding, features, announcement)
   config/local-production.yaml  (prod-only infra: buckets, project, hosts)
   views/…                       (only if overriding pages)
   public/…                      (only if overriding assets, e.g. a logo)
   ```
2. **Clone it into the checkout** as `deploys/<name>/` (the name is what you pass to
   `TRINKET_DEPLOY`):
   ```bash
   git clone git@github.com:<org>/trinket-deploy.git deploys/<name>
   ```
   `deploys/` is gitignored here, so this nested repo never interferes with pulling
   trinket-oss updates.
3. **Activate it** — pass `TRINKET_DEPLOY=<name>` on the command line, or set it as
   a convenience default in the root `.env` (an explicit command-line value wins).

---

## What goes where

| Location | What to put there | Notes |
|---|---|---|
| `deploys/<name>/.env` | Deploy-tooling + secrets: GCP project, service name, public host, session password, Firebase config, LTI/OAuth keys | Sourced **after** the root `.env`. **Excluded from the image** (`.dockerignore` drops `**/.env`); read by `deploy-cloudrun.sh` at deploy time and injected via Secret Manager. |
| `deploys/<name>/config/local.yaml` | **Env-independent identity: site name, branding, theme, announcement, which trinket types are enabled, LTI tool name.** | Deep-merged over `default.yaml`; **wins over everything.** Loaded in **every** env when the overlay is active — including `make gcp` preview and bare `node`. |
| `deploys/<name>/config/local-production.yaml` | **Prod-only infra:** bucket names/hosts, GCP project, `url.knownHosts`, prod DB backend. | Loaded only when `NODE_ENV=production`. |
| `deploys/<name>/config/local-development.yaml` | Dev-only overrides (e.g. pointing bare `node` at the compose backends) | Loaded only when `NODE_ENV=development`. |
| `deploys/<name>/views/…` | Nunjucks templates that replace stock pages by relative path | e.g. `views/static/about.html` replaces `lib/views/static/about.html`. |
| `deploys/<name>/public/…` | Static assets that replace stock ones | e.g. `public/img/brand/logo.png`. |

> **Which file? Split by *env-dependence*, not by convenience.** Anything that's the
> same in dev, preview, and prod — branding, theme, announcement, enabled trinket
> types — belongs in the overlay's **`local.yaml`** so it renders **everywhere**,
> including `make gcp` preview (which runs `NODE_ENV=development` and therefore
> loads `local.yaml`/`local-development.yaml` but **not** `local-production.yaml`).
> Put only values that genuinely differ between prod and dev (buckets, project,
> hosts) in `local-production.yaml`.
>
> ⚠️ The "`local.yaml` poisons tests" caveat applies to the **root** `config/local.yaml`,
> *not* an overlay's `local.yaml`: tests never set `TRINKET_DEPLOY`, so the overlay
> (and its `local.yaml`) is inert during test runs.
>
> ⚠️ **A self-host (docker compose) production deploy must set `NODE_ENV=production`
> in its `.env`.** `docker-compose.yml` defaults it to `development` so a plain
> `docker compose up` stays a dev stack — but that means `local-production.yaml`
> **never loads** on a compose deploy that doesn't set it, view caching stays off,
> and `enable: false` route gating is inert. `deploy-cloudrun.sh` sets it for you;
> compose does not. Check a running deploy with `GET /version` (`nodeEnv`).

---

## Example — identity in `config/local.yaml` (renders everywhere, incl. `make gcp`)

```yaml
app:
  siteName: 'Example Trinket'
  logo: '/img/brand/logo.png'          # your file in deploys/<name>/public/img/brand/
  logoIcon: '/img/brand/icon.png'      # ⚠️ SET THIS TOO — see below
  announcement: '⚠️ Test server — data may be wiped.'   # shows in preview too
  branding:
    lead: 'A browser-based coding platform for computational physics.'
    subtitle: 'Write and run Python and Web VPython in interactive courses.'
  theme:
    heading: '#123456'                  # your brand colors
    primary: '#123456'                  # ⚠️ does NOT cover links/buttons — see below
    link:    '#123456'
    button:  '#123456'

# Which trinket types appear in the New-Trinket menu AND are allowed to run.
# Omit this block to inherit the stock set; override only what you want to change:
features:
  trinkets:
    html: true        # e.g. also enable HTML trinkets
    # pyodide: true   # …or re-enable a separate Pyodide button
```

### ⚠️ Theme colors: `primary` alone no longer covers links and buttons

`app.theme` has **five** color keys, and they split into two groups by whether the
color carries text:

| key | applies to | carries text? | contrast requirement |
|---|---|---|---|
| `pageBg` | page (body) background | — | it's the backdrop everything else is measured against |
| `heading` | `h1`/`h2`/`h3` | yes | 4.5:1 vs `pageBg` (3:1 if ≥24px) |
| `navItem` | nav dropdown item background | — | — |
| `primary` | **display fills**: hero banner, course sidebar current item, nav active fills | no | none — no small text sits on it |
| `link` | anchor color + text accents (breadcrumbs, status text, toolbar titles) | yes | **4.5:1 vs `pageBg`** |
| `button` | interactive chrome: filled buttons, outline-button text/border, labels, pagination | yes (white label) | **4.5:1 vs white** |

Five more **optional shade keys** (#149) cover the hover/disabled shades and the
second accent color that Sass used to compute at build time. When unset, every
use falls back to the exact stock shade — set them alongside the keys above so
hovers match your palette instead of staying green:

| key | applies to | stock fallback |
|---|---|---|
| `buttonDark` | hover text/border of outline buttons, alert-box border | `darken(green, 10%)` |
| `buttonPale` | pale hover/disabled fill of outline buttons | `lighten(green, 40%)` |
| `secondary` | second accent: completed-status text, secondary buttons | dark green `#006400` |
| `secondaryDark` | hover shade of `secondary` | `darken(#006400, 10%)` |
| `secondaryPale` | pale fill of `secondary` | `lighten(#006400, 40%)` |

`link` and `button` were split out of `primary` because Foundation derived *both*
the anchor color and filled-button backgrounds from `$primary-color`. That made one
value serve a large decorative fill and small body text at the same time — and the
stock display green measured **2.04:1** as a link and **2.26:1** under white button
text, well under the 4.5:1 WCAG AA wants.

**The trap:** an overlay that sets only `primary` does **not** get its brand color on
links and buttons. `config/default.yaml` ships concrete `link`/`button` values, and
overlays are **deep-merged** (`config/deploy-dir.js`) — the `theme` block is merged
key by key, not replaced wholesale. So omitting them doesn't fall back to your
`primary`; it inherits the **stock ink green `#2E7D32`**, and your site serves
green links next to, say, an indigo hero.

If you want one brand color everywhere, set all three explicitly:

```yaml
app:
  theme:
    primary: '#35429B'   # hero / large fills
    link:    '#35429B'   # same value — but see the contrast note
    button:  '#35429B'
```

Before reusing one value for all three, **measure it**. `primary` has no contrast
floor, so a brand color chosen for a hero banner can easily fail as body text. The
keys are deliberately separate so a deploy with a light brand color can keep it on
the hero and pick a darker companion for text — which is exactly what the stock
theme does (`primary: #75BF48` for fills, `#2E7D32` for text).

Check a candidate against your `pageBg` (and against white for `button`) with any
contrast checker; you want **≥ 4.5:1**. Values that already pass on white include
`#35429B` (8.7:1) and `#ba0c2f` (6.6:1).

## Optional: run Python off the main thread (`features.workerRuntime`)

Default **`false`**. When enabled, python3 programs run in a Web Worker, so the
page cannot freeze and **Stop always works** — including for `while True: pass`,
which nothing on the main thread can interrupt, because a loop with no pause
point never lets the page run to notice the click.

```yaml
features:
  workerRuntime: true
```

**Programs that stay on the main thread regardless of this flag:**

- **Web VPython / GlowScript.** Its bridge binds `from js import sphere, box,
  rate, …` to the browser window, which does not exist in a worker. Unchanged,
  deliberately: Stop already works there via `rate()`. (A separate, experimental
  flag — `features.workerVPython`, below — routes VPython through a *different*
  worker path built on the `vpython` package; `workerRuntime` alone never does.)
- Programs calling `input()`, `sleep()` or `rate()` inside a **lambda or a
  comprehension**, where `await` cannot be inserted. They keep working exactly as
  they do today; they just do not gain the freeze protection.

**Per-link override:** `?runtime=worker` forces the worker even when the flag is
off; `?runtime=main` forces the main thread even when it is on. The query
parameter wins over the flag either way, and it works on **both** the embed URL
and the trinket page URL — the page carries it through to the iframe it builds.
Any other value is ignored rather than reflected back.

**Is `workerRuntime: false` a default or a policy? A default.** A trinket whose
author stored *Stoppable* runs in the worker even on a deploy with the flag
off — deliberately: that per-trinket opt-in is the setting's founding use case,
and it mirrors `?runtime=worker`, which has always beaten the flag. So the flag
sets what *undecided* trinkets do; it is not a site-wide ban. If a deploy needs
the worker hard-off — say, while debugging an infrastructure problem — that
switch does not exist today and would be a separate feature request, not a
config value.

**Per-trinket setting:** an author can store a runtime on the trinket itself —
**Trinket Settings ▸ Runtime** — and it travels with the trinket: forks inherit
it, and every embed of it uses it, with no query parameter involved.

Precedence, highest first: a `?runtime=` on the URL, then the trinket's own
setting, then this flag. Two rules override all of them, because they are
capability limits rather than preferences: Web VPython always runs on the main
thread, and so does a program calling `input()`, `sleep()` or `rate()` inside a
lambda or comprehension. A `?runtime=worker` may override that second one — the
check deliberately over-matches — but a stored setting may not, so a saved
choice can never permanently break a trinket for everyone who opens it.

**Telling which runtime a program got:** the console says so when the answer
isn't the obvious one — when a program runs in the worker, when a request like
`?runtime=worker` could *not* be honoured (Web VPython, or `input()`/`sleep()`/
`rate()` inside a lambda or comprehension), and otherwise stays silent. An
ordinary main-thread run on a deploy with the flag off prints nothing new.

Authors don't have to hand-edit URLs for this: **Share ▸ Link** offers the
choice on python3 and pyodide trinkets, in both directions. With the flag
**off**, "Stoppable" opts a single program that needs a stoppable `while True:`
into the worker. With the flag **on** — where the worker is the default —
"Original" sends one program back to the main thread, which is what a program
the async transform cannot rewrite needs.

The choice rides on the **link**, not the trinket: it's a one-off override for
that URL only, gone as soon as a fresh embed, a fork, or an LTI launch builds
its own URL. To make a choice stick for every future viewer, use **Trinket
Settings ▸ Runtime** instead — see "Per-trinket setting" above.

**What changes for a student when this is on**

| | |
|---|---|
| `while True: pass` | page stays responsive; Stop halts it |
| matplotlib | interactive, with the usual toolbar (home / pan / zoom / save) |
| `input()` | works; the prompt is answered through the console |
| the interactive console (REPL) | a runaway statement is stoppable |

**Two consequences worth knowing before you enable it:**

1. **Stop discards the interpreter.** That is what makes it unconditional. So
   after a stop there is no variable snapshot to show, and a stopped REPL loses
   its session — both are said plainly in the console rather than left to be
   guessed at.
2. **Cold start after a stop.** The next run boots a fresh worker, so it is
   slower than a run that follows a normal finish.

## Optional: run Web VPython off the main thread (`features.workerVPython`)

> ⚠️ **Experimental — for a trial, not a production deploy.** The path is joined
> up end to end and browser-tested: static scenes, `rate()` animations, Stop,
> `scene.bind('click', …)` mouse handlers, camera interaction, `gcurve`/`gdots`
> graphs and re-runs all work. (Key events — `bind('keydown', …)` — are wired on
> the same path as mouse events but have **no test behind them**; treat them as
> plausible, not verified.) What still gates it is validation, not plumbing —
> a representative set of M&I programs (to be picked with Todd) has to render and
> **animate correctly** first. That criterion used to read "identically to the
> main-thread path"; it was amended once the main-thread path turned out to be
> the one that paces wrongly (caveat 5), so a program that runs *nearer* its
> requested `rate()` here than it does on the main thread has passed, not
> failed. Six things to know before you turn it on — caveats 4 and 5 in
> particular bear on how to judge a program:
>
> 1. **Every Run boots a fresh interpreter, so the Python namespace does NOT
>    carry over between Runs — and this is a real, deliberate behaviour change
>    from the main-thread path.** Read this one before you enable the flag.
>
>    trinket's *product model* has no persistent-namespace concept: pressing Run
>    means "run this program from the top". That is the whole difference from
>    Jupyter, Colab and VS Code, which keep one kernel alive across cell
>    executions, and it is why the fresh interpreter is the right semantics here
>    (design decision V7a).
>
>    But the main-thread *implementation* does not enforce that model. Every
>    main-thread run executes in the same page-level `pyodide.globals`, so a name
>    left behind by an earlier Run is still visible to the next one — an artifact
>    of how that path was built, not a promise it makes, but observable all the
>    same. `workerRuntime` python3 runs preserve it deliberately (decision V7).
>
>    So the concrete difference a deployer must know: **a program that only works
>    because a previous Run left a variable behind works on the main thread and
>    raises `NameError` under `workerVPython`.** That is the intended behaviour —
>    the worker path matches the product model and the main-thread path does not —
>    but it is a change, and a student who has been leaning on it will notice.
>
>    One knock-on, *only if `workerRuntime` is also on*: the interactive console
>    then shares that same worker interpreter, so a VPython Run resets the console
>    session too, and says so on the console rather than leaving it to be
>    discovered. With `workerVPython` alone, the console runs on the page and a
>    VPython Run does not touch it — the REPL follows `workerRuntime`, not this
>    flag.
>
> 2. **Each Run therefore pays a cold boot — about 4 seconds** from click to
>    rendered scene on the dev stack (measured: 4.1 s on the first run, 3.9 s on
>    the second), being a fresh Pyodide plus the VPython wheel install. Pyodide's
>    own artifacts do come from the browser cache; **trinket's own 3.5 MB VPython
>    wheel does not** — `app.js` sends `no-store` on every response it serves, so
>    the wheel is refetched in full on every Run. That is cheap on localhost and
>    not cheap over the internet; it is the first follow-up below.
>
> 3. **A python3 worker session is thrown away by a VPython Run** — *only if
>    `workerRuntime` is also on.* Every VPython Run discards the shared worker
>    interpreter (caveat 1), and that interpreter is the same one plain python3
>    runs have been accumulating names in. So a python3 Run, then a VPython Run,
>    then a python3 Run means the third one starts empty — a divergence from the
>    "python3 runs keep accumulating" behaviour `workerRuntime` gives on its own.
>    Same mechanism as the console-session reset above; the console at least says
>    so on screen, and this does not.
>
> 4. **`compound()`, `text()`, `extrusion()`, `obj.clone()` and
>    `scene.mouse.pick` are deferred and raise.** They are not exotic in the M&I
>    corpus, so read this before choosing a validation set. Each of them waits,
>    inside the library, for a reply from the browser — and in a worker that
>    reply can only be delivered by the very thread doing the waiting, so waiting
>    can never end. They now raise `NotImplementedError` naming the construct,
>    for the same reason `pause()` does: a deadlocked program shows a student no
>    output, no error and a Stop button that works, which is the hardest possible
>    thing to report. `?runtime=main` runs the program on the untouched
>    main-thread bridge, where all five work.
>
> 5. **A `rate(N)` loop paces at N iterations/second — which the main-thread
>    path does not do.** The worker's `rate()` subtracts the time the loop body
>    already took from the sleep (a fixed timestep, as upstream
>    vpython-jupyter's `RateKeeper` does with its measured `userTime`), so work
>    inside the period is absorbed rather than added on top of it. The
>    main-thread bridge calls GlowScript's own `rate()` from
>    `glow.3.2.3.min.js`, which for `N <= 120` sleeps a flat `1000/N` ms and does
>    **not** compensate. The two paths therefore still differ once the loop body
>    is heavy — but the worker is now the *faster* of the two, and the one
>    matching desktop VPython. Measured on the dev stack, 180 iterations of
>    `rate(60)` with a busy-wait body:
>
>    | loop body | main thread | worker |
>    |---|---|---|
>    | (empty) | 52.0 Hz | 51.3–53.2 Hz |
>    | 8 ms | 38.0 Hz | 54.2–54.6 Hz |
>    | 20 ms | 25.8 Hz | 49.5–49.7 Hz |
>
>    A 20 ms body cannot exceed 50 Hz whatever `rate()` does, so that row is at
>    its ceiling. Both paths land a few Hz short of the requested 60 even with an
>    empty body — browser timer granularity plus the per-iteration scene update,
>    present on both paths before and after this change. Closing that last few Hz
>    is possible (anchor the next deadline at `max(last + period, now - period)`,
>    which bounds catch-up to a single period) but deliberately not done: the
>    residual is small, and paying for it with any amount of catch-up buys a
>    burst of zero-sleep iterations after every hiccup. Read ~53 Hz on an empty
>    `rate(60)` as normal, not as a broken fix.
>
>    **Ruled on, so a tester does not have to re-litigate it:** the acceptance
>    criterion for this path was "renders and animates identically to the main
>    path"; it is now **"animates correctly"**. The worker matches upstream
>    desktop VPython, which is what a student's program was written against, and
>    GlowScript's flat `rate()` is **filed as [vpython/rsWVPRunner#4](https://github.com/vpython/rsWVPRunner/issues/4)** as its own bug against the
>    main-thread path rather than treated as something the worker should
>    imitate. The *physics* is
>    unaffected either way — M&I programs integrate with their own fixed `dt` —
>    so what a side-by-side shows is a heavy loop running nearer its requested
>    rate here than on the main thread. That is the expected result, not a
>    finding.
>
> 6. **`size=` on `gcurve`/`gdots` is ignored — a REGRESSION against the default
>    runtime.** `gdots(size=8)` gives 8-pixel dots on the main-thread bridge
>    (`wvpython/vpython/core_funcs.py` forwards constructor kwargs straight to
>    GlowScript) but the stock 6 under `workerVPython`. Cause: the packaged
>    `vpython` library's `gobj.setup` assigns `self._size` directly, while `size`
>    on `gobj` is a property derived from `_radius` — so the constructor argument
>    is written to a dead attribute and never reaches the wire. This is an
>    upstream vpython-jupyter bug, not trinket's. `radius=` is honoured on both
>    paths and is the workaround. Setting `.size` *after* construction goes
>    through the property setter and works on both paths too.
>
> 7. **No hidden star-imports — a python3 trinket gets nothing it did not
>    import.** ✅ **CLOSED 2026-08-10 — this is no longer a divergence.** Both
>    runtimes now obey the rule. It is written up here as a *behaviour change to
>    the default runtime*, which is what it is, rather than as a gap.
>
>    It used to be one. The main-thread path ran `from math import *`,
>    `from random import *` and `from vpython import *` before the student's code
>    whenever `usesVPython(source)` matched (in `ensureVpython()`), and seeded
>    bare `scene` / `rate` globals on top of that in `runVpython()`. The worker
>    path never did, deliberately.
>
>    The consequence was visible: a program that says `import vpython as vp` and
>    then uses a bare `color.red`, `sqrt(2)` or `random()` ran on the main thread
>    and raised `NameError` under `workerVPython`. **The worker was right.** That
>    program has a real bug — paste it into desktop VPython, a Jupyter notebook or
>    plain Python and it fails there too. The main-thread path was propping it up.
>    Both paths now raise the same `NameError` on the same line.
>
>    The rule this follows, by trinket type:
>
>    | trinket type | namespace |
>    |---|---|
>    | **Web VPython** (`glowscript`) | VPython names available by construction — the RapydScript compiler treats `from vpython import *` as the default (`GScompiler.js:503`) and delegates `random` to RapydScript-NG. Nothing to change; that is the environment those students expect. |
>    | **Python** (`python3` / `pyodide`) | **Explicit imports only.** A Python trinket is a Python trinket, whatever library it happens to use. |
>
>    **Who this can break, in practice: almost nobody** (Steve, 2026-08-11).
>    Using `vpython` inside a *Python* trinket is a capability added only weeks
>    ago and barely known; the few people using it are not generally writing
>    `from vpython import *` either. So the population at risk is small and
>    recent, which is why this shipped as a straight fix rather than behind a
>    deprecation. Web VPython trinkets — where the seeded namespace *is* the
>    expected environment — are untouched: that type never reaches `pyodide.js`.
>
>    The seeding in `ensureVpython()` was copied from wmWVPRunner, which *is* a
>    Web VPython runner, so it was right there and wrong here: it applied to a
>    plain Python trinket whose source merely mentions vpython, and it shadowed
>    builtins with `math`, `random` and `vpython` names the student never asked
>    for.
>
>    **What survived the removal, and why it had to.** `runVpython()` still runs,
>    before the student's code:
>
>    ```python
>    import vpython as _vpy
>    from js import scene as _js_scene
>    from js import rate as _wrapped_rate
>    _vpy.scene = _vpy.canvas(jsObj=_js_scene)   # the canvas rebuilt for THIS run
>    _vpy.rate  = _wrapped_rate                  # the cancellation-wrapped rate
>    ```
>
>    Those are **module attributes, not globals**, so they seed nothing. They
>    still reach a student who writes `from vpython import *` herself, because
>    `import vpython as _vpy` binds the module object in `sys.modules` — the same
>    object her star-import reads from, at the moment it runs, which is after
>    these assignments — and both names are in vpython's `__all__`. Verified by
>    poisoning it: setting `_vpy.rate = None` makes her `rate(30)` raise
>    `TypeError: 'NoneType' object is not callable`, so that assignment is
>    demonstrably the channel her namespace is filled from.
>
>    (For `rate` specifically the assignment is currently belt-and-braces:
>    `installRateCancellation()` wraps `window.rate` *before* `ensureVpython()` is
>    awaited, so `core_funcs`' import-time `from js import rate` already captures
>    the wrapped one. Removing the line does not break Stop today. It is kept
>    because it is what pins the guarantee against a future reordering — the code
>    comment there says so.)
>
>    **What a student does about it:** add `from vpython import *`, or prefix the
>    names (`vp.color.red`, `vp.rate(100)`) — either is correct and portable.
>
>    Covered by `test/browser/specs/vpython-namespace.spec.js`, which runs the
>    correct and the buggy form of the same real program on **both** runtimes, and
>    guards the Stop-kills-a-`rate()`-loop behaviour on the main thread.
>
>    ⚠️ **One divergence remains, in the opposite direction, and it is OPEN.**
>    `from vpython import *` supplies **math/random names on the worker but not on
>    the main thread** — measured, both runtimes, on the dev stack:
>
>    | name | main thread | worker |
>    |---|---|---|
>    | `sqrt`, `pi`, `sin`, `cos`, `random` | **ABSENT** | **PRESENT** (`sqrt(4)` → `2.0`) |
>    | `vector`, `color`, `scene`, `rate` | PRESENT | PRESENT |
>
>    The two paths run different vpython packages: the bespoke
>    `public/js/embed/wvpython/vpython/__init__.py` declares a restrictive
>    `__all__` of VPython names only; the worker's upstream `vpython-7.6.5` wheel
>    declares no top-level `__all__` and so leaks the math/random names its
>    submodules imported. The worker therefore matches **desktop VPython** (same
>    package), and the main thread is now *stricter than desktop VPython* — so
>    `from vpython import *` followed by `sqrt(2)` runs in a notebook, runs under
>    `workerVPython`, and raises `NameError` on the default runtime.
>
>    This is a packaging difference, not the namespace rule: nothing is being
>    seeded either way. Aligning them means adding the math/random names to the
>    bespoke package's `__all__`, which changes what `from vpython import *` means
>    on the default runtime — a product call, deliberately left to Steve rather
>    than folded into the seeding removal.
>
>    🚫 **Do not "fix" this by stripping the imports from vpython-jupyter**
>    (`vpython/__init__.py:53-56`, `from math import *` / `from numpy import
>    arange` / `from random import random`). That was considered and rejected,
>    and the reason is the distinction this whole caveat rests on:
>
>    * A module importing things into **its own namespace** is ordinary Python.
>      `import vpython as vp` still requires `vp.random` — nothing has been done
>      to the script's namespace. A developer who writes `from vpython import *`
>      has explicitly asked for whatever that module exposes.
>    * What WebVPython's interpreter does — and what trinket copied — is inject
>      names into **the running script's own namespace, before the script runs**.
>      The script never asked. *That* is the thing this rule forbids, and it is
>      what was removed above.
>
>    So vpython-jupyter is not violating the rule and needs no change; removing
>    those lines would break `from vpython import *` for every notebook and
>    desktop user of the published PyPI package, to fix something that is not a
>    problem.

Default **`false`**. When enabled, Web VPython programs run through the
`vpython-jupyter` package inside the Web Worker and GlowScript draws the scene on
the page. The animation becomes killable — the page cannot freeze, and Stop halts
a VPython loop the same way it halts any other worker program. The flag is
**independent of `workerRuntime`**: a deploy can worker-ize VPython without
worker-izing plain python3, or the other way round.

```yaml
features:
  workerVPython: true
```

**The flag is the only gate.** `?runtime=worker` does **not** opt a program into
this path — it cannot be enabled per-trinket by URL. `?runtime=main` still
escapes it, sending the program back to the untouched main-thread bridge.

**Which build is this deploy serving?** The two files this path adds
(`public/components/vpython-worker/`) are build artifacts of the vpython-jupyter
repo, copied in by `scripts/sync-vpython-worker.sh` — so "did the sync actually
happen?" is a real question. The page answers it: run a VPython program with the
flag on and the browser console prints, once,
`[vpython] worker path: front-end 7.6.5 (…/glowcomm_host.js), wheel vpython-7.6.5-py3-none-any.whl`.
The two versions should match; the sync script refuses to run if they do not.

**Which *source* built that wheel?** Versions cannot answer this: the common
mistake is editing vpython-jupyter, forgetting to rebuild, and syncing last
week's wheel — same filename, same version, both gates pass. Two things address
it. The sync script refuses when any source file under `$VPJ/vpython` is newer
than the wheel in `dist/`, and it writes
`public/components/vpython-worker/BUILD-INFO` recording the vpython-jupyter
commit the wheel was built from (flagged `+ UNCOMMITTED CHANGES` when that
checkout was dirty), which is committed alongside the binary so trinket's own
history can answer the question. Note the `sha256:` line identifies *that
artifact*, not the source: wheels are not byte-reproducible, so two builds of
the same commit differ. The `source:` line is the one to read.

**What changes when this is on:**

| | |
|---|---|
| a static VPython scene | drawn by GlowScript from the worker's updates |
| a VPython animation loop | paces normally and **Stop halts it** with the page responsive throughout — the point of the whole path |
| Stop | discards the worker interpreter — the scene freezes where it stood and stays on screen, so it can still be orbited; it is not resumable |
| Run pressed during a running animation | restarts the program from the top (the same fresh interpreter as any other Run) |
| a re-run | replaces the scene and renders normally — no page reload needed, no objects stacking up from the previous run |
| Python state | does **not** carry over between Runs — each Run is a fresh interpreter. This differs from **both** the main-thread VPython path *and* `workerRuntime` python3 runs, where variables from an earlier Run stay visible. Deliberate — see caveat 1 |
| mouse / camera | `scene.bind('click', …)` and friends fire, and orbit/zoom/pan work. Key bindings ride the same path but are untested |
| `gcurve` / `gdots` | plot — but `size=` at construction is ignored (see caveat 6) |
| the interactive console | statements reach the scene — `ball.color = color.blue` at the prompt redraws it — but **only if `workerRuntime` is on too**, so the console and the VPython run share one interpreter |
| `pause()` / `waitfor()` / widgets | not supported on this path; they raise `NotImplementedError` rather than silently doing nothing |
| `compound()` / `text()` / `extrusion()` / `obj.clone()` / `scene.mouse.pick` | **also not supported**, same loud `NotImplementedError` (see caveat 4) |
| animation speed | a `rate(N)` loop paces at ~N iterations/second with the loop body's own cost absorbed, so a heavy body runs *faster* here than on the main-thread path, which does not compensate (see caveat 5) |

With the flag off, VPython behaves exactly as it always has (main thread,
`from js import …` bridge) — that path is untouched.

**Known follow-ups (none of these block a trial; all of them need an owner):**

1. **`/components/` is served with `no-store`, so the 3.5 MB VPython wheel is
   refetched on every Run.** The cheapest performance lever on this path by a
   wide margin — the wheel already carries an etag, and a conditional GET returns
   304 with 0 bytes, so it would revalidate happily if it were allowed to be
   cached at all. The catch is that the header is set site-wide in `app.js`'s
   shared `onPreResponse` extension (the same one that sets `Pragma`, `Expires`
   and `X-Frame-Options`), with no path guard. Exempting `/components/` is a
   **serving-policy change for the whole site** and wants its own review, not a
   drive-by. **Needs an owner.**
2. **The `gcurve`/`gdots` `size=` regression** (caveat 6) should be fixed
   upstream in vpython-jupyter, in `gobj.setup`, rather than patched here.
3. **`from time import sleep` breaks in a VPython program.** The async transform
   awaits the *bare* names `rate` and `sleep`, so `sleep(1)` from `time` gets an
   `await` inserted and raises `TypeError`. This is **not** a regression — it is
   exact parity with the main-thread bridge, which shares the same transform —
   but it is newly reachable, because VPython worker runs force the transform on.
   `import time; time.sleep(1)` is untouched and is the workaround. The fix
   belongs in the shared `_async_transform.py`, which has its own 35-test suite
   and an obligation to stay in sync upstream.
4. **A REPL statement in flight during a live VPython run may wedge the restart —
   reasoned from the code, NOT reproduced.** `worker-client.js` tracks a single
   in-flight `current` slot, so a console statement submitted mid-animation
   overwrites the run's resolver; a Run pressed at that moment would settle the
   REPL promise instead of the run, `finishRun()` would never fire, `rerunQueued`
   would stay set and the Stop button would keep showing. It needs all three
   conditions at once: **`workerRuntime` on as well** (otherwise the REPL never
   goes through the worker at all — `pushRepl` is unreachable), the console open
   with a statement in flight, and a live animation. Pre-existing shape, newly
   reachable now that Run-during-a-run restarts. Recorded as a hypothesis with a
   clear mechanism; it should be reproduced before it is fixed.
5. **Widgets, `scene.pause()` / `scene.waitfor()`, and `compound()` / `text()` /
   `extrusion()` / `obj.clone()` / `scene.mouse.pick` remain deferred** (design
   decision V5). They raise a clear `NotImplementedError` naming the feature —
   deliberately loud, because a `pause()` that does not pause changes what the
   program means, and a `compound()` that deadlocks says nothing at all. The
   five in caveat 4 are the ones worth *undeferring* one day: each is a
   synchronous wait on a browser reply, and each would need the same treatment
   `rate()` got — a coroutine the async transform can `await` — plus a way for
   the library's own internal callers to await it too. That is a real piece of
   work, not a patch.
6. **PRE-EXISTING, NOT CAUSED BY THIS PATH — the console prompt disappears after
   a normal Run, on every deploy, with no flags at all.** `replActive` in
   `pyodide.js` is a latch: it is set when a prompt is armed and never cleared,
   while `resetOutput()` kills the armed prompt on every Run and only `stopCode()`
   re-arms it. So: open the Console, Run a program that *finishes*, and the
   prompt is gone for good — and the Console menu entry does nothing to bring it
   back, because it is guarded on `if (!replActive)` and `replActive` is still
   true. Reproduce it on any current deploy before blaming `workerVPython`; this
   branch neither causes it nor makes it worse (its change to `stopCode` restores
   the prompt in strictly more cases than before). It wants its own issue and its
   own fix — clearing the latch is a one-liner, but the surrounding REPL
   lifecycle deserves a look at the same time.

## Optional: cache static assets (`app.cache.enabled`)

Off by default. The stock behaviour sends `no-store` on **every** response, so
each page view re-downloads the whole front end (measured: 29 same-origin
assets, ~933 KB, uncacheable by browser and CDN alike). Turning this on lets
version-stamped asset URLs (`/cache-prefix-<token>/...`) be cached hard:

```yaml
# config/local.yaml (or local-production.yaml)
app:
  cache:
    enabled: true
    # staticMaxAge: 31536000   # optional; seconds, default 1 year
```

What changes — and what does not:

* **Only** version-stamped asset paths get `public, max-age=..., immutable`.
  Every dynamic response (HTML, API) keeps the exact `no-store` header it
  always had.
* The stamp is the deployed commit (see `lib/util/assetVersion.js`), so asset
  URLs change on deploy and clients pick up new assets immediately. Safe to
  cache "forever" for exactly that reason.
* A shared cache/CDN in front of the deploy can now serve those assets from
  its edge. Without a CDN you still get browser caching — the second page view
  stops re-downloading the front end.

Verify after enabling: `curl -sI https://<host>/cache-prefix-<token>/css/base.css`
(copy a real asset URL from the page source) should show `cache-control:
public, max-age=31536000, immutable`, while `curl -sI https://<host>/` keeps
`no-store`.

## Example — prod-only infra in `config/local-production.yaml`

```yaml
app:
  url:
    knownHosts:
      - trinket.example.org
aws:
  buckets:
    materials:
      name: your-materials-bucket
      host: https://.../your-materials-bucket
```

Every block is optional — anything you leave out inherits the stock value.

> ⚠️ **`logo` and `logoIcon` are a pair — override both.** `logo` is the wide
> mark; `logoIcon` is the compact one used where that doesn't fit, notably the
> **embed header at medium-down widths** — which is exactly what an embedded
> trinket box inside course text is. Override only `logo` and your branding
> appears in full screen while **every small embed still shows the stock Trinket
> mark** (issue #47). If you have no separate icon, point `logoIcon` at the same
> file rather than leaving it to inherit.
>
> Check a running deploy: `curl -s https://<host>/embed/python3 | grep 'show-for-medium-down'`.

---

## Day-to-day (docker compose)

The compose app service **bind-mounts the checkout** (`- .:/usr/local/node/trinket`),
so `deploys/<name>/` is read live at runtime. Config is loaded at app **boot**, so
after editing overlay files, restart the app to re-read them:

```bash
git -C deploys/<name> pull                          # pull your config changes
TRINKET_DEPLOY=<name> docker compose up -d --build   # rebuild + restart with the overlay
```

`--build` is only needed for dependency/Dockerfile changes; for a config-only edit,
`docker compose restart app` is enough (the bind-mount means the file is already
there).

⚠️ **A dependency change needs more than `--build`.** `node_modules` is a named
volume that a rebuild does not refresh, so a commit that adds a package runs
against the previous dependency set and crash-loops on `Cannot find module` —
with a build log that looks clean. Either install into the volume
(`docker compose exec -T app npm ci`) or, better, run servers from the image
with `docker-compose.prod.yml`. See
[UPDATING-A-RUNNING-DEPLOY.md](UPDATING-A-RUNNING-DEPLOY.md). On **Cloud Run** there's no bind-mount — the overlay's `config/`, `views/`,
`public/` are baked into the image at build (the `.env`/`.pem` are **not** — see
above), so there you redeploy with `deploy-cloudrun.sh`.

Update trinket-oss itself the same way (your config untouched):

```bash
git pull
TRINKET_DEPLOY=<name> docker compose up -d --build
```

For fast branding/view iteration, skip the rebuild and run bare node against the
compose backends: `docker compose up mongodb redis garage-init`, then
`TRINKET_DEPLOY=<name> node app.js` — a template edit then only needs a page reload.

---

## Verify the deploy (do this every time)

A deploy that silently did nothing looks exactly like a deploy that worked. The
deploy smoke answers that in well under a minute, against the real server:

```bash
cd test/browser
npm install                      # first time only
npx playwright install chromium  # first time only

EXPECT_COMMIT=$(git rev-parse --short HEAD) \
TRINKET_BASE_URL=https://<your-host> \
  npx playwright test -c playwright.deploy.config.js
```

Every test is anonymous and read-only, so this is safe to run against
production. It checks that the build being served is the one you deployed
(`EXPECT_COMMIT` makes a no-op deploy fail loudly), that `NODE_ENV=production`
is actually set, that embeds carry the expected content policy in both run
modes, that a Web VPython scene and a python3 program both really run, and that
a program cannot pull in third-party content.

Current trials, for reference:

```bash
TRINKET_BASE_URL=https://rba-merge-trial.spvi.net  ...   # Cloud Run / Firestore
TRINKET_BASE_URL=https://trial-merge.spvi.net      ...   # self-hosted / Mongo
```

If a test fails, `test/browser/test-results/` holds a screenshot of the page at
the moment it failed.

## Why this is nice

- **No fork** — track the public repo and `git pull`; your config lives in its own repo.
- **Secrets stay out of the public repo _and the image_** — they're in your private
  overlay's `.env`, which `.dockerignore` excludes from the build; on Cloud Run they're
  injected via Secret Manager at deploy time.
- **One checkout, many deploys** — clone several overlay repos side by side under
  `deploys/` and pick per run.
- **Branding without patching** — shadow any page or asset at the same relative path.
