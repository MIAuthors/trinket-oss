const routeParser = require('../../../lib/util/routeParser');

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
async function runPre(preHandler) {
  var converted = routeParser.convertPreHandlers([preHandler])[0];
  var method = typeof converted === 'object' && converted.method ? converted.method : converted;
  return method({ params: {}, query: {}, path: '/embed/python' }, fakeToolkit());
}

describe('routeParser convertPreHandlers (hapi-16 -> hapi-20 shim)', () => {
  describe('object-form pre-handler { method, assign }', () => {
    // THE regression: getDefaultTrinket does `return reply()` (bare) when there
    // is no ?category. That must assign null to request.pre.trinket. A prior fix
    // (slug-alias redirect) made bare reply() resolve to the chainable reply shim
    // object instead of null, so `if (request.pre.trinket)` went truthy and the
    // blank-editor embed 500'd on Firestore (User.findById(undefined)).
    it('bare `return reply()` assigns null (not the reply shim object)', async () => {
      var result = await runPre({ method: function(request, reply) { return reply(); }, assign: 'trinket' });
      expect(result).toBeNull();
    });

    it('`return reply(value)` assigns the value', async () => {
      var doc = { id: 'abc', _owner: 'u1' };
      var result = await runPre({ method: function(request, reply) { return reply(doc); }, assign: 'trinket' });
      expect(result).toBe(doc);
    });

    it('async pre-handler `return reply()` still assigns null', async () => {
      var result = await runPre({ method: async function(request, reply) { return reply(); }, assign: 'trinket' });
      expect(result).toBeNull();
    });

    it('`return reply().redirect(url).permanent().takeover()` resolves a real redirect (slug-alias)', async () => {
      var result = await runPre({
        method: function(request, reply) {
          return reply().redirect('/python/newslug').permanent().takeover();
        },
        assign: 'trinket'
      });
      expect(result).toBeTruthy();
      expect(result.url).toBe('/python/newslug');
      expect(result._takeover).toBe(true);
      expect(result._permanent).toBe(true);
    });
  });

  describe('function-form pre-handler function(request, reply)', () => {
    it('bare `return reply()` assigns null (not the reply shim object)', async () => {
      var result = await runPre(function(request, reply) { return reply(); });
      expect(result).toBeNull();
    });

    it('`return reply().redirect(url).permanent().takeover()` resolves a real redirect', async () => {
      var result = await runPre(function(request, reply) {
        return reply().redirect('/x/y').permanent().takeover();
      });
      expect(result).toBeTruthy();
      expect(result.url).toBe('/x/y');
      expect(result._takeover).toBe(true);
    });
  });
});
