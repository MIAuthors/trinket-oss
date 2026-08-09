'use strict';
// #108: the client's lifecycle logic — correlation ids, stop, and the promise
// contract. A fake Worker constructor is injected so this stays a node test;
// real execution is covered by the browser spec.
const { createWorkerClient } = require('../../public/js/embed/worker-client.js');

function fakeWorkerFactory() {
  const made = [];
  function FakeWorker() {
    this.posted = [];
    this.terminated = false;
    this.postMessage = (m) => { this.posted.push(m); };
    this.terminate = () => { this.terminated = true; };
    made.push(this);
  }
  return { FakeWorker, made };
}

function newClient(extra) {
  const { FakeWorker, made } = fakeWorkerFactory();
  const events = { stdout: [], stderr: [], errors: [] };
  const client = createWorkerClient(Object.assign({
    workerUrl: '/js/embed/pyodide-worker.js',
    pyodideUrl: 'https://cdn/pyodide.js',
    WorkerCtor: FakeWorker,
    onStdout: (t) => events.stdout.push(t),
    onStderr: (t) => events.stderr.push(t),
    onError:  (t) => events.errors.push(t)
  }, extra || {}));
  return { client, made, events };
}

describe('createWorkerClient', () => {
  it('sends init on construction', () => {
    const { made } = newClient();
    expect(made[0].posted[0].type).toBe('init');
  });

  it('is not running before a run starts', () => {
    const { client } = newClient();
    expect(client.isRunning()).toBe(false);
  });

  it('posts a run message with a correlation id, and reports running', () => {
    const { client, made } = newClient();
    client.run('print(1)');
    const runMsg = made[0].posted.find(m => m.type === 'run');
    expect(runMsg.source).toBe('print(1)');
    expect(typeof runMsg.id).toBe('string');
    expect(client.isRunning()).toBe(true);
  });

  it('forwards stdout to the callback', () => {
    const { client, made, events } = newClient();
    client.run('print(1)');
    made[0].onmessage({ data: { type: 'stdout', text: 'hello\n' } });
    expect(events.stdout).toEqual(['hello\n']);
  });

  it('resolves the run promise on done', async () => {
    const { client, made } = newClient();
    const p = client.run('print(1)');
    const id = made[0].posted.find(m => m.type === 'run').id;
    made[0].onmessage({ data: { type: 'done', id } });
    await expect(p).resolves.toBeUndefined();
    expect(client.isRunning()).toBe(false);
  });

  it('reports an error and still settles the run', async () => {
    const { client, made, events } = newClient();
    const p = client.run('boom');
    const id = made[0].posted.find(m => m.type === 'run').id;
    made[0].onmessage({ data: { type: 'error', id, traceback: 'ValueError: x' } });
    await p;
    expect(events.errors).toEqual(['ValueError: x']);
    expect(client.isRunning()).toBe(false);
  });

  it('ignores replies whose id does not match the current run (a stale worker)', () => {
    const { client, made, events } = newClient();
    client.run('print(1)');
    made[0].onmessage({ data: { type: 'error', id: 'not-the-current-id', traceback: 'stale' } });
    expect(events.errors).toEqual([]);
    expect(client.isRunning()).toBe(true);
  });

  it('stop() terminates the worker and settles the in-flight run', async () => {
    const { client, made } = newClient();
    const p = client.run('while True: pass');
    client.stop();
    expect(made[0].terminated).toBe(true);
    await expect(p).resolves.toBeUndefined();
    expect(client.isRunning()).toBe(false);
  });

  it('spawns a replacement worker after stop, so the next run works', () => {
    const { client, made } = newClient();
    client.run('while True: pass');
    client.stop();
    client.run('print(2)');
    expect(made.length).toBe(2);
    expect(made[1].posted[0].type).toBe('init');
  });

  it('stop() with nothing running is harmless', () => {
    const { client } = newClient();
    expect(() => client.stop()).not.toThrow();
  });

  it('a reply from a REPLACED worker cannot settle the new run', async () => {
    // The dangerous case: stop() then run() again, and the dead worker's last
    // message arrives late. Ids are unique per run, so it must be ignored.
    const { client, made } = newClient();
    client.run('first');
    const firstId = made[0].posted.find(m => m.type === 'run').id;
    client.stop();
    client.run('second');

    made[0].onmessage({ data: { type: 'done', id: firstId } });
    expect(client.isRunning()).toBe(true);
  });
});
