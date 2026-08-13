const flow = require('../../helpers/flow.cjs');

// #139: /library/trinkets/<id> canonicalises to /<lang>/<shortCode> for anyone
// who is not the owner. It used to drop the query string, silently discarding
// every embed/share option on the URL — and that URL is exactly what an author
// has in the address bar while looking at their own trinket, so it is the one
// they copy and add options to.
beforeEach(() => {
  flow.cookies = {};
});

describe('Library URL canonical redirect (#139)', () => {
  let trinketId;

  beforeEach(async () => {
    await flow.switchUser("user");
    await flow.createTrinket();
    trinketId = flow.lastResponse.body.data.id;
    // The owner is NOT redirected (the handler renders the library page for
    // them), so drop the session to exercise the redirect branch.
    flow.cookies = {};
  });

  it('redirects to the canonical trinket URL', async () => {
    await flow.get('/library/trinkets/' + trinketId);
    expect(flow.lastResponse.statusCode).toEqual(302);
    expect(flow.lastResponse.headers.location).toMatch(/^\/[a-z0-9-]+\/\w+$/i);
  });

  it('carries the query string through — pre-fix this was dropped', async () => {
    await flow.get('/library/trinkets/' + trinketId + '?outputOnly=true');
    expect(flow.lastResponse.statusCode).toEqual(302);
    expect(flow.lastResponse.headers.location).toContain('?outputOnly=true');
  });

  it('carries several parameters, not just the first', async () => {
    await flow.get('/library/trinkets/' + trinketId + '?runMode=calculator&outputOnly=true');
    expect(flow.lastResponse.headers.location).toContain('runMode=calculator');
    expect(flow.lastResponse.headers.location).toContain('outputOnly=true');
  });
});
