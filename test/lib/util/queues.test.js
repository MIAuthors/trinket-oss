// Exports have never completed on any Cloud Run deploy (3 attempts across mandi
// and uindy, 0 completions) and nobody noticed, because a queued job with no
// registered handler was discarded in silence — no log, no state change. The UI
// then polled a 'pending' record forever.
//
// The queue cannot fix the missing worker, but it must never lose work quietly.
const queues = require('../../../lib/util/queues');

describe('an in-memory queue with no handler', () => {
  let warned;
  beforeEach(() => {
    warned = [];
    vi.spyOn(console, 'warn').mockImplementation((...a) => warned.push(a.join(' ')));
    vi.spyOn(console, 'log').mockImplementation((...a) => warned.push(a.join(' ')));
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports that it cannot process work', () => {
    const q = queues.create('test-unhandled');
    expect(q.hasHandlers()).toBe(false);
  });

  it('reports that it can once a handler is registered', () => {
    const q = queues.create('test-handled');
    q.process(() => {});
    expect(q.hasHandlers()).toBe(true);
  });

  it('says so loudly when a job is dropped, naming the queue', async () => {
    const q = queues.create('test-dropped');
    await q.add({ action: 'student-work-export' });
    await new Promise((r) => setImmediate(r));
    const said = warned.join('\n');
    expect(said).toMatch(/test-dropped/);
    expect(said).toMatch(/no handler|dropped|discard/i);
  });

  it('still runs the job when a handler exists', async () => {
    const q = queues.create('test-runs');
    const seen = [];
    q.process((job) => { seen.push(job.data.action); });
    await q.add({ action: 'bulk-export' });
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual(['bulk-export']);
  });
});
