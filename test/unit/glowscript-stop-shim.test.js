'use strict';

// Runner-side half of the GlowScript Stop button. The shim runs INSIDE the
// program's sandboxed runner page; these tests drive it with a fake window.
// Spec: docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md

const { install, source } = require('../../public/js/embed/glowscript-stop-shim');

function fakeWindow(extra) {
  const listeners = [];
  const posted = [];
  const win = Object.assign({
    parent: { postMessage: (message) => posted.push(JSON.parse(message)) },
    addEventListener: (type, fn) => { if (type === 'message') { listeners.push(fn); } },
  }, extra);
  win.posted = posted;
  win.send = (data) => listeners.forEach((fn) => fn({ data }));
  return win;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const stoppedCount = (win) => win.posted.filter((m) => m['glowscript.stopped']).length;

describe('install', () => {
  it('announces itself to the page once', () => {
    const win = fakeWindow();
    install(win);
    expect(win.posted).toEqual([{ 'glowscript.ready': true }]);
  });

  it('is idempotent: a second install neither re-wraps nor re-announces', () => {
    const win = fakeWindow({ rate: () => Promise.resolve() });
    install(win);
    const wrapped = win.rate;
    install(win);
    expect(win.rate).toBe(wrapped);
    expect(win.posted).toHaveLength(1);
  });

  it('skips wait functions the runtime does not define', () => {
    const win = fakeWindow({ rate: () => Promise.resolve() });
    install(win);
    expect(win.sleep).toBeUndefined();
    expect(win.rate.__trinketStoppable).toBe(true);
  });
});

describe('promise-style waits (GlowScript 2.9 and later)', () => {
  it('pass values and errors through while no stop is requested', async () => {
    const win = fakeWindow({ rate: (n) => Promise.resolve(n * 2), sleep: () => Promise.reject(new Error('nope')) });
    install(win);
    await expect(win.rate(21)).resolves.toBe(42);
    await expect(win.sleep(1)).rejects.toThrow('nope');
  });

  it('a stop while a wait is pending confirms at once and never resumes the program', async () => {
    const pending = deferred();
    const win = fakeWindow({ rate: () => pending.promise });
    install(win);
    let resumed = false;
    win.rate(30).then(() => { resumed = true; });

    win.send('glowscript.stop');
    expect(stoppedCount(win)).toBe(1);

    pending.resolve();
    await tick();
    expect(resumed).toBe(false);
  });

  it('a stop while the program computes confirms at its next wait, which never returns', async () => {
    const win = fakeWindow({ rate: () => Promise.resolve() });
    install(win);
    win.send('glowscript.stop');
    expect(stoppedCount(win)).toBe(0);

    let resumed = false;
    win.rate(30).then(() => { resumed = true; });
    await tick();
    expect(stoppedCount(win)).toBe(1);
    expect(resumed).toBe(false);
  });

  it('a rejection after a stop does not reach the program either', async () => {
    const pending = deferred();
    const win = fakeWindow({ sleep: () => pending.promise });
    install(win);
    let settled = false;
    win.sleep(1).then(() => { settled = true; }, () => { settled = true; });
    win.send('glowscript.stop');
    pending.reject(new Error('late'));
    await tick();
    expect(settled).toBe(false);
  });

  it('confirms only once however many waits are parked', async () => {
    const win = fakeWindow({ rate: () => deferred().promise, sleep: () => deferred().promise });
    install(win);
    win.rate(30);
    win.sleep(1);
    win.send('glowscript.stop');
    win.send('glowscript.stop');
    win.rate(30);
    await tick();
    expect(stoppedCount(win)).toBe(1);
  });

  it('wraps canvas waits and keeps their receiver', async () => {
    function canvas() {}
    let receiver = null;
    canvas.prototype.waitfor = function () { receiver = this; return Promise.resolve('click'); };
    const win = fakeWindow({ canvas });
    install(win);
    const scene = new canvas();
    await expect(scene.waitfor('click')).resolves.toBe('click');
    expect(receiver).toBe(scene);
    expect(canvas.prototype.waitfor.__trinketStoppable).toBe(true);
  });
});

describe('callback-style waits (GlowScript 1.1 to 2.7)', () => {
  it('resume the program normally while no stop is requested', () => {
    let pendingCallback = null;
    const win = fakeWindow({ rate: (n, cb) => { pendingCallback = cb; } });
    install(win);
    let resumed = false;
    win.rate(30, () => { resumed = true; });
    pendingCallback();
    expect(resumed).toBe(true);
  });

  it('a stop while parked confirms at once and swallows the continuation', () => {
    let pendingCallback = null;
    const win = fakeWindow({ rate: (n, cb) => { pendingCallback = cb; } });
    install(win);
    let resumed = false;
    win.rate(30, () => { resumed = true; });
    win.send('glowscript.stop');
    expect(stoppedCount(win)).toBe(1);
    pendingCallback();
    expect(resumed).toBe(false);
  });
});

describe('messages', () => {
  it('ignores anything but the stop request', () => {
    const win = fakeWindow({ rate: () => deferred().promise });
    install(win);
    win.rate(30);
    win.send('glowscript.snapshot');
    win.send(JSON.stringify({ 'glowscript.stop': true }));
    expect(stoppedCount(win)).toBe(0);
  });
});

describe('source', () => {
  it('is a self-contained statement that installs the shim on `window`', () => {
    const win = fakeWindow({ rate: () => Promise.resolve() });
    new Function('window', source())(win);
    expect(win.posted).toEqual([{ 'glowscript.ready': true }]);
    expect(win.rate.__trinketStoppable).toBe(true);
  });
});
