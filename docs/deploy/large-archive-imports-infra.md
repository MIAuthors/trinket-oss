# Operator runbook: large-archive-imports infra

The large-archive-imports feature lets course archives bigger than Cloud
Run's 32 MiB request-ingress cap be imported, by uploading the zip directly
to storage (via a browser-signed URL) instead of POSTing it through the app
server. The signed-URL path is:

```
POST /api/imports/upload-url          -> { url, key }   (client PUTs the zip to `url`)
POST /api/imports/course/from-storage -> imports the object at `key`
```

None of the steps below happen automatically on `git push` / redeploy. Each
deploy that wants the large-archive path working must be provisioned once,
by hand, as described here.

---

## 1. GCS deploys: grant the runtime SA `signBlob` permission

**Applies to:** mandi (project `trinket-gcr-test`), uindy (project
`trinket-uindy`) — any Cloud Run deploy on the `gcs` storage backend.

Cloud Run's runtime service account has no private key on disk, so the
`@google-cloud/storage` client can't sign a V4 URL locally. It instead
calls the IAM `signBlob` API and asks the service account to sign on its
own behalf — which requires the SA to hold
`roles/iam.serviceAccountTokenCreator` **on itself**.

```bash
PROJECT=trinket-gcr-test   # or trinket-uindy

RUNTIME_SA=$(gcloud run services describe trinket --region us-central1 --project "$PROJECT" \
  --format='value(spec.template.spec.serviceAccountName)')
# empty output => the service runs as the project's default compute SA:
#   ${PROJECT_NUMBER}-compute@developer.gserviceaccount.com

gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member="serviceAccount:$RUNTIME_SA" \
  --role="roles/iam.serviceAccountTokenCreator" --project "$PROJECT"
```

This is a one-time grant per project (survives redeploys — it's IAM, not
part of the revision). Re-run it if the runtime SA is ever changed.

**Symptom if skipped:** `POST /api/imports/upload-url` fails (signing
throws). The client catches this and silently falls back to the small
direct-POST-only import path — large archives just won't have the option
to use the fast path, and archives over the 32 MiB ingress cap will fail
at the load balancer.

---

## 2. Materials-bucket lifecycle rule: expire `imports/tmp/`

The app deletes the temp upload object as soon as `from-storage` import
completes. This lifecycle rule is a safety net for uploads that never
finish the import call (abandoned tab, network drop, crashed browser) —
without it, orphaned zips under `imports/tmp/` accumulate forever.

Uploaded objects are keyed `imports/tmp/<userId>/<uuid>.zip`, so scope the
rule to that prefix.

### GCS

```bash
cat > /tmp/imports-tmp-lifecycle.json <<'EOF'
{
  "rule": [
    {
      "action": { "type": "Delete" },
      "condition": {
        "age": 1,
        "matchesPrefix": ["imports/tmp/"]
      }
    }
  ]
}
EOF

gcloud storage buckets update gs://<materials-bucket> \
  --lifecycle-file=/tmp/imports-tmp-lifecycle.json --project <PROJECT>
```

`<materials-bucket>` is `config.aws.buckets.materials.name` for the deploy
(check the deploy's overlay/`local-production.yaml`). This command sets the
bucket's *entire* lifecycle config, so if the materials bucket already has
other lifecycle rules, merge them into the same `rule` array rather than
overwriting.

### garage / S3-compatible

Apply an equivalent S3 lifecycle configuration (bucket lifecycle, not GCS
lifecycle):

```bash
cat > /tmp/imports-tmp-lifecycle.json <<'EOF'
{
  "Rules": [
    {
      "ID": "expire-import-tmp-uploads",
      "Filter": { "Prefix": "imports/tmp/" },
      "Status": "Enabled",
      "Expiration": { "Days": 1 }
    }
  ]
}
EOF

aws --endpoint-url <garage-s3-endpoint> s3api put-bucket-lifecycle-configuration \
  --bucket <materials-bucket> --lifecycle-configuration file:///tmp/imports-tmp-lifecycle.json
```

Use whatever S3-compatible client the deploy already uses to administer
garage (aws-cli against `--endpoint-url`, or garage's own tooling if it
exposes lifecycle config — check current garage version support before
relying on this).

**Symptom if skipped:** no immediate user-facing symptom — orphaned
partial/abandoned upload objects just accumulate in the materials bucket
indefinitely, quietly costing storage.

---

## 3. Self-host (garage): no IAM step, but verify `aws.publicEndpoint`

Self-hosted/garage deploys sign PUT URLs with the existing S3 access key
(no service-account impersonation involved), so **step 1 does not apply**
— there is nothing to grant.

However, the signed upload PUT URL is signed against
`config.aws.publicEndpoint`, exactly like the existing signed-download URLs
(see `lib/controllers/users.js:1184-1198`). Under SigV4 the host is part of
the signature (`SignedHeaders=host`), so the URL must be signed for the
*browser-reachable* host — an internal Docker-network address like
`garage:3900` or `minio:9000` is unreachable from the user's browser, and
rewriting the host after signing would invalidate the signature.

**Before relying on the large-upload path on a self-host deploy, verify:**

```yaml
aws:
  publicEndpoint: "https://<public-facing-garage-host>"
```

is set in the deploy overlay to the actual public-facing S3 endpoint for
that deploy — not left unset, and not pointing at an internal-only host.
Any deploy that fronts garage/minio behind a different browser-facing host
(reverse proxy, custom domain) must keep this in sync with that host.

The materials-bucket lifecycle rule from step 2 is still recommended for
self-host deploys (garage/S3 variant).

**Symptom if skipped / misconfigured:** the signed upload URL points at an
address the browser can't reach — the PUT from the browser fails (DNS
error / connection refused), and the import never starts. This mirrors the
existing failure mode for signed export-download URLs on the same
misconfiguration.

---

## 4. Config knobs (deploy overlay: `imports.largeUpload`)

Defaults live in `config/default.yaml`:

```yaml
imports:
  largeUpload:
    enabled: true                 # per-deploy opt-out; false = direct POST only (small files)
    thresholdBytes: 26214400      # 25 MiB — client switch point (< 32 MiB ingress cap)
    maxArchiveBytes: 104857600    # 100 MiB — server ceiling enforced on from-storage
```

| Key | Default | Meaning |
| --- | --- | --- |
| `imports.largeUpload.enabled` | `true` | Set `false` in a deploy overlay to opt out entirely — the client falls back to direct-POST-only imports (small files only, subject to the 32 MiB ingress cap). Use this to disable the feature on a deploy that hasn't done steps 1–3. |
| `imports.largeUpload.thresholdBytes` | 25 MiB | Client-side switch point: archives at/above this size use the signed-URL upload path instead of a direct POST. |
| `imports.largeUpload.maxArchiveBytes` | 100 MiB | Server-enforced ceiling on `from-storage` imports — archives larger than this are rejected even if uploaded successfully. |

**Operator action:** confirm `maxArchiveBytes` is set to a value that fits
comfortably in the Cloud Run instance's memory — the import buffers the
whole archive in memory during processing. The 100 MiB default fits the
2 Gi Cloud Run instances currently used by mandi and uindy; raise the
Cloud Run memory allocation before raising `maxArchiveBytes` on any deploy.

**Symptom if skipped:** setting `maxArchiveBytes` too high for the
instance's memory risks OOM-killed import requests on large archives
instead of a clean "archive too large" error.
