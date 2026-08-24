# Markdown Engine Bridge (Stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a modern marked+DOMPurify markdown engine beside the frozen legacy engine, selected per course by `globalSettings.markdownEngine`, plus the `report` mode of the corpus diff script.

**Architecture:** One new dependency-injected UMD module (`public/js/trinket-markdown-modern.js`) serves both server and client; the legacy fork and both legacy wrapper copies are byte-frozen. The course setting threads through exactly two seams: the `markdownParser` Angular service (client) and the course download/export path (server). Vendored, pinned library builds — no bundler exists.

**Tech Stack:** marked 12.0.2 (positional-renderer API), DOMPurify 3.2.4, jsdom (server DOM for DOMPurify), highlight.js (existing), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-15-markdown-engine-bridge-design.md`

## Global Constraints

- **Legacy path byte-frozen:** `lib/shared/trinket-markdown.js`, `public/js/trinket-markdown.js`, and the `marked` dependency (trinketapp fork) must show ZERO diff at the end of every task. `git diff --stat` on those paths must be empty.
- **`window.marked` is owned by the legacy fork** (loaded globally via `config/default.yaml` `jsbody`). The modern marked build must never assign to it — it loads as `markedModern`.
- **No bundler:** every client-side file must work as a plain `<script>` tag; every server-side use must work with plain CommonJS `require`.
- **Setting semantics:** absent/undefined `markdownEngine` ⇒ `'legacy'`, always. Only the exact string `'modern'` selects the modern engine.
- **New-course default** comes from config key `features.markdown.newCourseDefault` (values `legacy`/`modern`, shipped default `modern`) — applied at creation only, never retroactively.
- **Versions pinned exactly:** marked `12.0.2`, DOMPurify `3.2.4`. Do not "helpfully" bump.
- **Code style:** match the codebase — `var`, CommonJS, comma-first is NOT used here; follow the file you are editing.
- **Tests:** Vitest. Unit tests in `test/unit/*.test.js` (no DB). Run a file with `npx vitest run test/unit/<file> --reporter=verbose`. The full suite is `npm test`.
- Trinket embed iframe output of the modern engine must be byte-compatible with legacy for the same input (same `src` contract) — flipping a course must not break embedded trinkets.

---

### Task 1: Vendor the modern libraries

**Files:**
- Create: `public/components/marked-modern/marked-modern.js` (wrapped official build)
- Create: `public/components/dompurify/purify.min.js` (official build, verbatim)
- Modify: `package.json` (add `jsdom` dependency)
- Test: `test/unit/markdown-modern-vendor.test.js`

**Interfaces:**
- Produces: `require('<repo>/public/components/marked-modern/marked-modern.js')` → object with `Marked` (class) and `marked`; in a browser the same file sets `window.markedModern`. `require('<repo>/public/components/dompurify/purify.min.js')` → `createDOMPurify` factory; `createDOMPurify(jsdomWindow).sanitize(html)` works. Browser: `window.DOMPurify` (already window-bound).

- [ ] **Step 1: Write the failing test**

```js
// test/unit/markdown-modern-vendor.test.js
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');

describe('vendored modern markdown libraries', () => {
  it('marked-modern loads via require and exposes Marked without touching any global', () => {
    const markedModern = require(path.join(ROOT, 'public/components/marked-modern/marked-modern.js'));
    expect(typeof markedModern.Marked).toBe('function');
    const m = new markedModern.Marked({ gfm: true });
    expect(m.parse('# hi').trim()).toBe('<h1>hi</h1>');
    // the legacy fork owns the `marked` module name; the vendored file must not shadow it
    const legacy = require('marked');
    expect(typeof legacy.Renderer).toBe('function'); // 0.3.2 fork API
  });

  it('DOMPurify loads via require and sanitizes with a jsdom window', () => {
    const createDOMPurify = require(path.join(ROOT, 'public/components/dompurify/purify.min.js'));
    const { JSDOM } = require('jsdom');
    const purifier = createDOMPurify(new JSDOM('').window);
    expect(purifier.sanitize('<img src=x onerror=alert(1)>')).not.toContain('onerror');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/markdown-modern-vendor.test.js --reporter=verbose`
Expected: FAIL — cannot find `public/components/marked-modern/marked-modern.js`

- [ ] **Step 3: Fetch and wrap the official builds**

```bash
mkdir -p public/components/marked-modern public/components/dompurify
curl -fsSL https://unpkg.com/marked@12.0.2/lib/marked.umd.js -o /tmp/marked.umd.js
curl -fsSL https://unpkg.com/dompurify@3.2.4/dist/purify.min.js -o public/components/dompurify/purify.min.js
```

Then build the wrapper (the official UMD would assign `window.marked`, colliding with the legacy fork; wrapping it captures its exports locally and republishes as `markedModern` / `module.exports`):

```bash
{
  cat <<'HEAD'
/* marked 12.0.2 — official lib/marked.umd.js, wrapped so it never touches
 * window.marked (owned by the legacy trinketapp fork). Loads as
 * `markedModern` in the browser, plain module.exports under require.
 * DO NOT EDIT the official body; to upgrade, re-run the wrap recipe in
 * docs/superpowers/plans/2026-08-15-markdown-engine-bridge.md Task 1. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.markedModern = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  var module = { exports: {} };
  var exports = module.exports;
HEAD
  cat /tmp/marked.umd.js
  cat <<'TAIL'
  return module.exports;
}));
TAIL
} > public/components/marked-modern/marked-modern.js
```

(The inner official UMD sees the local `module`/`exports` shadows and attaches its named exports there instead of the real globals.)

- [ ] **Step 4: Add jsdom to package.json dependencies**

In `package.json` `"dependencies"`, add (alphabetical position): `"jsdom": "^24.0.0",` then `npm install`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/markdown-modern-vendor.test.js --reporter=verbose`
Expected: PASS (both tests)

- [ ] **Step 6: Commit**

```bash
git add public/components/marked-modern public/components/dompurify package.json package-lock.json test/unit/markdown-modern-vendor.test.js
git commit -m "feat(markdown): vendor marked 12.0.2 (wrapped, no window.marked collision) and DOMPurify 3.2.4"
```

---

### Task 2: Modern module core — factory, GFM, highlight.js fences

**Files:**
- Create: `public/js/trinket-markdown-modern.js`
- Test: `test/unit/markdown-modern-core.test.js`

**Interfaces:**
- Consumes: Task 1's vendored modules.
- Produces: a UMD factory. Server: `require('<repo>/public/js/trinket-markdown-modern.js')` → `factory(markedModern, purifier, hljs, trinketConfig)` → `parse(src)` function returning sanitized HTML. Browser: `window.trinketMarkdownModern(markedModern, DOMPurify, hljs, trinketConfig)`. `trinketConfig` is the same adapter shape the legacy wrapper uses: `{ get(key), getUrl(path) }` with key `'apphostname'`, plus `getKnownHosts()` returning an array of hostnames (new, small: the server legacy wrapper computes known hosts from config internally; the modern module takes them injected so one file serves both sides).
- All later markdown tasks (3–5) extend THIS file and THIS test helper.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/markdown-modern-core.test.js
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');

// Shared builder — Tasks 3-5 import this from their own test files.
export function buildParser(overrides = {}) {
  const markedModern = require(path.join(ROOT, 'public/components/marked-modern/marked-modern.js'));
  const createDOMPurify = require(path.join(ROOT, 'public/components/dompurify/purify.min.js'));
  const { JSDOM } = require('jsdom');
  const hljs = require('highlight.js');
  const factory = require(path.join(ROOT, 'public/js/trinket-markdown-modern.js'));
  const trinketConfig = Object.assign({
    get: (k) => (k === 'apphostname' ? 'trinket.example.edu' : undefined),
    getUrl: (p) => 'https://trinket.example.edu' + p,
    getKnownHosts: () => ['trinket.example.edu', 'alias.example.edu']
  }, overrides);
  return factory(markedModern, createDOMPurify(new JSDOM('').window), hljs, trinketConfig);
}

describe('trinket-markdown-modern core', () => {
  it('renders GFM tables', () => {
    const html = buildParser()('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
  });

  it('renders GFM task lists with the checkbox surviving sanitization', () => {
    const html = buildParser()('- [x] done\n- [ ] todo');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked');
  });

  it('highlights fenced code with a known language via hljs', () => {
    const html = buildParser()('```python\nprint(1)\n```');
    expect(html).toContain('class="hljs"');
    expect(html).toContain('hljs-'); // token spans
  });

  it('renders unknown-language fences as plain code', () => {
    const html = buildParser()('```nosuchlang\nx\n```');
    expect(html).toContain('<code');
    expect(html).not.toContain('hljs-');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/markdown-modern-core.test.js --reporter=verbose`
Expected: FAIL — cannot find `public/js/trinket-markdown-modern.js`

- [ ] **Step 3: Write the module skeleton**

```js
// public/js/trinket-markdown-modern.js
/* Modern markdown engine: marked 12 + DOMPurify, GFM, per the
 * markdown-engine-bridge spec. Dependency-injected so ONE file serves the
 * server (require + jsdom DOMPurify) and the browser (script tag).
 * The legacy engine (trinket-markdown.js) is frozen and untouched. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory; }
  else { root.trinketMarkdownModern = factory; }
}(typeof self !== 'undefined' ? self : this, function (markedModern, purifier, hljs, trinketConfig) {

  var SANITIZE_PROFILE = { /* filled in Task 5; permissive default until then */ };

  function highlightCode(code, infostring) {
    var lang = (infostring || '').trim().split(/\s+/)[0];
    if (lang && hljs && hljs.getLanguage && hljs.getLanguage(lang)) {
      return '<pre><code class="hljs">' + hljs.highlight(lang, code).value + '</code></pre>';
    }
    return false; // fall through to marked's default code renderer
  }

  var renderer = {
    code: function (code, infostring, escaped) {
      return highlightCode(code, infostring);
    }
  };

  var engine = new markedModern.Marked({ gfm: true });
  engine.use({ renderer: renderer });

  return function parse(src) {
    var html = engine.parse(src || '');
    return purifier.sanitize(html, SANITIZE_PROFILE);
  };
}));
```

Note the UMD publishes the **factory itself** (`module.exports = factory`), matching how the test and later server code call it.

DOMPurify with an empty profile uses its safe defaults — which strip `<input>` `checked`/`type`? They do not: DOMPurify defaults allow `input` and those attributes, so the task-list test passes; the strict profile arrives in Task 5 and its tests re-verify task lists survive.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/markdown-modern-core.test.js --reporter=verbose`
Expected: PASS (4 tests)

- [ ] **Step 5: Verify the legacy path is untouched**

Run: `git diff --stat lib/shared/trinket-markdown.js public/js/trinket-markdown.js`
Expected: no output

- [ ] **Step 6: Commit**

```bash
git add public/js/trinket-markdown-modern.js test/unit/markdown-modern-core.test.js
git commit -m "feat(markdown): modern engine core — marked 12 factory, GFM, hljs fences"
```

---

### Task 3: Math pass-through extension

**Files:**
- Modify: `public/js/trinket-markdown-modern.js`
- Test: `test/unit/markdown-modern-math.test.js`

**Interfaces:**
- Consumes: `buildParser` from `test/unit/markdown-modern-core.test.js`.
- Produces: `$…$`, `$$…$$`, `\(…\)`, `\[…\]` spans reach the output verbatim (HTML-escaped only) so page-level MathJax can typeset them.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/markdown-modern-math.test.js
import { describe, it, expect } from 'vitest';
import { buildParser } from './markdown-modern-core.test.js';

describe('math pass-through', () => {
  const parse = buildParser();

  it('inline $..$ survives untouched — underscores must not become <em>', () => {
    const html = parse('the value $x_i + y_j$ matters');
    expect(html).toContain('$x_i + y_j$');
    expect(html).not.toContain('<em>');
  });

  it('display $$..$$ survives with backslashes intact', () => {
    const html = parse('$$\\frac{a}{b}$$');
    expect(html).toContain('$$\\frac{a}{b}$$');
  });

  it('\\(..\\) and \\[..\\] delimiters survive', () => {
    expect(parse('inline \\(a_1\\) math')).toContain('\\(a_1\\)');
    expect(parse('\\[E = mc^2\\]')).toContain('\\[E = mc^2\\]');
  });

  it('TeX containing < is HTML-escaped but textually intact', () => {
    const html = parse('$a < b$');
    expect(html).toContain('$a &lt; b$');
  });

  it('a lone $ price does not open a math span', () => {
    const html = parse('costs $5 and _emphasis_ still works');
    expect(html).toContain('<em>emphasis</em>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/markdown-modern-math.test.js --reporter=verbose`
Expected: FAIL — `$x_i + y_j$` mangled (`<em>` present) and/or backslashes eaten

- [ ] **Step 3: Implement the extension**

In `public/js/trinket-markdown-modern.js`, add above `var renderer =`:

```js
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // MathJax typesets the page AFTER markdown renders; our only job is to get
  // TeX through the parser un-chewed. Each extension captures a delimited
  // span and re-emits it verbatim (escaped), delimiters included.
  var mathExtensions = [
    { name: 'mathBlockDollar', level: 'block',
      start: function (src) { var i = src.indexOf('$$'); return i < 0 ? undefined : i; },
      tokenizer: function (src) {
        var m = /^\$\$([\s\S]+?)\$\$/.exec(src);
        if (m) { return { type: 'mathBlockDollar', raw: m[0], text: m[0] }; }
      },
      renderer: function (token) { return '<p>' + escapeHtml(token.text) + '</p>\n'; } },
    { name: 'mathBlockBracket', level: 'block',
      start: function (src) { var i = src.indexOf('\\['); return i < 0 ? undefined : i; },
      tokenizer: function (src) {
        var m = /^\\\[([\s\S]+?)\\\]/.exec(src);
        if (m) { return { type: 'mathBlockBracket', raw: m[0], text: m[0] }; }
      },
      renderer: function (token) { return '<p>' + escapeHtml(token.text) + '</p>\n'; } },
    { name: 'mathInlineDollar', level: 'inline',
      start: function (src) { var i = src.indexOf('$'); return i < 0 ? undefined : i; },
      tokenizer: function (src) {
        // single-$ inline math: no space just inside the delimiters, closing $
        // not followed by a digit (so "$5 and $6" is prices, not math)
        var m = /^\$(?!\s)((?:\\.|[^\\$])+?)(?<!\s)\$(?!\d)/.exec(src);
        if (m) { return { type: 'mathInlineDollar', raw: m[0], text: m[0] }; }
      },
      renderer: function (token) { return escapeHtml(token.text); } },
    { name: 'mathInlineParen', level: 'inline',
      start: function (src) { var i = src.indexOf('\\('); return i < 0 ? undefined : i; },
      tokenizer: function (src) {
        var m = /^\\\(([\s\S]+?)\\\)/.exec(src);
        if (m) { return { type: 'mathInlineParen', raw: m[0], text: m[0] }; }
      },
      renderer: function (token) { return escapeHtml(token.text); } }
  ];
```

And extend the `engine.use` call:

```js
  engine.use({ renderer: renderer, extensions: mathExtensions });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/markdown-modern-math.test.js --reporter=verbose`
Expected: PASS (5 tests). Also re-run core: `npx vitest run test/unit/markdown-modern-core.test.js` — still PASS.

- [ ] **Step 5: Commit**

```bash
git add public/js/trinket-markdown-modern.js test/unit/markdown-modern-math.test.js
git commit -m "feat(markdown): math pass-through extensions so MathJax receives TeX un-chewed"
```

---

### Task 4: Trinket code fences — parity with legacy

**Files:**
- Modify: `public/js/trinket-markdown-modern.js`
- Test: `test/unit/markdown-modern-trinket-fences.test.js`

**Interfaces:**
- Consumes: `buildParser`; the LEGACY module `lib/shared/trinket-markdown.js` (require'd read-only for parity comparison).
- Produces: `` ```<type>.<run|trinket|console>[:k=v,...] `` fences render the same `<iframe class="embedded-trinket">` contract as legacy (same src, same query params, same `#code=` payload).

**Reference:** the legacy behavior is `processCode` in `lib/shared/trinket-markdown.js` (~lines 268–330 on picup/main): types allowed for inline embeds are `['python','pyodide','python3','html','glowscript','java','R','pygame']`; args parse as `x=y` comma-separated with optional quotes; `?start=result` unless `autorun=false`; python/python3 `.console` appends `&runMode=console&outputOnly=true&runOption=console&leftMenu=true` and a trailing `\n` to the code; the code lands in `#code=<encodeURIComponent>` with `'` further encoded as `%27`; default attrs `width="100%" height="400"` plus `frameborder="0" marginwidth="0" marginheight="0" allowfullscreen`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/markdown-modern-trinket-fences.test.js
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildParser } from './markdown-modern-core.test.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');

function extractIframe(html) {
  const m = /<iframe[^>]*class="embedded-trinket"[^>]*>/.exec(html);
  return m && m[0];
}

describe('trinket code fences — parity with legacy', () => {
  const parse = buildParser();
  // legacy shared module builds its config from `config`; under vitest-setup
  // the test config resolves an app hostname, and parity below compares
  // structure (src path + params + payload), not hostname.
  const legacyParse = require(path.join(ROOT, 'lib/shared/trinket-markdown.js'))({});

  const FENCE = '```python3.trinket:height=500\nprint("hi")\n```';

  it('renders an embedded-trinket iframe with the legacy src contract', () => {
    const iframe = extractIframe(parse(FENCE));
    expect(iframe).toBeTruthy();
    expect(iframe).toContain('/embed/python3');
    expect(iframe).toContain('start=result');
    expect(iframe).toContain('height="500"');
    expect(iframe).toContain('#code=' + encodeURIComponent('print("hi")').replace(/'/g, '%27'));
  });

  it('matches legacy output structurally for the same fence', () => {
    const strip = (s) => s && s.replace(/src="https?:\/\/[^/]*/, 'src="');
    expect(strip(extractIframe(parse(FENCE)))).toBe(strip(extractIframe(legacyParse(FENCE))));
  });

  it('python3.console appends console params and trailing newline to the payload', () => {
    const iframe = extractIframe(parse('```python3.console\nx=1\n```'));
    expect(iframe).toContain('runMode=console');
    expect(iframe).toContain('outputOnly=true');
    expect(iframe).toContain('#code=' + encodeURIComponent('x=1\n'));
  });

  it('non-inlineable types fall through to normal code rendering', () => {
    const html = parse('```music.trinket\nnotes\n```');
    expect(html).not.toContain('embedded-trinket');
    expect(html).toContain('<code');
  });

  it('autorun=false drops start=result', () => {
    const iframe = extractIframe(parse('```python3.trinket:autorun=false\nx\n```'));
    expect(iframe).not.toContain('start=result');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/markdown-modern-trinket-fences.test.js --reporter=verbose`
Expected: FAIL — no `embedded-trinket` iframe in modern output

- [ ] **Step 3: Implement — port `processCode` into the modern renderer**

In `public/js/trinket-markdown-modern.js`, add above `var renderer =`:

```js
  var inline_trinkets = ['python', 'pyodide', 'python3', 'html', 'glowscript', 'java', 'R', 'pygame'];

  // Port of legacy processCode's trinket-fence branch. Output contract is
  // frozen: the parity tests compare it against lib/shared/trinket-markdown.js.
  function trinketFence(code, infostring) {
    var parts = /^([a-zA-Z0-9]+)\.((?:run|trinket|console))(?:\:(.*))?$/.exec((infostring || '').trim());
    var attrs = { width: '100%', height: '400' };
    var attrStr = '', url, arg;

    if (!parts || inline_trinkets.indexOf(parts[1]) === -1) { return false; }

    if (parts[3]) {
      while ((arg = /(\w+)=([^,]+)/.exec(parts[3]))) {
        attrs[arg[1]] = arg[2].replace(/^("|')|("|')$/g, '');
        parts[3] = parts[3].substr(arg[0].length);
      }
    }

    url = trinketConfig.getUrl('/embed/' + parts[1]);
    if (attrs.autorun !== 'false') { url = url + '?start=result'; }

    if ((parts[1] === 'python' || parts[1] === 'python3') && parts[2] === 'console') {
      url = url + '&runMode=console&outputOnly=true&runOption=console&leftMenu=true';
      code = code + '\n';
      if (parts[1] === 'python') { attrs.height = 300; }
    }

    for (var key in attrs) { attrStr += ' ' + key + '="' + attrs[key] + '"'; }

    url = (url + '#code=' + encodeURIComponent(code)).replace(/'/g, '%27');
    return '<iframe class="embedded-trinket" src="' + url + '"' + attrStr
         + ' frameborder="0" marginwidth="0" marginheight="0" allowfullscreen></iframe>';
  }
```

And change the renderer's `code` function:

```js
    code: function (code, infostring, escaped) {
      var embed = trinketFence(code, infostring);
      if (embed) { return embed; }
      return highlightCode(code, infostring);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/markdown-modern-trinket-fences.test.js --reporter=verbose`
Expected: PASS (5 tests). If the structural-parity test fails on attribute ordering, fix the modern port to emit in legacy's order (attrs object insertion order) — never adjust the legacy file.

- [ ] **Step 5: Commit**

```bash
git add public/js/trinket-markdown-modern.js test/unit/markdown-modern-trinket-fences.test.js
git commit -m "feat(markdown): trinket code-fence embeds in the modern engine, legacy-parity tested"
```

---

### Task 5: Embed URLs, image sizing, plotly + the DOMPurify profile

This task ports the remaining legacy renderer behavior (link/image embed conversion) and replaces the interim permissive sanitize with the strict profile — together, because the profile must whitelist exactly what the embed conversions emit.

**Files:**
- Modify: `public/js/trinket-markdown-modern.js`
- Test: `test/unit/markdown-modern-embeds.test.js`, `test/unit/markdown-modern-sanitize.test.js`

**Interfaces:**
- Consumes: `buildParser`.
- Produces: links/images matching the legacy `EMBED_URLS` table become iframes; `=WxH` image sizing; `![plotly](user:id)`; the final sanitize profile (`ALLOWED_TAGS`/`ALLOWED_ATTR` + `uponSanitizeAttribute` per-tag regexes + `uponSanitizeElement` iframe-src whitelist).

**Reference:** legacy `EMBED_URLS` table, `checkForEmbedUrl`, `processImage`, and `HTML_WHITELIST` in `lib/shared/trinket-markdown.js` (~lines 39–110, 91–170, 330–430 on picup/main). Lift the `EMBED_URLS` regex table and the iframe `src` regex list **verbatim** — do not re-derive them. Self-hosted trinket URLs use `trinketConfig.getKnownHosts()` (plus port handling as in legacy) instead of the server-only config read.

- [ ] **Step 1: Write the failing embed tests**

```js
// test/unit/markdown-modern-embeds.test.js
import { describe, it, expect } from 'vitest';
import { buildParser } from './markdown-modern-core.test.js';

describe('embed URL conversion', () => {
  const parse = buildParser();

  it('a YouTube link becomes an embed iframe', () => {
    const html = parse('[demo](https://www.youtube.com/watch?v=abc123)');
    expect(html).toContain('<iframe');
    expect(html).toContain('//www.youtube.com/embed/abc123');
  });

  it('a self-hosted trinket URL (known host) becomes an embedded-trinket iframe', () => {
    const html = parse('[t](https://alias.example.edu/embed/python3/deadbeef00)');
    expect(html).toContain('embedded-trinket');
    expect(html).toContain('/embed/python3/deadbeef00');
  });

  it('an ordinary link stays a link', () => {
    const html = parse('[site](https://example.org/page)');
    expect(html).toContain('<a');
    expect(html).toContain('href="https://example.org/page"');
  });

  it('image sizing =WxH emits width/height', () => {
    const html = parse('![alt](https://example.org/i.png =300x200)');
    expect(html).toContain('width="300"');
    expect(html).toContain('height="200"');
  });

  it('plotly image syntax emits the plotly iframe', () => {
    const html = parse('![plotly](someuser:42)');
    expect(html).toContain('plot.ly/~someuser/42');
  });

  it('a Vimeo image-style embed converts too', () => {
    const html = parse('![v](https://vimeo.com/12345)');
    expect(html).toContain('player.vimeo.com/video/12345');
  });
});
```

- [ ] **Step 2: Write the failing sanitizer tests**

```js
// test/unit/markdown-modern-sanitize.test.js
import { describe, it, expect } from 'vitest';
import { buildParser } from './markdown-modern-core.test.js';

describe('DOMPurify profile', () => {
  const parse = buildParser();

  it('strips script tags and event handlers', () => {
    expect(parse('<script>alert(1)</script>hello')).not.toContain('<script');
    expect(parse('<img src=x onerror=alert(1)>')).not.toContain('onerror');
  });

  it('strips javascript: hrefs', () => {
    expect(parse('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:');
  });

  it('keeps whitelisted inline HTML', () => {
    const html = parse('a <b class="note">bold</b> and <sup>sup</sup>');
    expect(html).toContain('<b class="note">bold</b>');
    expect(html).toContain('<sup>sup</sup>');
  });

  it('drops non-whitelisted attributes but keeps the tag', () => {
    const html = parse('<span class="ok" data-evil="x">t</span>');
    expect(html).toContain('<span class="ok">');
    expect(html).not.toContain('data-evil');
  });

  it('removes iframes whose src is not on the whitelist', () => {
    expect(parse('<iframe src="https://evil.example.com/x"></iframe>')).not.toContain('<iframe');
  });

  it('keeps whitelisted iframes (raw YouTube embed pasted as HTML)', () => {
    const html = parse('<iframe src="https://www.youtube.com/embed/abc" width="420" height="315"></iframe>');
    expect(html).toContain('<iframe');
    expect(html).toContain('youtube.com/embed/abc');
  });

  it('keeps our own generated trinket-fence iframes end to end', () => {
    const html = parse('```python3.trinket\nx=1\n```');
    expect(html).toContain('embedded-trinket');
  });

  it('GFM task-list checkboxes still survive the strict profile', () => {
    expect(parse('- [x] done')).toContain('type="checkbox"');
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run test/unit/markdown-modern-embeds.test.js test/unit/markdown-modern-sanitize.test.js --reporter=verbose`
Expected: embeds FAIL (links stay links); several sanitize tests FAIL (permissive default profile keeps `data-evil`, strips nothing it should… and has no iframe whitelist)

- [ ] **Step 4: Implement embeds + profile**

In `public/js/trinket-markdown-modern.js`:

1. Lift `EMBED_URLS` verbatim from the legacy file, with the self-hosted-trinket regex built from `trinketConfig.getKnownHosts()` (include `host:port` variants exactly as legacy does for non-80/443 ports).
2. Port `checkForEmbedUrl(href, title, text)` unchanged.
3. Add renderer overrides:

```js
    link: function (href, title, text) {
      var embed = checkForEmbedUrl(href, title, text);
      return embed || false; // false → marked's default link renderer
    },
    image: function (href, title, text) {
      return processImage(href, title, text); // port of legacy processImage;
      // returns false for the plain-image case so marked's default applies
    }
```

Port `processImage` from legacy (plotly branch, embed-URL branch, root-relative `getUrl` prefix, `=WxH` branch) with one change: where legacy falls through to `originalImage.call(this, ...)`, the modern port returns `false`.

4. Replace `SANITIZE_PROFILE` and add hooks after `purifier` is available:

```js
  // Port of legacy HTML_WHITELIST: same tags, same per-tag attribute regexes,
  // same iframe src whitelist — enforced with DOMPurify hooks instead of the
  // legacy regex scanner. GFM additions: input (task-list checkboxes).
  var CLASS_RE = /^[a-z\-\s]+$/;
  var ATTR_RULES = {
    /* every tag from legacy HTML_WHITELIST, verbatim, e.g.:
       a: { 'class': CLASS_RE, href: /^((https?\:)?\/\/|mailto\:)\S+$/i,
            title: /^[^"']+$/, target: /^_blank$/ },
       ol: { 'class': CLASS_RE, start: /^[0-9]+$/, type: /^[ai]$/i },
       img: { src: /^(https?\:)?\/\//i, alt: /.*/, title: /^[^"']+$/,
              width: /^\d+$/, height: /^\d+$/, style: /^[^<>]*$/ },
       iframe: { ...legacy iframe attr regexes... },
       input: { type: /^checkbox$/, checked: /^(checked|)$/, disabled: /^(disabled|)$/ },
       ...  */
  };
  var IFRAME_SRC_WHITELIST = [ /* legacy iframe src regex array, verbatim,
       plus the known-hosts /embed/ regex built from getKnownHosts() */ ];

  var SANITIZE_PROFILE = {
    ALLOWED_TAGS: Object.keys(ATTR_RULES).concat(['em', 'br']),
    ALLOWED_ATTR: (function () {
      var names = {};
      Object.keys(ATTR_RULES).forEach(function (t) {
        Object.keys(ATTR_RULES[t]).forEach(function (a) { names[a] = true; });
      });
      return Object.keys(names);
    })()
  };

  purifier.addHook('uponSanitizeAttribute', function (node, data) {
    var tag = node.nodeName.toLowerCase();
    var rules = ATTR_RULES[tag];
    if (!rules) { return; }
    var rule = rules[data.attrName];
    if (!rule) { data.keepAttr = false; return; }
    if (rule instanceof RegExp && !rule.test(data.attrValue)) { data.keepAttr = false; }
  });

  purifier.addHook('uponSanitizeElement', function (node, data) {
    if (data.tagName === 'iframe') {
      var src = node.getAttribute && node.getAttribute('src');
      var ok = false;
      for (var i = 0; src && i < IFRAME_SRC_WHITELIST.length; i++) {
        if (IFRAME_SRC_WHITELIST[i].test(src)) { ok = true; break; }
      }
      if (!ok && node.parentNode) { node.parentNode.removeChild(node); }
    }
  });
```

Note `image` renderer legacy `=WxH` output includes a `style` attribute — `img.style` is in `ATTR_RULES` above so it survives. The legacy `img` whitelist allowed only Google-drawings sources for *raw HTML* `<img>` — keep that strictness for raw HTML by matching legacy's `img.src` regex if you prefer exact parity, but markdown-generated `<img>` must survive: run the embeds tests to force the right balance (markdown images come from `processImage`/default renderer and must pass; the tests are the contract).

- [ ] **Step 5: Run all modern-markdown tests**

Run: `npx vitest run test/unit/markdown-modern-embeds.test.js test/unit/markdown-modern-sanitize.test.js test/unit/markdown-modern-core.test.js test/unit/markdown-modern-math.test.js test/unit/markdown-modern-trinket-fences.test.js`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add public/js/trinket-markdown-modern.js test/unit/markdown-modern-embeds.test.js test/unit/markdown-modern-sanitize.test.js
git commit -m "feat(markdown): embed URLs, image sizing, plotly + strict DOMPurify profile with iframe whitelist"
```

---

### Task 6: Course setting — model, validation, creation default, engine selector

**Files:**
- Create: `lib/shared/markdown-engine.js`
- Modify: `lib/models/course.js:30-34` (globalSettings schema)
- Modify: `config/api_routes.js:33-40` (POST /api/courses payload) and `config/api_routes.js:69-77` (PUT metadata payload)
- Modify: `lib/controllers/course.js:20-31` (createCourse)
- Modify: `config/default.yaml` (features block: `markdown.newCourseDefault`)
- Test: `test/unit/markdown-engine-selector.test.js`, `test/lib/api/course-markdown-engine.test.js`

**Interfaces:**
- Produces: `require('lib/shared/markdown-engine.js').engineFor(course)` → `'legacy' | 'modern'` (absent/anything-but-'modern' ⇒ `'legacy'`). `globalSettings.markdownEngine` accepted on create + metadata routes. Config key `config.features.markdown.newCourseDefault`.

- [ ] **Step 1: Write the failing selector unit test**

```js
// test/unit/markdown-engine-selector.test.js
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { engineFor } = require(path.resolve(__dirname, '../../lib/shared/markdown-engine.js'));

describe('engineFor', () => {
  it('absent settings mean legacy', () => {
    expect(engineFor(null)).toBe('legacy');
    expect(engineFor({})).toBe('legacy');
    expect(engineFor({ globalSettings: {} })).toBe('legacy');
  });
  it('only the exact string modern selects modern', () => {
    expect(engineFor({ globalSettings: { markdownEngine: 'modern' } })).toBe('modern');
    expect(engineFor({ globalSettings: { markdownEngine: 'Modern' } })).toBe('legacy');
    expect(engineFor({ globalSettings: { markdownEngine: 'legacy' } })).toBe('legacy');
  });
  it('works on plain objects and toObject-style documents', () => {
    const doc = { toObject: () => ({ globalSettings: { markdownEngine: 'modern' } }) };
    expect(engineFor(doc)).toBe('modern');
  });
});
```

- [ ] **Step 2: Run to verify it fails, then implement the selector**

Run: `npx vitest run test/unit/markdown-engine-selector.test.js` → FAIL (module missing). Then:

```js
// lib/shared/markdown-engine.js
// Single source of truth for which markdown engine a course uses.
// Absent/unknown => 'legacy' (existing courses are untouched by deploy alone).
function engineFor(course) {
  var gs = course && course.globalSettings;
  if (!gs && course && typeof course.toObject === 'function') {
    gs = course.toObject().globalSettings;
  }
  return gs && gs.markdownEngine === 'modern' ? 'modern' : 'legacy';
}
module.exports = { engineFor: engineFor };
```

Re-run → PASS.

- [ ] **Step 3: Write the failing API test (both backends)**

Model it on an existing `test/lib/api/*.test.js` file — copy that file's imports/setup helpers (the `flow` helper and login pattern) exactly; the suite runs against Mongo by default and Firestore under `TEST_DB_BACKEND=firestore`.

```js
// test/lib/api/course-markdown-engine.test.js  (adapt setup to the existing pattern)
// Cases:
// 1. POST /api/courses with no markdownEngine → created course has
//    globalSettings.markdownEngine === config.features.markdown.newCourseDefault
//    (the test config ships 'modern').
// 2. POST /api/courses with markdownEngine:'legacy' → stays 'legacy'.
// 3. POST /api/courses with markdownEngine:'bogus' → 400 (Joi).
// 4. PUT /api/courses/{id}/metadata with markdownEngine:'modern' → persisted.
// 5. PUT metadata omitting markdownEngine → course falls back to 'legacy'
//    (documents the setGlobalSettings reset semantics — safe direction).
```

Write the five cases fully, following the neighboring file's request/assert idioms.

- [ ] **Step 4: Run to verify it fails, then implement**

Run: `npx vitest run test/lib/api/course-markdown-engine.test.js` → FAIL (400s / missing field).

1. `lib/models/course.js` globalSettings block — add:

```js
        markdownEngine : { type: String, enum: ['legacy', 'modern'], default: 'legacy' }
```

2. `config/api_routes.js` — add to BOTH course payload validations:

```js
          markdownEngine : Joi.string().valid('legacy', 'modern').optional(),
```

3. `lib/controllers/course.js` `createCourse` — after `course.setGlobalSettings(request.payload);`:

```js
    // New-course default comes from config, not the schema — the bridge's
    // policy knob (spec: markdown-engine-bridge). Explicit payload wins.
    if (!request.payload.markdownEngine) {
      var mdDefault = config.features && config.features.markdown
        && config.features.markdown.newCourseDefault;
      course.globalSettings.markdownEngine = mdDefault === 'modern' ? 'modern' : 'legacy';
    }
```

(`config` is already required in that file; verify, and add the require if not.)

4. `config/default.yaml` — in the `features:` block:

```yaml
  markdown:
    # Engine for NEWLY CREATED courses: legacy | modern. Existing courses keep
    # whatever they have (absent = legacy). See docs/superpowers/specs/
    # 2026-08-15-markdown-engine-bridge-design.md.
    newCourseDefault: modern
```

- [ ] **Step 5: Run both suites, both backends**

Run: `npx vitest run test/unit/markdown-engine-selector.test.js test/lib/api/course-markdown-engine.test.js`
Then the Firestore leg per the project's documented recipe (container/emulator — see `test/helpers/vitest-setup.cjs` header comments): `TEST_DB_BACKEND=firestore npx vitest run test/lib/api/course-markdown-engine.test.js`
Expected: PASS on both.

- [ ] **Step 6: Commit**

```bash
git add lib/shared/markdown-engine.js lib/models/course.js config/api_routes.js lib/controllers/course.js config/default.yaml test/unit/markdown-engine-selector.test.js test/lib/api/course-markdown-engine.test.js
git commit -m "feat(courses): markdownEngine setting — model, validation, config-driven creation default"
```

---

### Task 7: Client threading — service dispatch, four call sites, Edit Course dropdown

**Files:**
- Modify: `public/js/services/markdown.js`
- Modify: `public/js/courseEditor/controllers/root.js` (parser at ~16, courseForm at ~173-177, updateCourse payload)
- Modify: `public/js/courseEditor/controllers/materialControl.js:28`
- Modify: `public/js/courseEditor/controllers/dashboardControl.js:9-12`
- Modify: `public/js/classPage/app.js:25`
- Modify: `public/partials/course_editor.html` (~line 277, after the contentDefault select)
- Modify: `config/default.yaml` `jsbody` list (after the `/components/marked/lib/marked.js` entry)
- Test: `test/unit/markdown-service-dispatch.test.js`

**Interfaces:**
- Consumes: `window.trinketMarkdownModern` (Task 2), `globalSettings.markdownEngine` (Task 6).
- Produces: `markdownParser(options)` accepts `options.engine` — a string or a zero-arg function evaluated **per parse call** (late-bound: the course document loads asynchronously after controllers construct their parsers).

- [ ] **Step 1: Write the failing service test**

```js
// test/unit/markdown-service-dispatch.test.js
// The service file is a browser IIFE; load it in a vm sandbox with stub
// globals and assert the dispatch logic.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function loadService() {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../public/js/services/markdown.js'), 'utf8');
  let factoryFn;
  const sandbox = {
    window: {},
    trinketMarkdown: (opts) => (md) => 'LEGACY:' + md,
    trinketMarkdownModern: undefined, // injected per test below
    angular: {
      module: () => ({ factory: (name, arr) => { factoryFn = arr[arr.length - 1]; } }),
      extend: Object.assign
    }
  };
  sandbox.window.angular = sandbox.angular;
  vm.runInNewContext(src, sandbox);
  return { sandbox, makeParser: () => factoryFn({ get: () => 'host' }) };
}

describe('markdownParser engine dispatch', () => {
  it('defaults to legacy when no engine option is given', () => {
    const { makeParser } = loadService();
    expect(makeParser()({})('hi')).toBe('LEGACY:hi');
  });

  it('uses the modern engine when engine resolves to modern', () => {
    const { sandbox, makeParser } = loadService();
    sandbox.trinketMarkdownModern = () => (md) => 'MODERN:' + md;
    expect(makeParser()({ engine: 'modern' })('hi')).toBe('MODERN:hi');
  });

  it('evaluates a function engine per call (late binding)', () => {
    const { sandbox, makeParser } = loadService();
    sandbox.trinketMarkdownModern = () => (md) => 'MODERN:' + md;
    let current = 'legacy';
    const parse = makeParser()({ engine: () => current });
    expect(parse('a')).toBe('LEGACY:a');
    current = 'modern';
    expect(parse('a')).toBe('MODERN:a');
  });

  it('falls back to legacy if the modern global is missing', () => {
    const { makeParser } = loadService();
    expect(makeParser()({ engine: 'modern' })('hi')).toBe('LEGACY:hi');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/markdown-service-dispatch.test.js` → FAIL (engine option ignored; note the current service body also references `trinketMarkdown` at parse-construction — the test pins the NEW contract)

- [ ] **Step 3: Rewrite the service**

```js
// public/js/services/markdown.js
(function(angular) {
  angular.module('trinket.markdown', ['trinket.config'])
    .factory('markdownParser', ['trinketConfig', function(trinketConfig) {
      return function(options) {
        options = angular.extend({}, options);

        var legacyParse = trinketMarkdown(options);
        // Modern engine (markdown-engine-bridge). `engine` may be a string or
        // a function evaluated per call — the course document arrives async,
        // after controllers build their parsers.
        var modernParse;
        function modern() {
          if (!modernParse) {
            if (typeof trinketMarkdownModern === 'undefined' || typeof markedModern === 'undefined'
                || typeof DOMPurify === 'undefined') {
              return legacyParse; // scripts absent on this page: safe fallback
            }
            var cfg = angular.extend({
              getKnownHosts: function() { return [trinketConfig.get('apphostname')]; }
            }, trinketConfig);
            modernParse = trinketMarkdownModern(markedModern, DOMPurify, window.hljs, cfg);
          }
          return modernParse;
        }

        return function(md) {
          var engine = typeof options.engine === 'function' ? options.engine() : options.engine;
          return (engine === 'modern' ? modern() : legacyParse)(md);
        };
      }
    }]);
})(window.angular);
```

(The vm test stubs `trinketMarkdownModern` as a 0-arg-tolerant function and leaves `markedModern`/`DOMPurify` undefined — add `markedModern: {}, DOMPurify: {}` to the sandbox in the modern-engine tests so the guard passes; adjust the test file accordingly when wiring this up. The "falls back" test keeps `trinketMarkdownModern` undefined.)

- [ ] **Step 4: Thread the engine through the four call sites**

Each gets the same late-bound option. The controllers' `$scope` prototypally inherits `course` from the root/app scope once loaded.

`public/js/courseEditor/controllers/root.js` (~16), `materialControl.js` (28), `dashboardControl.js` (~9), `classPage/app.js` (25) — add to the existing options object:

```js
      engine : function() {
        return ($scope.course && $scope.course.globalSettings
                && $scope.course.globalSettings.markdownEngine) || 'legacy';
      },
```

(In `root.js` and `materialControl.js` the scope variable is `self.$scope` / `this.$scope` at those construction points — match the file's local name.)

- [ ] **Step 5: Edit Course form + payload**

`public/js/courseEditor/controllers/root.js` courseForm init (~173-177) — add:

```js
            markdownEngine : (course.globalSettings && course.globalSettings.markdownEngine) || 'legacy'
```

⚠️ The metadata PUT resets omitted globalSettings to schema defaults (`setGlobalSettings`), so the form must ALWAYS send `markdownEngine` — that is what this line guarantees.

`public/partials/course_editor.html`, after the `contentDefault` select block (~line 277-280), following the exact markup pattern of its neighbors:

```html
      <label>Markdown Rendering
        <select name="markdownEngine" ng-model="courseForm.markdownEngine" ng-options="o.id as o.name for o in [{'id':'modern','name':'Modern (GitHub-style) — recommended for new content'},{'id':'legacy','name':'Legacy — original trinket rendering'}]">
        </select>
      </label>
```

- [ ] **Step 6: Load the modern scripts globally**

`config/default.yaml`, in the `jsbody` list, immediately after `- '/components/marked/lib/marked.js'`:

```yaml
      - '/components/marked-modern/marked-modern.js'
      - '/components/dompurify/purify.min.js'
      - '/js/trinket-markdown-modern.js'
```

(Same placement logic as legacy marked: `jsbody` reaches every `base.html` page — course editor, course view, class page. Embed pages hardcode their own scripts and stay legacy-only.)

- [ ] **Step 7: Run the service test and the full unit directory**

Run: `npx vitest run test/unit/ --reporter=verbose`
Expected: ALL PASS (including every pre-existing test — `course-editor-menu.test.js` and friends must not regress)

- [ ] **Step 8: Commit**

```bash
git add public/js/services/markdown.js public/js/courseEditor/controllers/root.js public/js/courseEditor/controllers/materialControl.js public/js/courseEditor/controllers/dashboardControl.js public/js/classPage/app.js public/partials/course_editor.html config/default.yaml test/unit/markdown-service-dispatch.test.js
git commit -m "feat(markdown): thread per-course engine through the client — service dispatch, 4 call sites, Edit Course dropdown"
```

---

### Task 8: Server threading — course download/export selects by course

**Files:**
- Modify: `lib/controllers/courses.js` (module head ~line 13; `parser(info.content)` call ~line 285)
- Test: `test/unit/markdown-server-select.test.js`

**Interfaces:**
- Consumes: `engineFor` (Task 6), modern module server require (Task 2).

- [ ] **Step 1: Write the failing test**

```js
// test/unit/markdown-server-select.test.js
// courses.js builds its parsers at module load; expose the selection seam as
// a small exported helper so it is testable without HTTP plumbing.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parserFor } = require(path.resolve(__dirname, '../../lib/controllers/courses.js'));

describe('server-side parser selection', () => {
  it('legacy course (absent setting) gets the legacy parser', () => {
    const html = parserFor({})('*hi*');
    expect(html).toContain('<em>hi</em>');
  });
  it('modern course gets the modern parser (task list proves GFM)', () => {
    const html = parserFor({ globalSettings: { markdownEngine: 'modern' } })('- [x] d');
    expect(html).toContain('type="checkbox"');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/markdown-server-select.test.js` → FAIL (`parserFor` not exported)

- [ ] **Step 3: Implement**

In `lib/controllers/courses.js`, at the module head (near the existing `parser` line 13):

```js
var engineFor    = require('../shared/markdown-engine.js').engineFor,
    markedModern = require('../../public/components/marked-modern/marked-modern.js'),
    createDOMPurify = require('../../public/components/dompurify/purify.min.js'),
    JSDOM        = require('jsdom').JSDOM,
    hljs         = require('highlight.js');

var modernParser = require('../../public/js/trinket-markdown-modern.js')(
  markedModern,
  createDOMPurify(new JSDOM('').window),
  hljs,
  {
    get    : function(key) { return key === 'apphostname' ? config.app.url.hostname : undefined; },
    getUrl : function(path) { return config.app.url.protocol + '://' + config.app.url.hostname + path; },
    getKnownHosts : function() {
      return [config.app.url.hostname].concat(
        (config.app.url.knownHosts || []).filter(function(h) { return h !== config.app.url.hostname; }));
    }
  }
);

function parserFor(course) {
  return engineFor(course) === 'modern' ? modernParser : parser;
}
```

Change the call at ~line 285 from `parser(info.content)` to `parserFor(fullCourse)(info.content)` (the enclosing function has `fullCourse` in scope — verify the local name at the call site and use it).

Add `parserFor : parserFor` to the module's exports object (alongside the existing exported handlers).

- [ ] **Step 4: Run the test + the api suite it may disturb**

Run: `npx vitest run test/unit/markdown-server-select.test.js test/lib/api/` (module-load additions must not break controller loading)
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/controllers/courses.js test/unit/markdown-server-select.test.js
git commit -m "feat(markdown): course export renders with the course's chosen engine"
```

---

### Task 9: Corpus diff script — report mode

**Files:**
- Create: `scripts/markdown-engine-diff.js`
- Create: `lib/shared/html-normalize.js`
- Test: `test/unit/html-normalize.test.js`

**Interfaces:**
- Consumes: both engines (legacy via `lib/shared/trinket-markdown.js`, modern via Task 8's construction pattern), `jsdom`.
- Produces: `normalizeHtml(html)` → canonical string (tags lowercased by DOM parsing, attributes sorted, inter-tag whitespace collapsed); the CLI `node scripts/markdown-engine-diff.js report [--course <idOrSlug>] [--json <outfile>]`.

- [ ] **Step 1: Write the failing normalize test**

```js
// test/unit/html-normalize.test.js
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeHtml } = require(path.resolve(__dirname, '../../lib/shared/html-normalize.js'));

describe('normalizeHtml', () => {
  it('ignores attribute order', () => {
    expect(normalizeHtml('<a href="x" title="t">y</a>'))
      .toBe(normalizeHtml('<a title="t" href="x">y</a>'));
  });
  it('ignores whitespace between block tags', () => {
    expect(normalizeHtml('<p>a</p>\n\n  <p>b</p>'))
      .toBe(normalizeHtml('<p>a</p><p>b</p>'));
  });
  it('preserves meaningful text differences', () => {
    expect(normalizeHtml('<p>a b</p>')).not.toBe(normalizeHtml('<p>ab</p>'));
  });
  it('preserves attribute value differences', () => {
    expect(normalizeHtml('<iframe src="a">')).not.toBe(normalizeHtml('<iframe src="b">'));
  });
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

```js
// lib/shared/html-normalize.js
// Canonical HTML for engine-output comparison: parse with jsdom, emit tags
// with sorted attributes, collapse inter-element whitespace, keep text intact.
var JSDOM = require('jsdom').JSDOM;

function serialize(node, out) {
  if (node.nodeType === 3) { // text
    var t = node.textContent.replace(/\s+/g, ' ');
    if (t !== ' ' || (node.previousSibling && node.nextSibling)) { out.push(t); }
    return;
  }
  if (node.nodeType !== 1) { return; }
  var tag = node.tagName.toLowerCase();
  var attrs = Array.prototype.slice.call(node.attributes)
    .map(function(a) { return a.name + '="' + a.value + '"'; })
    .sort();
  out.push('<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>');
  for (var c = node.firstChild; c; c = c.nextSibling) { serialize(c, out); }
  out.push('</' + tag + '>');
}

function normalizeHtml(html) {
  var body = new JSDOM('<body>' + (html || '') + '</body>').window.document.body;
  var out = [];
  for (var c = body.firstChild; c; c = c.nextSibling) { serialize(c, out); }
  return out.join('').trim();
}

module.exports = { normalizeHtml: normalizeHtml };
```

Run: `npx vitest run test/unit/html-normalize.test.js` → PASS (iterate on the whitespace rule until all four pass — the tests are the contract).

- [ ] **Step 3: Write the CLI**

```js
// scripts/markdown-engine-diff.js
// Usage: node scripts/markdown-engine-diff.js report [--course <idOrSlug>] [--json out.json]
// Renders every course material through BOTH engines and reports real
// rendering differences (after normalizeHtml). This is the evidence tool the
// migration conversation runs on — see the markdown-engine-bridge spec.
```

Implementation notes (follow, don't improvise):
- `require('config')` first (the script honors `NODE_ENV`/`TRINKET_DEPLOY` like the app).
- Build both parsers exactly as `lib/controllers/courses.js` does (legacy `require('../lib/shared/trinket-markdown.js')({})`, modern via the Task 8 construction).
- Load courses + materials the same way the download path in `lib/controllers/courses.js` does — read that controller's course-population code and reuse its approach (Course model + lessons/materials population). `--course` filters by id or slug; default is all non-archived courses.
- For each material with non-empty content: `normalizeHtml(legacy(content)) === normalizeHtml(modern(content))` → identical; else record `{ courseSlug, courseName, ownerSlug, lessonSlug, materialSlug, engineSetting }`.
- Output: human summary to stdout — total materials, identical count, differing count, differing grouped by course with owner — and, with `--json`, the full record list to the file.
- Exit 0 always (a report, not a gate); exit 1 only on operational failure (DB unreachable).

- [ ] **Step 4: Smoke-run against the local dev DB**

Run: `node scripts/markdown-engine-diff.js report` with the local dev config (whatever backend the dev environment has seeded — even an empty DB proves the plumbing: it should print `0 materials`).
Expected: clean run, sane summary, no stack trace.

- [ ] **Step 5: Commit**

```bash
git add scripts/markdown-engine-diff.js lib/shared/html-normalize.js test/unit/html-normalize.test.js
git commit -m "feat(markdown): engine-diff report script + normalized HTML comparison"
```

---

### Task 10: Full-suite verification and the frozen-legacy proof

**Files:**
- None new (fixes only if the suite surfaces regressions)

- [ ] **Step 1: Full suite, Mongo profile**

Run: `npm test`
Expected: everything green (baseline before this branch was green; any new failure is ours).

- [ ] **Step 2: Full suite, Firestore profile**

Run per the project's documented container/emulator recipe (`test/helpers/vitest-setup.cjs` header): `TEST_DB_BACKEND=firestore npm test`
Expected: green, same skips as baseline.

- [ ] **Step 3: The frozen-legacy proof**

Run: `git diff --stat picup/main -- lib/shared/trinket-markdown.js public/js/trinket-markdown.js package.json`
Expected: only `package.json` appears (jsdom line); the two legacy wrappers show NO diff. Also confirm `grep -c marked package.json` shows the `marked` dependency line unchanged (still the trinketapp fork URL).

- [ ] **Step 4: Commit any stragglers and stop**

The branch is now PR-ready. The PR description (drafted at review time, not in this plan) must pose the five migration-policy questions from the spec's "The PR conversation" section.

---

## Self-review notes

- **Spec coverage:** engines (T1-5), setting+default+UI+threading (T6-8), diff report (T9), frozen legacy (global constraint + T10). Stage-2 (`classify`/`autofix`) is explicitly out of scope per the spec's staging.
- **Known judgment point (T5):** legacy's raw-HTML `<img>` whitelist (Google-drawings only) vs markdown-generated images — the tests define the required balance; the reviewer should check the implementer's choice matches legacy behavior for raw HTML while keeping markdown images working.
- **Known judgment point (T7 Step 3):** the service test's sandbox needs `markedModern`/`DOMPurify` stubs once the guard exists; the task text says so — implementer adjusts the test alongside, keeping the four behaviors pinned.
- **Type consistency:** `engineFor(course)` (T6) consumed in T8; `trinketConfig.getKnownHosts()` defined T2, used T5/T7/T8; `normalizeHtml` defined and consumed in T9; factory signature `(markedModern, purifier, hljs, trinketConfig)` consistent across T2/T7/T8/T9.
