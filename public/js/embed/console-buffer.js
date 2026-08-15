(function(root) {
  'use strict';

  // #142: the accounting behind console output buffering.
  //
  // pydoc's plain_pager hands `help(numpy)` to stdout as ONE 2.45 MB write, and
  // Pyodide's batched stdout flushes on every newline — so the console took
  // 70,605 separate writes. Each jqconsole.Write appends a span and then calls
  // _ScrollToEnd, which READS scrollHeight and .position() before writing back:
  // a forced layout per line, against a container growing to 70k children. The
  // cost is superlinear and entirely synchronous on the main thread, so the page
  // stops painting and Stop can never fire.
  //
  // Two guards live here, both general — the trigger is output VOLUME, not
  // help(). Any program printing tens of thousands of lines hits the same wall:
  //
  //   1. Queue, so the caller can append once per frame instead of once per
  //      line. Coalescing is what turns N reflows into one.
  //   2. Cap, because coalescing alone still lets a big enough program build a
  //      DOM the browser cannot lay out. Past maxLines, stream text is dropped
  //      and a notice is queued once. The PROGRAM keeps running; only the
  //      rendering stops.
  //
  // Kept pure — no DOM, no timers — so the rules are testable in node. The
  // caller owns flushing and the actual write.

  // System text (loader notices, '[stopped]') is never capped: those have to
  // survive a truncated run, and they are bounded by construction.
  function createOutputBuffer(options) {
    var opts     = options || {};
    var maxLines = typeof opts.maxLines === 'number' ? opts.maxLines : 5000;

    var queue  = [];
    var lines  = 0;      // stream lines accepted since the last reset
    var capped = false;

    function notice() {
      return '\n[output stopped after ' + maxLines + ' lines. The program is still running — '
           + 'printing more than this freezes the page, so the console stops here.]\n';
    }

    function countNewlines(s) {
      var n = 0;
      for (var i = 0; i < s.length; i++) { if (s.charCodeAt(i) === 10) n++; }
      return n;
    }

    // Index just past the nth newline, or -1 if there are fewer than n.
    function endOfLine(s, n) {
      var at = -1;
      while (n-- > 0) {
        var next = s.indexOf('\n', at + 1);
        if (next === -1) return -1;
        at = next;
      }
      return at + 1;
    }

    return {
      // Program stdout/stderr. Subject to the cap.
      pushStream: function(text) {
        if (capped) return false;
        var s = String(text);
        var n = countNewlines(s);

        if (lines + n > maxLines) {
          // Cut on a line boundary, never mid-line: a half-line reads as
          // corrupted output rather than a deliberate stop.
          var cut = endOfLine(s, maxLines - lines);
          if (cut > 0) queue.push(s.slice(0, cut));
          lines  = maxLines;
          capped = true;
          queue.push(notice());
          return true;
        }

        lines += n;
        queue.push(s);
        return true;
      },

      // Loader notices, '[stopped]', input prompts. Queued so it stays ordered
      // with program output, but never capped.
      pushSystem: function(text) {
        queue.push(String(text));
        return true;
      },

      // Hand back everything queued as one string, ready for a single write.
      drain: function() {
        if (!queue.length) return '';
        var text = queue.join('');
        queue = [];
        return text;
      },

      hasPending: function() { return queue.length > 0; },

      // The console is being rebuilt: queued text belongs to the old one.
      reset: function() {
        queue  = [];
        lines  = 0;
        capped = false;
      },

      // Give the next unit of work a fresh budget without discarding what is
      // already queued. Used per REPL statement, where "one command" is the
      // natural unit — a single help(numpy) must not mute the whole session.
      resetCap: function() {
        lines  = 0;
        capped = false;
      },

      isCapped:  function() { return capped; },
      lineCount: function() { return lines; }
    };
  }

  var api = { createOutputBuffer: createOutputBuffer };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.TrinketIO && root.TrinketIO.export) root.TrinketIO.export('embed.consoleBuffer', api);
})(typeof window !== 'undefined' ? window : this);
