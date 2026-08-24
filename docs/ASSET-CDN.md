# Publishing assets to a CDN

`scripts/deploy-hosting.sh` uploads a deploy's static assets to Firebase
Hosting so they are served from the edge instead of from a billable Cloud Run
container.

## The trap this exists to avoid

Putting Hosting in front of Cloud Run with a `run` rewrite and stopping there
delivers **nothing**. Rewrite responses carry:

```
vary: accept-encoding, cookie, need-authorization, x-fh-requested-host
```

and a cookie-bearing request then bypasses the edge entirely. The app sets a
session cookie on the home page, so every real browser carries one.

Measured on the trial, fresh browser visitor:

| setup | assets from edge | requests reaching Cloud Run |
|---|---|---|
| rewrite only | 0 | **25** |
| assets uploaded | **25** | **0** |

⚠️ **`curl` cannot detect this.** It sends no cookie, so it reports `x-cache:
HIT` and the rewrite-only setup looks like it works. It also sends no
`accept-encoding`, so it warms a cache object no browser ever requests. Verify
with a real browser AND with origin-side request logs:

```sh
gcloud logging read 'resource.type=cloud_run_revision
  AND resource.labels.service_name=<service>
  AND timestamp>="<iso>" AND httpRequest.requestUrl:"cache-prefix"' \
  --project <project> --format='value(httpRequest.requestUrl)' | wc -l
```

## Running it

```sh
FIREBASE_PROJECT=<project> HOSTING_SITE=<site> \
SERVICE_URL=https://<cloud-run-url> \
IMAGE=<region>-docker.pkg.dev/<project>/trinket/<service>:latest \
HOSTING_REWRITES='[{"source":"**","run":{"serviceId":"<service>","region":"us-central1"}}]' \
  scripts/deploy-hosting.sh
```

`HOSTING_REWRITES` is **required**, because `firebase deploy --only hosting`
*replaces* the site's config — whatever is passed becomes the site's only
rewrites. For a front-door site pass the run rewrite as above; for an
assets-only site (the separate-host architecture at the bottom of this doc)
pass `HOSTING_REWRITES='[]'` explicitly. Requiring it means an assets upload
can never silently strip the run rewrite off a live front door.

Assets are published under `/cache-prefix-<commit>/`, matching the URLs the app
emits (`lib/util/assetVersion.js`). Each deploy publishes a fresh immutable set;
older ones simply stop being requested. Run it AFTER the Cloud Run deploy, so
the commit it infers is the one actually serving.

The built assets live in the image, not the checkout — `base.css` is ~96 KB on
disk and ~652 KB built — so the script extracts `public/` from the image with
docker. Pass `ASSET_SRC=` to supply a directory instead.

`components/` is ~441 MB of source trees in the image and is deliberately NOT
uploaded wholesale; the script crawls the deploy's own pages and uploads only
the component files they reference. Anything missed falls through to the origin
and still works, uncached.

Firebase applies its own `max-age=3600` to uploaded files, overriding what the
app would have sent, so the config restates the immutable header.

## Before using this in production

- **Dynamic requests still go through the rewrite**, so only the `__session`
  cookie reaches the app. A deploy behind Hosting must set
  `app.plugins.session.name: __session`, and sign-in must be verified — the
  failure mode is that login appears to work and every later request is
  anonymous.
- Pointing a production hostname at Hosting replaces its Cloud Run domain
  mapping. Rehearse on a trial hostname first.
- An alternative that avoids the cookie constraint entirely is to serve assets
  from a SEPARATE host and leave the app on Cloud Run. That needs the app to
  emit absolute asset URLs (there is precedent in `vendorHost`), so it is more
  code but less risk to authentication.
