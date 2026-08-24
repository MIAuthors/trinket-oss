# docs/ — what lives where

Root-level docs are the entry points: [README](../README.md),
[GETTING_STARTED](../GETTING_STARTED.md), [DEPLOYING](../DEPLOYING.md),
[CONTRIBUTING](../CONTRIBUTING.md), [COMPONENTS](../COMPONENTS.md),
[CHANGELOG](../CHANGELOG.md). Everything else is organized here by kind:

| directory | what it holds | current? |
|---|---|---|
| [`DEPLOY-OVERLAY-GUIDE.md`](DEPLOY-OVERLAY-GUIDE.md) | Running your own deployment with a private `deploys/<name>` config repo — branding, theme keys, per-deploy Makefile | **yes — the canonical overlay reference** |
| [`EMBEDDING-IMPORTED-TRINKETS.md`](EMBEDDING-IMPORTED-TRINKETS.md) | User-facing how-to: fixing embed links after importing | yes |
| [`lti/`](lti/) | LTI 1.3: registration walkthrough, launch/SSO spec, authority model, auth-authority split proposal | yes |
| [`deploy/`](deploy/) | Operator runbooks (large-archive imports infra) | yes |
| [`testbed/`](testbed/) | Canvas + trinket testbed bring-up and orchestration | yes (used for LTI testing) |
| [`compliance/`](compliance/) | FERPA / privacy assessments for institutions | yes |
| [`design/`](design/) | Dated design/decision records for shipped features (email verification, variable explorer, step debugger, inline input) | point-in-time — trust the code over the doc |
| [`proposals/`](proposals/) | Drafted-but-not-acted-on analyses (archived upstream-issue drafts, feature proposals) | not implemented; each carries a STATUS header |
| [`history/`](history/) | Records of completed migrations (Firestore adapter log, gcr→picup merge roadmap/notes, toolchain disposition, deployment plan) | **historical — do not follow as guidance** |
| [`superpowers/`](superpowers/) | Working specs and implementation plans from feature development (see its README) | point-in-time snapshots |

Rule of thumb: if a doc contradicts the code, the code wins and the doc belongs
in `history/` — send a PR.
