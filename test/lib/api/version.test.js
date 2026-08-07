const flow = require('../../helpers/flow.cjs');

// GET /version reports which build a deploy is serving — previously impossible
// to determine from outside (Cloud Run revisions carry no source SHA, so
// confirming a deploy meant inferring it from a build timestamp or ssh-ing to
// the box).
//
// The split matters as much as the endpoint: identity is public (testers must be
// able to report "which build am I on?"), but the infrastructure profile — db
// backend and uptime — is admin-only. `backend` tells an attacker which
// query/injection techniques apply; `uptime` exposes restart/deploy cadence.
// Neither helps the audience this endpoint exists for.
describe('GET /version', () => {
  beforeEach(() => { flow.cookies = {}; });

  describe('anonymous', () => {
    beforeEach(async () => { await flow.switchUser(''); });

    it('returns the build identity without auth', async () => {
      const res = await flow.get('/version');
      expect(res.statusCode).toBe(200);

      const body = res.body.data || res.body;
      // Present and string-typed even when the build wasn't stamped (dev/bare
      // node): every field degrades to 'unknown' rather than throwing.
      ['commit', 'commitFull', 'branch', 'builtAt', 'deploy', 'version', 'nodeEnv']
        .forEach((k) => expect(typeof body[k]).toBe('string'));
    });

    it('withholds the infrastructure detail from non-admins', async () => {
      const res = await flow.get('/version');
      const body = res.body.data || res.body;
      expect(body.backend).toBeUndefined();
      expect(body.uptime).toBeUndefined();
    });
  });

  describe('site admin', () => {
    beforeEach(async () => { await flow.switchUser('admin'); });

    it('also returns backend and uptime', async () => {
      const res = await flow.get('/version');
      expect(res.statusCode).toBe(200);

      const body = res.body.data || res.body;
      expect(typeof body.commit).toBe('string');     // still gets the public fields
      expect(typeof body.backend).toBe('string');    // mongoose | firestore
      expect(typeof body.uptime).toBe('number');
    });
  });
});
