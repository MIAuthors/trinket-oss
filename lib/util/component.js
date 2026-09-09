var stringUtils = require('./stringUtils');

module.exports = function(name, path) {
  var config = require('config')
    , host   = config.aws.buckets.vendorassets.host
    , hasCloudConfig = host && host.startsWith('https://') && !host.includes('example.com')
    , src;

  if (/^http/.test(config.app.components[name])) {
    src = [config.app.components[name], path].join('/');
  }
  else if (hasCloudConfig) {
    src = [host, name, config.app.components[name], path].join('/');
  }
  else {
    // Fall back to the local components directory, CONTENT-ADDRESSED.
    //
    // This used to emit a bare '/components/...' path, which the server serves
    // with max-age=300. Measured on mandi (2026-09-09), that was 13 requests and
    // 209 KiB per /embed/python3 view — and unlike a deploy-scoped miss it never
    // decays, because after five minutes the browser simply asks again.
    //
    // The same directory is already published content-addressed: the glowscript
    // runner stamps it with componentsToken() (#238) and deploy-hosting.sh
    // uploads components under cache-prefix-<content hash>. Using that token
    // here rather than the deploy commit matters — components then survive a
    // deploy that does not change them, instead of re-issuing 209 KiB per
    // browser every time we ship.
    //
    // Required lazily: this module is a leaf that config and nunjucks both pull
    // in, and requiring assetVersion at load time would close that loop.
    var componentsToken = require('./assetVersion').componentsToken();
    src = stringUtils.addPrefix('/components/' + path, config.app.prefixes || {},
                                'components', componentsToken);
  }

  if (/\.js$/.test(src)) {
    return "<script src='" + src + "' charset='utf-8'></script>";
  }
  else if (/\.css$/.test(src)) {
    return "<link rel='stylesheet' type='text/css' href='" + src + "' crossorigin='anonymous'>";
  }
}
