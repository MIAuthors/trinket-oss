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
        ├── .env                           <- infra + secrets (project, buckets, URLs, keys)
        ├── config/
        │   ├── local-production.yaml      <- config overrides (branding, features, buckets…)
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
   whatever of these four parts you need — all optional:
   ```
   .env
   config/local-production.yaml
   views/…            (only if overriding pages)
   public/…           (only if overriding assets, e.g. a logo)
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
| `deploys/<name>/.env` | Infra + secrets: bucket names/hosts, public URL/host, storage creds, session password, LTI/OAuth keys | Sourced **after** the root `.env` and overrides it. |
| `deploys/<name>/config/local-production.yaml` | Config overrides: site name, branding, theme, **which trinket types are enabled**, LTI settings, buckets | Deep-merged over `default.yaml`; **wins over everything.** Loaded only when `NODE_ENV=production`. |
| `deploys/<name>/config/local-development.yaml` | Dev-only overrides (e.g. pointing bare `node` at the compose backends) | Loaded only when `NODE_ENV=development`; never leaks into prod. |
| `deploys/<name>/views/…` | Nunjucks templates that replace stock pages by relative path | e.g. `views/static/about.html` replaces `lib/views/static/about.html`. |
| `deploys/<name>/public/…` | Static assets that replace stock ones | e.g. `public/img/brand/logo.png`. |

> ⚠️ Put env-specific values in the **env-suffixed** files (`local-production.yaml` /
> `local-development.yaml`), **not** `local.yaml` — `local.yaml` loads in *every*
> environment (including tests), so a backend or feature value there can poison
> unrelated runs.

---

## Example `config/local-production.yaml`

```yaml
app:
  siteName: 'Example Trinket'
  logo: '/img/brand/logo.png'          # your file in deploys/<name>/public/img/brand/
  branding:
    lead: 'A browser-based coding platform for computational physics.'
    subtitle: 'Write and run Python and Web VPython in interactive courses.'
  theme:
    heading: '#123456'                  # your brand colors
    primary: '#123456'
  url:
    knownHosts:
      - trinket.example.org

# Which trinket types appear in the New-Trinket menu AND are allowed to run.
# Omit this block to inherit the stock set; override only what you want to change:
features:
  trinkets:
    html: true        # e.g. also enable HTML trinkets
    # pyodide: true   # …or re-enable a separate Pyodide button

aws:
  buckets:
    materials:
      name: your-materials-bucket
      host: https://.../your-materials-bucket
```

Every block is optional — anything you leave out inherits the stock value.

---

## Day-to-day (docker compose)

The overlay is **baked into the image at build time** (the Dockerfile copies the
whole tree, `deploys/` included), so rebuild after editing overlay files:

```bash
git -C deploys/<name> pull                        # pull your config changes
TRINKET_DEPLOY=<name> docker compose up -d --build # rebuild + restart with the overlay
```

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
- **Secrets stay out of the public repo** — they're in your private overlay.
- **One checkout, many deploys** — clone several overlay repos side by side under
  `deploys/` and pick per run.
- **Branding without patching** — shadow any page or asset at the same relative path.
