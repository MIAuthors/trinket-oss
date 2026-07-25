const routeParser = require('../../../lib/util/routeParser');
const Boom        = require('@hapi/boom');

// A minimal stand-in for the live hapi response toolkit `h`. The pre-handler
// shim calls h.redirect(url).permanent().takeover() for slug-alias redirects.
function fakeToolkit() {
  return {
    redirect: function(url) {
      var res = {
        url: url,
        _permanent: false,
        _takeover: false,
        permanent: function() { this._permanent = true; return this; },
        takeover: function() { this._takeover = true; return this; }
      };
      return res;
    }
  };
}

// Wrap a single hapi-16-style pre-handler and invoke it, returning the value the
// pre-handler Promise settles to (i.e. what request.pre.<assign> would become).
// Rejects if the pre-handler settled a Boom error.
async function runPre(preHandler) {
  var converted = routeParser.convertPreHandlers([preHandler])[0];
  var method = typeof converted === 'object' && converted.method ? converted.method : converted;
  return method({ params: {}, query: {}, path: '/embed/python' }, fakeToolkit());
}

// The shim has two near-identical copies: object form { method, assign } and
// bare function form. Every contract below must hold for both, so the cases are
// generated from a wrapper factory.
const FORMS = {
  'object-form { method, assign }': (fn) => ({ method: fn, assign: 'trinket' }),
  'function-form function(request, reply)': (fn) => fn
};

Object.entries(FORMS).forEach(([formName, wrap]) => {
  describe(`routeParser convertPreHandlers shim contract — ${formName}`, () => {
    // THE regression this suite exists for: getDefaultTrinket does bare
    // `return reply()` when there is no ?category, which must assign null to
    // request.pre.trinket. A prior fix (slug-alias redirect) made bare reply()
    // resolve to the chainable reply shim object instead of null, so
    // `if (request.pre.trinket)` went truthy and the blank-editor embed ran the
    // existing-trinket branch — 500 on Firestore (User.findById(undefined)),
    // stale-code prefill on Mongo (Draft.findOneMoreRecent({trinket:undefined})).
    it('bare `return reply()` assigns null (not the reply shim object)', async () => {
      var result = await runPre(wrap(function(request, reply) { return reply(); }));
      expect(result).toBeNull();
    });

    it('`return reply(value)` assigns the value', async () => {
      var doc = { id: 'abc', _owner: 'u1' };
      var result = await runPre(wrap(function(request, reply) { return reply(doc); }));
      expect(result).toBe(doc);
    });

    // Guards the `value !== undefined` check against being "simplified" to a
    // truthy test: a pre-handler that legitimately assigns false/0/'' must keep
    // that value, not fall through to null.
    it('`return reply(false)` assigns false (defined-but-falsy is preserved)', async () => {
      var result = await runPre(wrap(function(request, reply) { return reply(false); }));
      expect(result).toBe(false);
    });

    it('`return reply(0)` assigns 0', async () => {
      var result = await runPre(wrap(function(request, reply) { return reply(0); }));
      expect(result).toBe(0);
    });

    it('`reply(Boom)` rejects the pre-handler (becomes an error response)', async () => {
      await expect(runPre(wrap(function(request, reply) {
        return reply(Boom.notFound());
      }))).rejects.toMatchObject({ isBoom: true });
    });

    it('returning a value directly (no reply call) assigns that value', async () => {
      var doc = { id: 'direct' };
      var result = await runPre(wrap(function(request, reply) { return doc; }));
      expect(result).toBe(doc);
    });

    it('async pre-handler `return reply()` still assigns null', async () => {
      var result = await runPre(wrap(async function(request, reply) { return reply(); }));
      expect(result).toBeNull();
    });

    it('async pre-handler returning a real value assigns that value', async () => {
      var doc = { id: 'async-direct' };
      var result = await runPre(wrap(async function(request, reply) { return doc; }));
      expect(result).toBe(doc);
    });

    it('reply(value) from an async callback (method returns undefined) assigns the value', async () => {
      var doc = { id: 'cb' };
      var result = await runPre(wrap(function(request, reply) {
        Promise.resolve().then(function() { reply(doc); });
        // returns undefined — settlement is driven by the deferred reply()
      }));
      expect(result).toBe(doc);
    });

    // Single-settlement guard: the first settlement wins; later reply() calls
    // are no-ops (a pre-handler that replies then keeps running must not clobber).
    it('first settlement wins (a later reply() is a no-op)', async () => {
      var first = { id: 'first' };
      var result = await runPre(wrap(function(request, reply) {
        reply(first);
        reply({ id: 'second' });
      }));
      expect(result).toBe(first);
    });

    it('`return reply().redirect(url).permanent().takeover()` resolves a real redirect (slug-alias)', async () => {
      var result = await runPre(wrap(function(request, reply) {
        return reply().redirect('/python/newslug').permanent().takeover();
      }));
      expect(result).toBeTruthy();
      expect(result.url).toBe('/python/newslug');
      expect(result._takeover).toBe(true);
      expect(result._permanent).toBe(true);
    });

    // A synchronous redirect chain must win over bare reply()'s deferred null.
    it('redirect chain beats the bare-reply() deferred null (does not resolve null)', async () => {
      var result = await runPre(wrap(function(request, reply) {
        return reply().redirect('/x/y').permanent().takeover();
      }));
      expect(result).not.toBeNull();
      expect(result.url).toBe('/x/y');
    });
  });
});
