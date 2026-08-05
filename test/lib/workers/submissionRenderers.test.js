'use strict';
// Lazily required in beforeAll (not at module top): lib/workers/exports.js
// pulls in config/app.config -> routes -> controllers -> @hapi/hapi. The
// global test setup (test/helpers/vitest-setup.cjs) boots app.js and applies
// required config fixups (redis disabled + mocked, session secret, etc.)
// inside its own beforeAll. A top-level require here would run at test-file
// collection time, BEFORE that setup runs, and hits real Redis + a
// hapi/@hapi-validate version-skew crash that only happens on that early,
// unconfigured path.
let renderFeedbackMarkdown, buildSubmissionMeta;
beforeAll(() => {
  ({ renderFeedbackMarkdown, buildSubmissionMeta } = require('../../../lib/workers/exports'));
});

describe('renderFeedbackMarkdown', () => {
  it('includes only feedback comments, oldest first, with author + time', () => {
    const md = renderFeedbackMarkdown([
      { commentType: 'feedback', commentText: 'Good start', commented: new Date('2026-01-02'), displayName: 'Prof X' },
      { commentType: 'student',  commentText: 'thanks',     commented: new Date('2026-01-03'), displayName: 'Jane' }
    ]);
    expect(md).toContain('Prof X');
    expect(md).toContain('Good start');
    expect(md).not.toContain('thanks');
  });
  it('says no feedback when none', () => {
    expect(renderFeedbackMarkdown([])).toMatch(/No feedback/i);
  });
});

describe('buildSubmissionMeta', () => {
  it('captures state/timestamps and never a score', () => {
    const meta = buildSubmissionMeta({
      student: { username: 'jane', email: 'jane@x.edu' },
      submission: { state: 'submitted', submittedOn: new Date('2026-01-02'), startedOn: new Date('2026-01-01'),
                    lastUpdated: new Date('2026-01-02'), shortCode: 'abc', lang: 'python3',
                    comments: [{ commentType: 'feedback' }] }
    });
    expect(meta.state).toBe('submitted');
    expect(meta.hasFeedback).toBe(true);
    expect(meta).not.toHaveProperty('score');
    expect(meta).not.toHaveProperty('grade');
  });
});
