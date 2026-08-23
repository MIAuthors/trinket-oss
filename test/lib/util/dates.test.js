// Fixing the plugin stops NEW bad data. Every Firestore document written before
// that already carries a numeric `created`, so read sites must cope. The
// codebase already leans this way — course.js uses `new Date(x).toISOString()`.
const dates = require('../../../lib/util/dates');

describe('dates.toDate', () => {
  it('passes a Date through', () => {
    const d = new Date('2026-08-22T16:41:15Z');
    expect(dates.toDate(d)).toBe(d);
  });

  it('converts epoch milliseconds — the shape the bug wrote', () => {
    expect(dates.toDate(1787416852246).toISOString()).toBe(new Date(1787416852246).toISOString());
  });

  it('converts an ISO string', () => {
    expect(dates.toDate('2026-08-22T16:41:15.000Z').toISOString()).toBe('2026-08-22T16:41:15.000Z');
  });

  it('converts a Firestore Timestamp', () => {
    const ts = { seconds: 1787416852, nanoseconds: 0, toDate: () => new Date(1787416852000) };
    expect(dates.toDate(ts).toISOString()).toBe(new Date(1787416852000).toISOString());
  });

  it('converts a Timestamp that lost its methods (JSON round-trip)', () => {
    // {_seconds,_nanoseconds} with no toDate() — what a serialized Timestamp
    // decays to, and what the backend's own converter refuses to touch.
    expect(dates.toDate({ _seconds: 1787416852, _nanoseconds: 0 }).toISOString())
      .toBe(new Date(1787416852000).toISOString());
  });

  it('returns null for absent or unusable values', () => {
    [null, undefined, '', 'not a date', {}, NaN].forEach((v) => {
      expect(dates.toDate(v)).toBeNull();
    });
  });
});

describe('dates.toIso', () => {
  it('formats anything convertible', () => {
    expect(dates.toIso(1787416852246)).toBe(new Date(1787416852246).toISOString());
  });

  it('returns null rather than throwing — the 500 this replaces', () => {
    expect(dates.toIso(undefined)).toBeNull();
    expect(dates.toIso('nonsense')).toBeNull();
  });
});

describe('dates.isFuture', () => {
  it('compares correctly even when the stored value is a number', () => {
    // `expiresAt > new Date()` silently returns false for a numeric field, so a
    // finished export could report downloadAvailable: false.
    expect(dates.isFuture(Date.now() + 60000)).toBe(true);
    expect(dates.isFuture(Date.now() - 60000)).toBe(false);
    expect(dates.isFuture(undefined)).toBe(false);
  });
});
