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

---

## Example — identity in `config/local.yaml` (renders everywhere, incl. `make gcp`)

```yaml
app:
  siteName: 'Example Trinket'
  logo: '/img/brand/logo.png'          # your file in deploys/<name>/public/img/brand/
  announcement: '⚠️ Test server — data may be wiped.'   # shows in preview too
  branding:
    lead: 'A browser-based coding platform for computational physics.'
    subtitle: 'Write and run Python and Web VPython in interactive courses.'
  theme:
    heading: '#123456'                  # your brand colors
    primary: '#123456'

# Which trinket types appear in the New-Trinket menu AND are allowed to run.
# Omit this block to inherit the stock set; override only what you want to change:
features:
  trinkets:
    html: true        # e.g. also enable HTML trinkets
    # pyodide: true   # …or re-enable a separate Pyodide button
```

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
there). On **Cloud Run** there's no bind-mount — the overlay's `config/`, `views/`,
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

## Why this is nice

- **No fork** — track the public repo and `git pull`; your config lives in its own repo.
- **Secrets stay out of the public repo _and the image_** — they're in your private
  overlay's `.env`, which `.dockerignore` excludes from the build; on Cloud Run they're
  injected via Secret Manager at deploy time.
- **One checkout, many deploys** — clone several overlay repos side by side under
  `deploys/` and pick per run.
- **Branding without patching** — shadow any page or asset at the same relative path.
