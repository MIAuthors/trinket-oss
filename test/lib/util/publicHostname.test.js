// Behind a CDN or proxy (Firebase Hosting, Cloudflare) the browser's origin and
// the origin the app receives are different: Cloud Run sees only its own
// *.run.app host. Templates render absolute URLs from that value, so the client
// builds iframe URLs on a foreign origin and Angular's $sce refuses them
// ([$sce:insecurl]) — the failure that broke the library page behind the CDN.
const publicHostname = require('../../../lib/util/publicHostname');

const ALLOWED = ['rba-merge-trial.spvi.net', 'trinket-merge-test.web.app'];

describe('publicHostname.resolve', () => {
  it('uses the request host when nothing is forwarded', () => {
    expect(publicHostname.resolve({}, 'rba-merge-trial.spvi.net', ALLOWED))
      .toBe('rba-merge-trial.spvi.net');
  });

  it('prefers a forwarded host the deploy recognises', () => {
    expect(publicHostname.resolve(
      { 'x-forwarded-host': 'trinket-merge-test.web.app' },
      'trinket-cdntest-ai6dwxhkkq-uc.a.run.app', ALLOWED
    )).toBe('trinket-merge-test.web.app');
  });

  it('IGNORES a forwarded host that is not ours — the header is attacker-controlled', () => {
    // Cloud Run is directly reachable, so anyone can send this header. Honouring
    // it unchecked is host-header injection: absolute URLs in the page (and any
    // link mailed from them) would point at the attacker's origin.
    expect(publicHostname.resolve(
      { 'x-forwarded-host': 'evil.example.com' },
      'rba-merge-trial.spvi.net', ALLOWED
    )).toBe('rba-merge-trial.spvi.net');
  });

  it('takes the first hop when proxies chain the header', () => {
    expect(publicHostname.resolve(
      { 'x-forwarded-host': 'trinket-merge-test.web.app, internal.proxy' },
      'trinket-cdntest-ai6dwxhkkq-uc.a.run.app', ALLOWED
    )).toBe('trinket-merge-test.web.app');
  });

  it('tolerates whitespace and case', () => {
    expect(publicHostname.resolve(
      { 'x-forwarded-host': '  TRINKET-MERGE-TEST.WEB.APP  ' },
      'x.run.app', ALLOWED
    )).toBe('trinket-merge-test.web.app');
  });

  it('recognises an allowed host even when the proxy forwards host:port', () => {
    // Compared AND returned portless — request.info.hostname has no port, so
    // the caller sees one consistent form either way.
    expect(publicHostname.resolve(
      { 'x-forwarded-host': 'trinket-merge-test.web.app:443' }, 'x.run.app', ALLOWED
    )).toBe('trinket-merge-test.web.app');
  });

  it('ignores a port-qualified forwarded host that is otherwise unknown', () => {
    expect(publicHostname.resolve(
      { 'x-forwarded-host': 'evil.example.com:443' }, 'rba-merge-trial.spvi.net', ALLOWED
    )).toBe('rba-merge-trial.spvi.net');
  });

  it('falls back safely when there is no allow-list', () => {
    expect(publicHostname.resolve(
      { 'x-forwarded-host': 'trinket-merge-test.web.app' }, 'x.run.app', []
    )).toBe('x.run.app');
  });

  it('handles a missing request host without throwing', () => {
    expect(publicHostname.resolve({}, undefined, ALLOWED)).toBeUndefined();
  });
});
