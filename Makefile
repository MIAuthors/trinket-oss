# Local development stacks (see DEPLOYING.md and GETTING_STARTED.md).
#
# Both stacks auto-read the gitignored root .env for interpolation — GCP needs
# SESSION_PASSWORD + FIREBASE_CLIENT_CONFIG, self-host needs GARAGE_* — so no
# inline vars are required. The two variable sets are disjoint; one .env serves
# both.
#
# Intel/amd64 hosts: the compose files pin platform: linux/arm64 (Apple
# Silicon). If that runs slowly under emulation, add an override that sets
# services.app.platform: linux/amd64 (see the "two locals" note in the docs).
#
# Per-deploy operations (deploy/verify/clean) dispatch to the ACTIVE overlay's
# own Makefile — see "Per-deploy targets" below and docs/DEPLOY-OVERLAY-GUIDE.md.

.DEFAULT_GOAL := help
.PHONY: help gcp mongo down-gcp down-mongo browser-smoke deploy verify deploy-clean deploy-clean-dry

help: ## Show available targets
	@grep -hE '^[a-z-]+:.*?##' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  make %-11s %s\n", $$1, $$2}'

gcp: ## GCP shape: Firestore + Firebase Auth + Storage emulators (app :3001, UI :4000)
	bash scripts/build-info.sh
	docker compose -f docker-compose.gcr.yml up --build

mongo: ## Self-host shape: mongo + redis + garage S3 (app :3000)
	bash scripts/build-info.sh
	docker compose up --build

down-gcp: ## Stop and remove the GCP stack
	docker compose -f docker-compose.gcr.yml down

down-mongo: ## Stop and remove the self-host stack
	docker compose down

browser-smoke: ## Browser smoke tests (New Trinket + WebVPython journeys) vs a local gcp stack; on-demand pre-deploy gate
	bash test/browser/run-smoke.sh

# --- Per-deploy targets ------------------------------------------------------
# An overlay repo (deploys/<name>/) may ship its own Makefile carrying that
# deployment's project ID, hostname and platform recipe (Cloud Run, compose, …).
# These targets dispatch to it, so `make deploy` works in any checkout without
# remembering overlay names or env vars. TRINKET_DEPLOY comes from the
# environment or this checkout's .env (same precedence deploy-cloudrun.sh uses).
# -f2- not -f2: a value containing '=' must not be truncated at the first one.
TRINKET_DEPLOY ?= $(shell grep -E '^TRINKET_DEPLOY=' .env 2>/dev/null | head -1 | cut -d= -f2-)
DEPLOY_MK = deploys/$(TRINKET_DEPLOY)/Makefile

# One canned recipe, four documented targets — separate rule lines so each
# shows up in `make help` (its grep wants one target per line). The overlay
# Makefile is invoked with -f from THIS directory: overlay Makefiles are
# written for repo-root cwd (their guards check ./deploy-cloudrun.sh).
define _dispatch_overlay
	@[ -n "$(TRINKET_DEPLOY)" ] || { echo "TRINKET_DEPLOY is not set (env or .env). Overlays with Makefiles:"; \
	  ls deploys/*/Makefile 2>/dev/null | sed 's|deploys/\(.*\)/Makefile|  \1|' || echo "  (none found under deploys/)"; exit 1; }
	@[ -f "$(DEPLOY_MK)" ] || { echo "$(DEPLOY_MK) not found — this overlay ships no Makefile (see docs/DEPLOY-OVERLAY-GUIDE.md)"; exit 1; }
	@$(MAKE) -f $(DEPLOY_MK) $(patsubst deploy-clean%,clean%,$@)
endef

deploy: ## Build + deploy the ACTIVE overlay (TRINKET_DEPLOY from env or .env)
	$(_dispatch_overlay)

verify: ## Verify the ACTIVE overlay's live deployment (/version, brand)
	$(_dispatch_overlay)

deploy-clean-dry: ## Preview cleanup of the ACTIVE overlay's old revisions/images
	$(_dispatch_overlay)

deploy-clean: ## Trim the ACTIVE overlay's old revisions/images
	$(_dispatch_overlay)
