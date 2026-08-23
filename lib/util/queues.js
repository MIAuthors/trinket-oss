var config = require('config');

// Check if Redis is enabled
var redisEnabled = config.db && config.db.redis && config.db.redis.enabled !== false;

// In-memory queue implementation for when Redis is not available
function InMemoryQueue(name) {
  this.name = name;
  this.handlers = [];
  this.processing = false;
  this.jobs = [];
}

// Whether anything is actually able to run queued work. Callers that enqueue
// USER-VISIBLE jobs should check this and fail fast: a job with no handler is
// discarded, and without this the caller cannot tell.
InMemoryQueue.prototype.hasHandlers = function() {
  return this.handlers.length > 0;
};

InMemoryQueue.prototype.process = function(handler) {
  this.handlers.push(handler);
};

InMemoryQueue.prototype.add = function(data, opts) {
  var self = this;
  var job = {
    id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
    data: data,
    opts: opts || {},
    attempts: 0
  };

  // Process immediately in next tick (simulates async queue behavior)
  setImmediate(function() {
    self._processJob(job);
  });

  return Promise.resolve(job);
};

InMemoryQueue.prototype._processJob = function(job) {
  var self = this;

  if (this.handlers.length === 0) {
    // Dropping the job is acceptable for optional fire-and-forget work
    // (analytics, events) but NOT for anything a user is waiting on. It was
    // silent, and exports sat 'pending' forever on every Cloud Run deploy —
    // 3 attempts across two production servers, 0 completions, no log line.
    // Say so; callers that care should also check hasHandlers() up front.
    console.warn('Queue [' + self.name + '] DROPPED job ' + job.id +
      ' — no handler registered. Work queued here is discarded. ' +
      'On Cloud Run the export worker only registers when RUN_EXPORT_WORKER=true.');
    return;
  }

  // Call all handlers
  this.handlers.forEach(function(handler) {
    try {
      var result = handler(job, function done(err) {
        if (err) {
          console.log('InMemoryQueue [' + self.name + '] job failed:', err.message);
        }
      });

      // Handle promise-based handlers
      if (result && typeof result.catch === 'function') {
        result.catch(function(err) {
          console.log('InMemoryQueue [' + self.name + '] job failed:', err.message);
        });
      }
    } catch (err) {
      console.log('InMemoryQueue [' + self.name + '] job error:', err.message);
    }
  });
};

InMemoryQueue.prototype.on = function(event, handler) {
  // No-op for compatibility - in-memory queue doesn't emit events
  return this;
};

InMemoryQueue.prototype.close = function() {
  return Promise.resolve();
};

// No-op queue for features that are disabled
function NoOpQueue(name) {
  this.name = name;
}

NoOpQueue.prototype.hasHandlers = function() { return false; };
NoOpQueue.prototype.process = function() {};
NoOpQueue.prototype.add = function() { return Promise.resolve({ id: 'noop' }); };
NoOpQueue.prototype.on = function() { return this; };
NoOpQueue.prototype.close = function() { return Promise.resolve(); };

// Queue cache
var cache = {};

// List of queues that should be completely disabled (no-op)
var disabledQueues = ['receipts', 'reports', 'containers', 'notifier', 'events', 'snapshots', 'courses', 'trinkets', 'folders'];

// Create queue factory
function createQueue(name) {
  if (cache[name]) {
    return cache[name];
  }

  // Check if this queue is disabled
  if (disabledQueues.indexOf(name) >= 0) {
    console.log('Queue [' + name + '] is disabled, using no-op queue');
    cache[name] = new NoOpQueue(name);
    return cache[name];
  }

  // Use Bull if Redis is enabled
  if (redisEnabled) {
    var Queue = require('bull');
    var queueConfig = config.db.redis[name] || config.db.redis.app;
    var opts = {};

    if (queueConfig.password) {
      opts.redis = {
        host: queueConfig.host,
        port: queueConfig.port,
        password: queueConfig.password
      };
    } else {
      opts.redis = {
        host: queueConfig.host,
        port: queueConfig.port
      };
    }

    cache[name] = new Queue(name, opts);
    console.log('Queue [' + name + '] using Bull with Redis');
  } else {
    // Use in-memory queue
    cache[name] = new InMemoryQueue(name);
    console.log('Queue [' + name + '] using in-memory queue (Redis not configured)');
  }

  return cache[name];
}

// Export queue getters for each queue type
var bullqueues = config.db && config.db.redis && config.db.redis.bullqueues
  ? config.db.redis.bullqueues
  : ['exports'];

bullqueues.forEach(function(queueName) {
  module.exports[queueName] = function() {
    return createQueue(queueName);
  };
});

// Export utilities
// Exposed for tests and for callers that need a named queue directly.
module.exports.create = createQueue;

module.exports.isRedisEnabled = function() {
  return redisEnabled;
};

module.exports.closeAll = function() {
  var promises = Object.keys(cache).map(function(name) {
    return cache[name].close();
  });
  return Promise.all(promises);
};
