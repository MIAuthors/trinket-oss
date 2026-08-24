# Markdown Engine Bridge — Design

**Date:** 2026-08-15
**Status:** Proposed
**Origin:** MIAuthors/trinket-oss#3 (atitus, with Ruth and Bruce): "would it be good
to use the GitHub markdown rendering engine so we are using somewhat standard
markdown."

## Goal

Add a modern, GFM-compliant markdown engine (current `marked` + DOMPurify)
alongside the existing legacy engine, selected **per course** by an instructor
setting. The setting is a **migration bridge, not a permanent feature**: new
courses default to the modern engine, existing courses stay on legacy until
flipped, and the endpoint is retiring the legacy engine entirely. Migration
*policy* (defaults, sunset timing, author outreach) is deliberately left to the
upstream PR conversation — this design ships mechanism and evidence tooling,
not policy.

## Current state (verified 2026-08-15 against picup/main 14094e7)

- `marked` is pinned to `git+https://github.com/trinketapp/marked.git`, a fork
  frozen June 2014, equivalent to stock marked v0.3.2 plus a 38-line delta
  whose purpose is allowing `sanitize:` to be a **function** (plus an
  html-block regex tweak and async error plumbing).
- All trinket-specific behavior lives in a 487-line wrapper that exists
  **twice**: `lib/shared/trinket-markdown.js` (server: course download/export
  via `lib/controllers/courses.js`) and `public/js/trinket-markdown.js`
  (client: course editor via the `markdownParser` Angular service in
  `public/js/services/markdown.js`, plus every embed page's instruction pane).
  The copies differ only in config injection (~138 diff lines).
- The wrapper provides: trinket code-fence embeds
  (`` ```python.trinket:height=500 ``), link/image auto-embedding for
  YouTube/Vimeo/PhET/GeoGebra/plotly/Google Docs/viewerjs/etc., an iframe
  `src` whitelist, image sizing syntax (`=300x200`), highlight.js code
  highlighting, and a homegrown regex tag/attribute whitelist sanitizer hooked
  through the fork's `sanitize:`-as-function feature.
- Math: MathJax 2.7 typesets **page-level after render** (`lib/views/base.html`,
  with an siunitx extension and `ignoreClass: "mathjax-ignore"`). The markdown
  engine's only obligation is to not mangle TeX before MathJax sees it.
- **No client bundler**: `public/js` is plain script tags. Any new library must
  ship as a browser-ready single file.

## Decisions already made

1. **Engine: current `marked` + DOMPurify** (over markdown-it). Same lineage as
   the existing code, single-file UMD builds, GFM by default, and the port of
   the wrapper's renderer overrides stays conceptually parallel to the legacy
   wrapper — which keeps the eventual fork retirement a readable diff.
2. **Bridge, modern default for new courses.** Existing courses are untouched
   by deploy alone; the new-course default comes from config, not code.
3. **Trinket instruction panes stay on legacy** for now. They have no course
   context; they flip later in one global move when the fork retires. Out of
   scope here beyond making sure nothing regresses.
4. **The PR poses the migration-policy questions instead of answering them**
   (see "The PR conversation" below).

## Architecture

### Engines

- **Legacy path: byte-frozen.** The trinketapp/marked fork, both existing
  wrapper copies, and the regex sanitizer are not modified at all. Zero
  regression surface for existing content.
- **Modern path: one new shared module,** `public/js/trinket-markdown-modern.js`,
  written once as a **dependency-injected factory** with a UMD guard:
  - Server: `require('../../public/js/trinket-markdown-modern.js')(marked,
    createDOMPurify(window), hljs, serverConfigAdapter)` — using `jsdom` for
    DOMPurify's window (dev-dependency-grade cost, server render is only the
    course download/export path).
  - Client: script tags load vendored `marked.umd.js` and `dompurify.min.js`,
    then `window.trinketMarkdownModern(marked, DOMPurify, hljs, trinketConfig)`.
  - This ends the server/client duplication **for the modern path only**; the
    legacy copies stay frozen.
- **Vendored, pinned libraries** committed under `public/components/`
  (current `marked` UMD build, current DOMPurify) rather than cdnjs, per the
  build-resilience direction (rehost-components backlog). Exact versions pinned
  in the files themselves and recorded in `package.json` for the server side.

### Modern wrapper: feature parity contract

The modern module must reproduce, via marked's extension/renderer API:

| Feature | Legacy mechanism | Modern mechanism |
|---|---|---|
| Trinket code fences (`lang.trinket/run/console`, `:k=v` args) | `processCode` renderer override | `code` renderer override (same iframe output contract) |
| Embed URLs (YouTube, Vimeo, viewerjs, self-hosted trinket URLs, slideshare, Google Maps/Docs, GeoGebra, pythontutor, PhET, parsons, loom, forms.office, quizizz, kahoot) | `EMBED_URLS` table in link/image overrides | Same table, same overrides — the table is lifted verbatim |
| Image sizing `=WxH`, plotly `![plotly](user:id)` | `processImage` | Same |
| highlight.js fenced-code highlighting | `processCode` fallback | Same |
| Inline HTML sanitization | fork `sanitize:` hook + regex whitelist | **DOMPurify on final output** with an allowlist mirroring `HTML_WHITELIST` and an `uponSanitizeElement` hook enforcing the iframe `src` regex whitelist |
| Math survival | 0.3.2 accidental behavior | **Explicit math pass-through extension**: `$…$`, `$$…$$`, `\(…\)`, `\[…\]` spans emitted verbatim (HTML-escaped only) so MathJax receives them intact |

Sanitization moves from parse-time (legacy) to output-time (modern) — the
DOMPurify profile is the security review surface, and it must be at least as
strict as `HTML_WHITELIST`. Known acceptable difference: DOMPurify is DOM-based
and will normalize malformed HTML that the legacy regex sanitizer passed
through raw.

### The course setting

- **Model:** `markdownEngine: 'legacy' | 'modern'` on the course document.
  **Absent ⇒ legacy** — existing courses are untouched by deploy alone.
- **Creation default:** new config key
  `features.markdown.newCourseDefault: modern` in `config/default.yaml`
  (values `legacy`/`modern`). Applied at course creation only; the value
  shipped upstream is a PR-conversation item, and each deploy overlay can
  override it either way.
- **UI:** a dropdown in Course → Edit Course (same pane as delete/archive),
  editable by anyone who can edit course settings today. Copy explains the
  bridge plainly: "Modern (GitHub-style) markdown — recommended for new
  content" / "Legacy — original trinket rendering". Flipping is instant and
  reversible; that reversibility *is* the migration safety story.

### Threading the setting

- **Client:** `markdownParser({...})` gains an `engine` option; the course
  editor passes `course.markdownEngine || 'legacy'`. The service returns the
  modern or legacy parser accordingly. Embed pages don't pass it ⇒ legacy.
- **Server:** the course download/export path in `lib/controllers/courses.js`
  selects the module by the course's stored setting.
- One seam per side; no other call sites change.

## Evidence tooling (the migration's data source)

`scripts/markdown-engine-diff.js`, run with app config (both DB backends),
three modes:

1. **`report`** — for one course or all: render every material through both
   engines, compare after HTML normalization (whitespace collapse, attribute
   ordering, self-closing forms), and emit a per-course, per-material,
   per-author report of real rendering differences. This is the concrete
   answer to "how do we find problem courses" and produces the author-outreach
   list.
2. **`classify`** — bucket differences into known legacy-quirk classes
   (expected: 0.3.x list-indentation quirks, loose HTML the regex sanitizer
   tolerated, TeX the old parser happened to leave alone, plus "modern is
   simply correct now" as the no-action bucket). Rules are grown
   **empirically from what `report` finds on the mandi corpus** — no
   speculative rules.
3. **`autofix`** (stage 2) — for classified differences, apply the class's
   source rewrite, then **prove equivalence**: render the rewritten source
   with the *modern* engine and compare against the *legacy* rendering of the
   *original*. Only a rewrite that restores equivalence is ever applied; the
   machine never guesses. Guardrails:
   - `--dry-run` is the default; `--apply` is explicit and per-course.
   - The original source is preserved on the material
     (`preMigrationSource` field) so every conversion is reversible.
   - Materials no rule can provably fix land on the human-review/notification
     list.

  The normalizer operates on markdown text, so the same machinery later
  applies to trinket instruction panes even though the engine setting does not
  cover them now.

## The PR conversation

The upstream PR description explicitly poses, rather than decides:

1. Which `newCourseDefault` ships upstream (this design proposes `modern`)?
2. Criteria and timeline for flipping *existing* courses and finally retiring
   the fork — driven by `report` numbers, not guesswork.
3. How the diff report drives author notification (who contacts, with what).
4. Whether/when trinket instruction panes follow, as a single global flip.
5. Whether `autofix --apply` requires author consent or is an operator action
   with notification.

## Testing (TDD)

- **Modern-extension unit tests** (Vitest, backend-independent): each parity
  row above gets fixture-driven tests — trinket fences with argument parsing,
  every `EMBED_URLS` family, image sizing, plotly syntax, hljs fencing.
- **Parity tests:** the same trinket-syntax fixtures rendered by legacy and
  modern must produce equivalent embed iframes (same src contract), because
  flipping a course must not break its embedded trinkets.
- **Sanitizer tests:** the DOMPurify profile against the `HTML_WHITELIST`
  cases — allowed tags/attrs pass, everything else stripped; iframe `src`
  whitelist enforced; known XSS vectors (including ones the legacy regex
  sanitizer is weak against) rejected.
- **Math survival tests:** TeX fixtures (subscripts, backslashes, `$$`
  blocks, siunitx forms) must pass through the modern engine byte-intact.
- **Setting tests:** course creation honors `newCourseDefault`; absent field
  renders legacy; export path selects by setting. Both DB backends.
- **Diff-script tests:** normalization rules, classification, and the
  equivalence-proof loop on synthetic fixtures.
- **Legacy path:** no new tests — it does not change, and that is verified by
  the diff being empty on those files.

## Out of scope

- Flipping trinket instruction panes (later, global, one move).
- Author notification mechanics (email/UI) — the report produces the list;
  outreach is human.
- Any UI for the diff report.
- Removing the legacy engine (the endpoint, but a later PR gated on the
  conversation above).

## Staging

- **Stage 1 (the PR):** modern module + vendored libs, course setting + UI +
  threading, config default, diff script `report` mode, full test suite.
- **Stage 2 (follow-up, evidence-driven):** `classify` rules from real corpus
  findings, then `autofix` with the equivalence proof.
