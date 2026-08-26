import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildParser } from './markdown-modern-core.test.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');
const { JSDOM } = require('jsdom');

function extractIframe(html) {
  const m = /<iframe[^>]*class="embedded-trinket"[^>]*>/.exec(html);
  return m && m[0];
}

// Structural comparison, not byte equality: fence output now flows through
// DOMPurify like everything else in the document, and a DOM parse/reserialize
// round-trip is not byte-preserving (it may reorder attributes on elements it
// otherwise leaves untouched, and it renders bare boolean attributes like
// `allowfullscreen` as `allowfullscreen=""`). What the spec actually promises
// is the src contract — same tag, same src (host aside), same attribute
// name/value set — not identical serialization.
function iframeAttrs(html) {
  const doc = new JSDOM(html).window.document;
  const el = doc.querySelector('iframe.embedded-trinket');
  if (!el) { return null; }
  const attrs = {};
  for (const a of el.attributes) {
    // Boolean attributes compare as present-vs-present: legacy emits bare
    // `allowfullscreen`, a sanitized DOM always serializes it as `="\"\""`.
    attrs[a.name] = a.name === 'allowfullscreen' ? true : a.value;
  }
  return attrs;
}

function stripHost(src) {
  return src && src.replace(/^https?:\/\/[^/]*/, '');
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

  it('matches legacy output structurally for the same fence (attribute set/values, order-independent)', () => {
    const modernAttrs = iframeAttrs(parse(FENCE));
    const legacyAttrs = iframeAttrs(legacyParse(FENCE));
    expect(modernAttrs).toBeTruthy();
    expect(legacyAttrs).toBeTruthy();
    expect({ ...modernAttrs, src: stripHost(modernAttrs.src) })
      .toEqual({ ...legacyAttrs, src: stripHost(legacyAttrs.src) });
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

  it('neutralizes attribute injection through a crafted fence arg', () => {
    const html = parse('```python3.trinket:height=400"onload="alert(1)\ncode\n```');
    expect(html).not.toContain('onload');
  });
});
