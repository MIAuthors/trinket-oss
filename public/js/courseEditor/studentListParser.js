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
    var students = [];
    var skipped  = [];

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

      var name = parts.filter(function (_, i) { return i !== emailIndex; })
                      .join(' ');
      students.push({ email : parts[emailIndex], name : name });
    });

    return { students : students, skipped : skipped };
  }

  return { parse : parse };
}));
