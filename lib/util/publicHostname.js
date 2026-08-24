// The hostname the BROWSER used, which behind a CDN or proxy is not the one the
// app receives. Firebase Hosting and Cloudflare terminate the request and
// forward it to Cloud Run, which sees only its own *.run.app host — so
// templates rendered from the request host emit absolute URLs on a foreign
// origin, and the client's iframe URLs get rejected by Angular's $sce.
//
// X-Forwarded-Host carries the original, but it is attacker-controlled: Cloud
// Run is directly reachable, so anyone can send one. It is therefore honoured
// ONLY when it names a host this deploy already claims (app.url.hostname +
// app.url.knownHosts). Anything else falls back to the request host, which is
// the pre-existing behaviour.
function resolve(headers, requestHostname, allowedHosts) {
  var raw = headers && headers['x-forwarded-host'];
  if (!raw) return requestHostname;

  // Chained proxies append; the first hop is the client-facing one.
  var candidate = String(raw).split(',')[0].trim().toLowerCase();
  if (!candidate) return requestHostname;

  // Some proxies forward host:port. Compare — and return — the hostname alone:
  // request.info.hostname carries no port either, so this keeps the two forms
  // interchangeable for the caller. Bracketed IPv6 keeps its brackets; a bare
  // IPv6 literal has colons of its own and no port to strip.
  if (candidate.charAt(0) === '[') {
    candidate = candidate.replace(/^(\[[^\]]*\])(:\d+)?$/, '$1');
  } else if ((candidate.match(/:/g) || []).length === 1) {
    candidate = candidate.replace(/:\d+$/, '');
  }

  var allowed = (allowedHosts || []).filter(Boolean).map(function (h) {
    return String(h).trim().toLowerCase();
  });

  return allowed.indexOf(candidate) === -1 ? requestHostname : candidate;
}

module.exports = { resolve: resolve };
