// Pure helpers for the markdown engine-diff report (scripts/markdown-engine-diff.js).
//
// A report that says only "these 40 materials render differently" cannot be
// acted on — every one has to be opened by hand to find out whether the
// difference is a heading id or a vanished image. These helpers locate the
// first place two normalized HTML outputs diverge and cut a bounded, aligned
// excerpt around it, so the report itself carries the evidence.
//
// Kept in its own module (no config, no DB, no marked/DOMPurify) so it is
// unit-testable without loading the app.

var DEFAULT_WIDTH  = 200; // characters of each side's excerpt
var LEAD_CONTEXT   = 40;  // characters shown BEFORE the divergence, for context

// Index of the first differing character, or -1 when the strings are equal.
// A pure prefix counts as diverging at the end of the shorter string.
function firstDivergenceIndex(a, b) {
  a = a == null ? '' : String(a);
  b = b == null ? '' : String(b);
  if (a === b) { return -1; }
  var max = Math.min(a.length, b.length);
  for (var i = 0; i < max; i++) {
    if (a.charAt(i) !== b.charAt(i)) { return i; }
  }
  return max;
}

// { index, legacy, modern } — index is the first divergence (-1 if identical),
// legacy/modern are the same window of each string so the two excerpts line up
// and can be read side by side. Elisions are marked with a leading/trailing
// ellipsis so a truncated excerpt is never mistaken for the whole output.
function excerptAround(legacy, modern, width) {
  legacy = legacy == null ? '' : String(legacy);
  modern = modern == null ? '' : String(modern);
  width = width > 0 ? width : DEFAULT_WIDTH;

  // Lead context is capped at a quarter of the window, so the divergence
  // itself is always inside the excerpt even when a narrow width is asked for.
  var lead  = Math.min(LEAD_CONTEXT, Math.floor(width / 4));
  var index = firstDivergenceIndex(legacy, modern);
  var start = index < 0 ? 0 : Math.max(0, index - lead);

  function cut(s) {
    var piece = s.slice(start, start + width);
    return (start > 0 ? '…' : '')
         + piece
         + (start + width < s.length ? '…' : '');
  }

  return { index : index, legacy : cut(legacy), modern : cut(modern) };
}

module.exports = {
  firstDivergenceIndex : firstDivergenceIndex,
  excerptAround        : excerptAround,
  DEFAULT_WIDTH        : DEFAULT_WIDTH
};
