(function(root) {
  'use strict';

  // #108: is this REPL input a COMPLETE statement, or should the prompt keep
  // reading?
  //
  // The main-thread REPL asks Python itself (codeop.compile_command), which is
  // exact. That is not available when the interpreter lives in the worker:
  // jq-console's continuation callback must answer SYNCHRONOUSLY, and a round
  // trip to the worker cannot. So this is a deliberate approximation of
  // CPython's rule, kept pure so every case can be pinned down in node.
  //
  // It errs toward COMPLETE. Submitting a statement Python then rejects shows
  // the student a SyntaxError they can read and retry; wrongly continuing hangs
  // the prompt at `...` with no way out but a blank line, which reads as a
  // freeze.

  // Walk the source tracking string and bracket state. Returns
  // { depth, inString, escaped } describing where the scan ended.
  function scanState(src) {
    var depth = 0;
    var quote = null;        // "'", '"', "'''" or '"""'
    var i = 0;
    var text = String(src || '');

    while (i < text.length) {
      var ch = text.charAt(i);

      if (quote) {
        if (ch === '\\') { i += 2; continue; }          // escape inside a string
        if (text.substr(i, quote.length) === quote) { i += quote.length; quote = null; continue; }
        // A single-quoted string cannot span lines: an unterminated one ends at
        // the newline and is Python's problem, not a continuation.
        if (quote.length === 1 && ch === '\n') { quote = null; i++; continue; }
        i++;
        continue;
      }

      if (ch === '#') {                                  // comment to end of line
        while (i < text.length && text.charAt(i) !== '\n') { i++; }
        continue;
      }

      if (ch === "'" || ch === '"') {
        var triple = text.substr(i, 3);
        if (triple === "'''" || triple === '"""') { quote = triple; i += 3; continue; }
        quote = ch; i++; continue;
      }

      if (ch === '(' || ch === '[' || ch === '{') { depth++; i++; continue; }
      if (ch === ')' || ch === ']' || ch === '}') { depth--; i++; continue; }

      i++;
    }

    // Only triple quotes span lines. A single-quoted string still open at END OF
    // INPUT is unterminated — Python rejects it outright, so submitting shows the
    // student a SyntaxError instead of hanging the prompt at `...`.
    return {
      depth: depth,
      inString: !!quote && quote.length === 3,
      unterminated: !!quote && quote.length === 1
    };
  }

  // Statements that open a suite. At the REPL these are only finished by a blank
  // line, however they are written.
  var COMPOUND_START =
    /^\s*(if|elif|else|for|while|try|except|finally|with|def|class|async\s+def|async\s+for|async\s+with|match|case)\b/;

  function isComplete(src) {
    var text = String(src || '');
    if (!text.trim()) return true;                       // blank line: submit

    var lines = text.split('\n');
    var last  = lines[lines.length - 1];

    // CPython's rule: inside a block, a BLANK line ends it. Without this a suite
    // can always be extended, so the prompt would sit at `...` forever.
    if (lines.length > 1 && !last.trim()) return true;

    var state = scanState(text);

    // Checked BEFORE the bracket rule: `print("helo` leaves both a bracket and a
    // string open, and the string is the fatal one. Continuing would wait for a
    // close that Python would reject anyway.
    if (state.unterminated) return true;

    if (state.inString) return false;                    // open triple-quote
    if (state.depth > 0) return false;                   // open bracket

    // Explicit line continuation.
    if (/\\$/.test(last)) return false;

    // A trailing colon opens a suite: def/if/for/while/class/try/with/else/elif.
    var lastCode = last.replace(/#.*$/, '').replace(/\s+$/, '');
    if (/:$/.test(lastCode)) return false;

    // A COMPOUND statement always needs a terminating blank line at the prompt,
    // even written on one line. CPython:
    //
    //     >>> while True: pass
    //     ...
    //
    // Without this rule `while True: pass` is submitted as if finished, and
    // Python answers "incomplete" — which looked like the statement had run and
    // returned instantly.
    if (COMPOUND_START.test(lines[0])) return false;

    // Already inside a suite (the first line opened one and we are indented):
    // keep reading until a blank line, as above.
    if (lines.length > 1) {
      var firstCode = lines[0].replace(/#.*$/, '').replace(/\s+$/, '');
      if (/:$/.test(firstCode) && /^\s+\S/.test(last)) return false;
    }

    return true;
  }

  // How far to indent the continuation line. jq-console takes an indent LEVEL,
  // not a character count — returning the measured width makes each line deeper
  // than the last.
  function indentLevel(src) {
    var lines = String(src || '').split('\n');
    var last  = lines[lines.length - 1].replace(/#.*$/, '').replace(/\s+$/, '');
    return /:$/.test(last) ? 1 : 0;
  }

  var api = { isComplete: isComplete, indentLevel: indentLevel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.TrinketIO && root.TrinketIO.export) root.TrinketIO.export('embed.replContinuation', api);
})(typeof window !== 'undefined' ? window : this);
