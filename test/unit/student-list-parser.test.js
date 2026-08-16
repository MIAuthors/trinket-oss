'use strict';

// picup#166: the Add Students form says "You can also paste directly from a
// spreadsheet column", but spreadsheet pastes are TAB-delimited and the old
// parser split only on commas — the whole row became the "email", and with no
// validation each malformed row was submitted and had to be deleted one at a
// time. The parser must accept commas AND tabs, find the email wherever it
// sits in the row, and hold back (not submit) lines with no plausible email.

const { parse } = require('../../public/js/courseEditor/studentListParser');

describe('studentListParser.parse', () => {
  it('parses the documented comma format: First, Last, email', () => {
    const r = parse('Jane, Smith, jane@example.com');
    expect(r.students).toEqual([{ email: 'jane@example.com', name: 'Jane Smith' }]);
    expect(r.skipped).toEqual([]);
  });

  it('parses a bare email line', () => {
    const r = parse('solo@example.com');
    expect(r.students).toEqual([{ email: 'solo@example.com', name: '' }]);
  });

  it('parses TAB-delimited spreadsheet pastes (the #166 case)', () => {
    const r = parse('Jane\tSmith\tjane@example.com\nBob\tJones\tbob@example.com');
    expect(r.students).toEqual([
      { email: 'jane@example.com', name: 'Jane Smith' },
      { email: 'bob@example.com', name: 'Bob Jones' }
    ]);
    expect(r.skipped).toEqual([]);
  });

  it('finds the email regardless of column order', () => {
    const r = parse('jane@example.com\tJane\tSmith');
    expect(r.students).toEqual([{ email: 'jane@example.com', name: 'Jane Smith' }]);
  });

  it('holds back lines with no plausible email instead of submitting them', () => {
    const r = parse('Jane\tSmith\nreal@example.com');
    expect(r.students).toEqual([{ email: 'real@example.com', name: '' }]);
    expect(r.skipped).toEqual(['Jane\tSmith']);
  });

  it('holds back a pasted spreadsheet header row', () => {
    const r = parse('First\tLast\tEmail\njane@example.com');
    expect(r.skipped).toEqual(['First\tLast\tEmail']);
    expect(r.students.length).toBe(1);
  });

  it('ignores blank lines and trims whitespace', () => {
    const r = parse('\n  jane@example.com  \n\n');
    expect(r.students).toEqual([{ email: 'jane@example.com', name: '' }]);
  });

  it('handles empty input', () => {
    expect(parse('')).toEqual({ students: [], skipped: [] });
    expect(parse(null)).toEqual({ students: [], skipped: [] });
  });
});
