var config = require('config');

// `stamp`, when given, maps each src to the URL actually emitted. nunjucks.js
// passes the same content-addressing the `cachePrefix` filter applies, so the
// embed's own scripts stop going out bare on a 5-minute TTL (#234). Callers
// that pass nothing keep the old bare output.
var js = function(key, srcList, stamp) {
  var scripts = [];

  if (config.app.minified && config.app.minified[key]) {
    scripts.push('<script src="' + config.aws.buckets.cdn.host + '/' + config.app.minified[key] + '" type="text/javascript"></script>');
  }
  else {
    srcList.forEach(function(src) {
      var url = stamp ? stamp(src) : src;
      scripts.push('<script src="' + url + '" type="text/javascript"></script>');
    });
  }

  return scripts.join('\n');
}

module.exports = {
  js : js
};
