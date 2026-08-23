// Coercing whatever a record actually holds into a Date.
//
// The timestamps plugin used to write `Date.now()` — a Number — into fields
// declared `{ type: Date }`. Mongoose cast that on the way in; the Firestore
// backend does not, so it stored a Number and every read got one back. A
// production 500 followed: `created.toISOString is not a function`.
//
// The plugin is fixed, but documents written before that still hold numbers, so
// read sites need to cope with all the shapes a date can arrive in.
function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;

  // Firestore Timestamp, and the {_seconds,_nanoseconds} husk it decays to once
  // it has been through JSON — the backend's own converter requires toDate() and
  // so leaves those untouched.
  if (typeof value === 'object') {
    if (typeof value.toDate === 'function') {
      var viaMethod = value.toDate();
      return viaMethod instanceof Date && !isNaN(viaMethod.getTime()) ? viaMethod : null;
    }
    var secs = typeof value._seconds === 'number' ? value._seconds
             : typeof value.seconds === 'number' ? value.seconds
             : null;
    if (secs !== null) return new Date(secs * 1000);
    return null;
  }

  if (typeof value === 'number') {
    if (!isFinite(value)) return null;
    return new Date(value);
  }

  if (typeof value === 'string') {
    var parsed = new Date(value);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

// null rather than a throw: a malformed stored date should not turn a page into
// a 500.
function toIso(value) {
  var d = toDate(value);
  return d ? d.toISOString() : null;
}

// `stored > new Date()` silently yields false when `stored` is a number, which
// would report a finished export as not downloadable.
function isFuture(value) {
  var d = toDate(value);
  return d ? d.getTime() > Date.now() : false;
}

module.exports = { toDate: toDate, toIso: toIso, isFuture: isFuture };
