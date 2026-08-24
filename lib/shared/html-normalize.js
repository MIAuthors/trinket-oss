// Canonical HTML for engine-output comparison: parse with jsdom, emit tags
// with sorted attributes, collapse inter-element whitespace, keep text intact.
// Whitespace INSIDE <pre>/<code>/<textarea> is rendering-significant (code
// samples, indentation) and is therefore never collapsed or dropped, even
// when it's the only content of a text node — that's exactly the class of
// diff (hljs/marked whitespace handling) this comparison exists to catch.
var JSDOM = require('jsdom').JSDOM;

var WHITESPACE_SIGNIFICANT = { pre: true, code: true, textarea: true };

function serialize(node, out, verbatim) {
  if (node.nodeType === 3) { // text
    if (verbatim) { out.push(node.textContent); return; }
    var t = node.textContent.replace(/\s+/g, ' ');
    if (t.trim() !== '') { out.push(t); } // drop whitespace-only inter-tag gaps
    return;
  }
  if (node.nodeType !== 1) { return; }
  var tag = node.tagName.toLowerCase();
  var attrs = Array.prototype.slice.call(node.attributes)
    .map(function(a) { return a.name + '="' + a.value + '"'; })
    .sort();
  var childVerbatim = verbatim || WHITESPACE_SIGNIFICANT[tag] === true;
  out.push('<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>');
  for (var c = node.firstChild; c; c = c.nextSibling) { serialize(c, out, childVerbatim); }
  out.push('</' + tag + '>');
}

function normalizeHtml(html) {
  var body = new JSDOM('<body>' + (html || '') + '</body>').window.document.body;
  var out = [];
  for (var c = body.firstChild; c; c = c.nextSibling) { serialize(c, out, false); }
  return out.join('').trim();
}

module.exports = { normalizeHtml: normalizeHtml };
