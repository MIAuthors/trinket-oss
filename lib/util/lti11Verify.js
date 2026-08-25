// OAuth 1.0a signature verification for LTI 1.1 launches (SPIKE).
//
// An LTI 1.1 launch is a form POST signed with HMAC-SHA1 over a canonical
// "signature base string" (RFC 5849 §3.4.1): METHOD & encoded-URL &
// encoded-sorted-params. The fiddly parts — and the classic source of 1.1
// tool vulnerabilities — are the canonicalization rules, so they live here
// as small pure functions, each pinned by tests:
//   * RFC 3986 percent-encoding (encodeURIComponent PLUS !'()* — and never '+')
//   * parameter sorting by ENCODED key, then ENCODED value
//   * URL normalization: lowercase scheme/host, default ports stripped,
//     query and fragment excluded
//
// sign() exists for the tests (roundtrip + tamper detection) and for any
// future outbound need; trinket itself only verifies.
'use strict';
var crypto = require('crypto');

var TIMESTAMP_WINDOW_S = 300;   // ±5 min, the conventional replay window

function rfc3986(str) {
  return encodeURIComponent(String(str)).replace(/[!'()*]/g, function (c) {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

// Base-string URL: scheme://host[:port]/path — lowercase scheme+host, default
// port dropped, query/fragment dropped (query params are signed as params).
function normalizeUrl(url) {
  var u = new URL(url);
  var scheme = u.protocol.replace(':', '').toLowerCase();
  var host = u.hostname.toLowerCase();
  var port = u.port;
  if ((scheme === 'http' && port === '80') || (scheme === 'https' && port === '443')) port = '';
  return scheme + '://' + host + (port ? ':' + port : '') + u.pathname;
}

// All params (body + query merged by the caller) except oauth_signature,
// encoded, sorted, joined. Values may repeat; sort is by encoded key then
// encoded value.
function normalizeParams(params) {
  var pairs = [];
  Object.keys(params).forEach(function (k) {
    if (k === 'oauth_signature') return;
    var vals = Array.isArray(params[k]) ? params[k] : [params[k]];
    vals.forEach(function (v) {
      pairs.push([rfc3986(k), rfc3986(v === undefined || v === null ? '' : v)]);
    });
  });
  pairs.sort(function (a, b) {
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1
         : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  });
  return pairs.map(function (p) { return p[0] + '=' + p[1]; }).join('&');
}

function baseString(method, url, params) {
  return [method.toUpperCase(), rfc3986(normalizeUrl(url)), rfc3986(normalizeParams(params))].join('&');
}

function sign(method, url, params, consumerSecret) {
  var key = rfc3986(consumerSecret) + '&';   // no token secret in LTI 1.1
  return crypto.createHmac('sha1', key).update(baseString(method, url, params)).digest('base64');
}

// -> { ok: true } | { ok: false, reason }
function verify(opts) {
  var params = opts.params || {};
  if (params.oauth_version && params.oauth_version !== '1.0') {
    return { ok: false, reason: 'unsupported oauth_version' };
  }
  if (params.oauth_signature_method !== 'HMAC-SHA1') {
    return { ok: false, reason: 'unsupported signature method' };
  }
  if (!params.oauth_signature || !params.oauth_timestamp || !params.oauth_nonce) {
    return { ok: false, reason: 'missing oauth fields' };
  }
  var now = opts.now || Math.floor(Date.now() / 1000);
  var ts = parseInt(params.oauth_timestamp, 10);
  if (!isFinite(ts) || Math.abs(now - ts) > TIMESTAMP_WINDOW_S) {
    return { ok: false, reason: 'timestamp outside window' };
  }
  var expected = sign(opts.method, opts.url, params, opts.secret);
  var got = String(params.oauth_signature);
  var a = Buffer.from(expected), b = Buffer.from(got);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}

// The URL the platform signed is the PUBLIC one it POSTed to. Behind a CDN
// front door request.info.hostname is the backend's own host and TLS may
// terminate upstream, so: forwarded/allowlisted hostname (same rule as the
// template layer), forwarded proto first, configured proto second, and the
// host header's port only when it belongs to the same host.
function launchUrlFromRequest(request, appUrlConfig, resolveHost) {
  var host = resolveHost(request.headers, request.info.hostname,
    [appUrlConfig.hostname].concat(appUrlConfig.knownHosts || []));
  var proto = (request.headers['x-forwarded-proto'] || '').split(',')[0]
           || appUrlConfig.protocol || 'https';
  var hostHeader = request.headers.host || '';
  var port = '';
  if (hostHeader.indexOf(':') !== -1 && host === hostHeader.split(':')[0]) {
    port = ':' + hostHeader.split(':')[1];
  }
  // Platforms sign the URL as installed, and nobody installs an explicit
  // default port — while proxies/injected requests DO put :80/:443 in the
  // host header. Drop default ports unconditionally.
  if (port === ':80' || port === ':443') port = '';
  return proto + '://' + host + port + request.path;
}

module.exports = {
  verify: verify,
  launchUrlFromRequest: launchUrlFromRequest,
  sign: sign,
  baseString: baseString,
  normalizeUrl: normalizeUrl,
  normalizeParams: normalizeParams,
  rfc3986: rfc3986,
  TIMESTAMP_WINDOW_S: TIMESTAMP_WINDOW_S
};
