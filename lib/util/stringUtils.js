module.exports = {
  // string interpolation:
  // e.g. interpolate('my name is {name}', {name:'ben'})
  interpolate : function(string, values) {
    return string.replace(
      /{([^{}]*)}/g,
      function (a, b) {
        var r    = values;
        var path = b.split('.');
        while(path.length && r !== undefined && r !== null) {
          r = r[path.shift()];
        }

        if (r !== undefined && r !== null && r.toString) {
          r = r.toString();
        }

        return typeof r === 'string' || typeof r === 'number' ? r : a;
      }
    );
  },

  // `token` identifies the running deploy. Callers pass assetVersion.token();
  // it is injected rather than required here so this stays a leaf module.
  // Without one the old per-call Date.now() behaviour remains, which produces a
  // unique URL per render and so can never be cached.
  addPrefix : function(string, prefixes, key, token) {
    if (!/^\/\//.test(string)) {
      var path = string.split('/');
      key = key || path[1];
      if (prefixes[ key ]) {
        string = '/' + prefixes[ key ] + string;
      }
      else {
        string = '/cache-prefix-' + (token || Date.now()) + string;
      }
    }

    return string;
  }
};
