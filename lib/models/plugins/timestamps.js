var defaults = {
  created:     "created",
  lastUpdated: "lastUpdated"
};

function dateJSON(key) {
  var json = {};
  json[key] = { type: Date, default: Date.now };
  return json;
};

module.exports = function(schema, options) {
  var created     = options && options.created     ? options.created     : defaults.created,
      lastUpdated = options && options.lastUpdated ? options.lastUpdated : defaults.lastUpdated;

  schema.add(dateJSON(created));
  schema.add(dateJSON(lastUpdated));

  return schema.pre("save", function(next) {
    if (!this.isModified()) return next();

    // A Date, NOT Date.now(): these fields are declared `{ type: Date }`, and
    // while Mongoose casts a number on the way in, the Firestore backend does
    // not — it stored the raw number, and reads then crashed on
    // `.toISOString()`. See lib/util/dates.js for the read-side coercion that
    // handles records written before this fix.
    var timestamp = new Date();

    if (this[created] == null) {
      this[created] = timestamp;
    }
    
    this[lastUpdated] = timestamp;
    return next();
  });
};