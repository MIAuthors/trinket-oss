// Parses the Add Students bulk-paste box (picup#166).
//
// Instructors paste either the documented "First, Last, email" comma format
// or columns straight from a spreadsheet — which are TAB-delimited. Split on
// both. The email is recognized wherever it sits in the row (spreadsheet
// column order varies), and lines with no plausible email — including pasted
// header rows — are returned in `skipped` so the caller can show them to the
// instructor instead of creating junk users that must be deleted one by one.
//
// UMD-lite: window global for the Angular app, module.exports for the tests.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.trinketStudentListParser = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function parse(text) {
    var students   = [];
    var skipped    = [];
    var duplicates = 0;
    var seen       = {};

    String(text || '').split('\n').forEach(function (raw) {
      var line = raw.trim();
      if (!line) { return; }

      var parts = line.split(/[,\t]/)
        .map(function (p) { return p.trim(); })
        .filter(function (p) { return p.length > 0; });

      var emailIndex = -1;
      for (var i = 0; i < parts.length; i++) {
        if (EMAIL_RE.test(parts[i])) { emailIndex = i; break; }
      }

      if (emailIndex === -1) {
        skipped.push(line);
        return;
      }

      var email = parts[emailIndex];
      var key   = email.toLowerCase();
      if (seen[key]) {
        // The same address pasted twice would otherwise be submitted twice.
        duplicates++;
        return;
      }
      seen[key] = true;

      var name = parts.filter(function (_, i) { return i !== emailIndex; })
                      .join(' ');
      // `line` is the untouched paste — kept so the caller can put a line BACK
      // in the box exactly as the instructor wrote it (e.g. when its batch
      // fails to submit), rather than a lossy reconstruction.
      students.push({ email : email, name : name, line : line });
    });

    return { students : students, skipped : skipped, duplicates : duplicates };
  }

  return { parse : parse };
}));
