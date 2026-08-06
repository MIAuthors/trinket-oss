/**
 * Catbox-compatible cache engine using Mongoose/MongoDB
 * Stores sessions in MongoDB for persistence across server restarts
 */

const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  _id: String,           // segment:id composite key
  value: mongoose.Schema.Types.Mixed,
  stored: { type: Number, default: Date.now },  // ms epoch; get() does arithmetic on it
  ttl: Number,
  expiresAt: Date        // stored + ttl, as a Date — see the index note below
}, {
  collection: 'sessions',
  timestamps: false
});

// TTL index. The indexed field MUST be a Date: mongod's TTL monitor acts only on
// Date-typed fields and silently ignores numeric ones. This index previously sat
// on `stored`, a Number, so it existed and matched every document while deleting
// nothing — picup production accumulated 797 sessions, 494 of them over 30 days
// old, with the index in place and looking correct.
//
// No partialFilterExpression is needed: `expiresAt` is only stamped when catbox
// supplies a ttl (see set()), so sessions without one simply have no value here
// and are never swept — the same exemption the old filter provided.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

let Session;

const internals = {};

internals.Engine = class {
  constructor(options = {}) {
    this.options = options;
    this.isConnected = false;
  }

  async start() {
    // Use existing mongoose connection
    if (mongoose.connection.readyState === 1) {
      this.isConnected = true;
      // Initialize model if not already done
      if (!Session) {
        Session = mongoose.model('Session', sessionSchema);
      }
    } else {
      // Wait for connection
      await new Promise((resolve, reject) => {
        mongoose.connection.once('open', () => {
          this.isConnected = true;
          if (!Session) {
            Session = mongoose.model('Session', sessionSchema);
          }
          resolve();
        });
        mongoose.connection.once('error', reject);
      });
    }

    // Heal any deployment already carrying the pre-fix state. Idempotent and
    // best-effort: it converges to a no-op after the first boot and must never
    // block session startup, so failures are logged, not thrown.
    await this._reconcileLegacySessions();
  }

  // Two one-time repairs the schema change alone cannot make on a live database:
  //   1. Drop the stale `stored_1` TTL index. Mongoose autoIndex creates the new
  //      `expiresAt_1` index but never drops a removed one, so production would
  //      otherwise carry both the old (broken, numeric-field) index and the new one.
  //   2. Backfill `expiresAt` on sessions written before the field existed, so the
  //      TTL monitor can finally reap them (picup prod: 494 of 797 already stale,
  //      with no expiresAt the monitor will never touch them).
  // Sessions without a ttl are left alone — they must never be swept, the same
  // exemption set() and the old partialFilterExpression both intend.
  async _reconcileLegacySessions() {
    if (!Session) return;
    const coll = Session.collection;

    try {
      await coll.dropIndex('stored_1');
      console.log('[catbox-mongoose] dropped stale sessions.stored_1 TTL index');
    } catch (err) {
      // 27 = IndexNotFound, 26 = NamespaceNotFound (clean deploy, or another
      // instance already dropped it). Anything else is worth surfacing.
      if (err && err.code !== 27 && err.code !== 26) {
        console.warn('[catbox-mongoose] could not drop stale stored_1 index:', err.message);
      }
    }

    try {
      const res = await coll.updateMany(
        { ttl: { $exists: true, $ne: null }, expiresAt: { $exists: false } },
        [{ $set: { expiresAt: { $toDate: { $add: ['$stored', '$ttl'] } } } }]
      );
      const n = (res && (res.modifiedCount != null ? res.modifiedCount : res.nModified)) || 0;
      if (n) console.log(`[catbox-mongoose] backfilled expiresAt on ${n} legacy session(s)`);
    } catch (err) {
      console.warn('[catbox-mongoose] expiresAt backfill failed:', err.message);
    }
  }

  stop() {
    this.isConnected = false;
  }

  isReady() {
    return this.isConnected && mongoose.connection.readyState === 1;
  }

  validateSegmentName(name) {
    if (!name || typeof name !== 'string') {
      return new Error('Invalid segment name');
    }
    return null;
  }

  async get(key) {
    if (!this.isReady()) {
      throw new Error('Cache not ready');
    }

    const id = this._generateKey(key);

    try {
      const record = await Session.findById(id).lean();

      if (!record) {
        return null;
      }

      // Check if expired
      if (record.ttl && (Date.now() - record.stored) > record.ttl) {
        await Session.deleteOne({ _id: id });
        return null;
      }

      return {
        item: record.value,
        stored: record.stored,
        ttl: record.ttl
      };
    } catch (err) {
      throw err;
    }
  }

  async set(key, value, ttl) {
    if (!this.isReady()) {
      throw new Error('Cache not ready');
    }

    const id = this._generateKey(key);

    try {
      const now = Date.now();
      const update = {
        _id: id,
        value: value,
        stored: now,
        ttl: ttl
      };

      // Stamp the expiry only when catbox gave us a ttl. A session without one
      // must never be swept, which is what the old index's partialFilterExpression
      // guaranteed; leaving `expiresAt` unset achieves the same thing.
      if (typeof ttl === 'number' && isFinite(ttl)) {
        update.expiresAt = new Date(now + ttl);
      }

      await Session.findByIdAndUpdate(id, update, { upsert: true });
    } catch (err) {
      throw err;
    }
  }

  async drop(key) {
    if (!this.isReady()) {
      throw new Error('Cache not ready');
    }

    const id = this._generateKey(key);

    try {
      await Session.deleteOne({ _id: id });
    } catch (err) {
      throw err;
    }
  }

  _generateKey(key) {
    return `${key.segment}:${key.id}`;
  }
};

module.exports = {
  Engine: internals.Engine
};
