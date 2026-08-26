'use strict';
// #108: message SHAPES only. Live worker behaviour is covered by
// test/browser/specs/worker-runtime.spec.js against a real stack — a fake Worker
// plus a fake Pyodide would only test the fakes.
const { buildRunReply, createSceneChannel, PROTOCOL_VERSION } = require('../../public/js/embed/pyodide-worker.js');

describe('worker protocol', () => {
  it('declares a protocol version so a stale cached worker is detectable', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('builds a done reply carrying the run id', () => {
    expect(buildRunReply('r1', { ok: true })).toEqual({ type: 'done', id: 'r1' });
  });

  it('builds an error reply carrying the RAW traceback (the page formats it)', () => {
    const reply = buildRunReply('r2', { ok: false, traceback: 'Traceback...\nValueError: x' });
    expect(reply).toEqual({ type: 'error', id: 'r2', traceback: 'Traceback...\nValueError: x' });
  });

  it('does not format the traceback itself — that is the page\'s job (#107)', () => {
    // The page owns formatPythonTraceback + escapeConsoleHtml. If the worker
    // started trimming frames, the two runtimes would drift apart.
    const raw = 'Traceback (most recent call last):\n  File "/lib/python313.zip/x.py", line 1\nValueError: x';
    expect(buildRunReply('r3', { ok: false, traceback: raw }).traceback).toBe(raw);
  });
});

// --- the vpython scene channel ---------------------------------------------
// `solicited` is the one thing on this channel the PAGE cannot work out for
// itself, and the page's pacer rests entirely on it (Task 11's two clocks): it
// stops sending its 33 ms handshake while the program is flushing on its own.
// Get the flag wrong in the "always true" direction and the pacer never backs
// off — the overhead it was built to remove comes straight back. Get it wrong
// the other way and the pacer stops driving a scene that needs driving.
//
// The interesting cases are all about WHEN the reply comes out relative to the
// dispatch call, which is why the channel is a pure factory: a fake dispatcher
// can flush synchronously (today), later (the JSPI shape decision V4 has in
// view), or not at all (a dispatch that threw).

describe('vpython scene channel', () => {
  function channel() {
    const posted = [];
    const errors = [];
    let dispatcher = null;
    const ch = createSceneChannel({
      post: (m) => posted.push(m),
      runId: () => 'run-1',
      generation: () => 7,
      dispatcher: () => dispatcher,
      onError: (e) => errors.push(String(e && e.message || e)),
    });
    return { ch, posted, errors, setDispatcher: (fn) => { dispatcher = fn; } };
  }

  it('wraps a package in the reserved scene-ops type, with id and generation', () => {
    const { ch, posted } = channel();
    ch.send('{"cmds":[]}');
    expect(posted).toEqual([{ type: 'scene-ops', id: 'run-1', generation: 7,
                              solicited: false, ops: '{"cmds":[]}' }]);
  });

  it('marks a flush the PROGRAM pushed as unsolicited', () => {
    // rate() triggering a render from inside the animation loop. Nothing asked
    // for this one; it is the signal that tells the pacer to get out of the way.
    const { ch, posted } = channel();
    ch.send('{"cmds":[{"cmd":"sphere"}]}');
    expect(posted[0].solicited).toBe(false);
  });

  it('marks the reply to a dispatch as solicited', () => {
    const { ch, posted, setDispatcher } = channel();
    setDispatcher(() => ch.send('"trigger"'));       // what _dispatch does today
    ch.dispatch('[{"trigger":1}]');
    expect(posted.length).toBe(1);
    expect(posted[0].solicited).toBe(true);
  });

  it('marks a DEFERRED reply solicited too — the flag is not call-stack timing', () => {
    // The failure this guards against is silent: under a transport that
    // suspends (JSPI, decision V4) the reply lands after dispatch() returns. An
    // "are we inside the call" boolean would call it unsolicited, the pacer
    // would read a still scene as a busy one and alternate tick/poll, and a
    // static scene would quietly drop to half its pacing with nothing failing.
    const { ch, posted, setDispatcher } = channel();
    let resume = null;
    setDispatcher(() => { resume = () => ch.send('"trigger"'); });
    ch.dispatch('[{"trigger":1}]');
    expect(posted.length, 'precondition: this dispatch flushed nothing yet').toBe(0);
    resume();
    expect(posted[0].solicited).toBe(true);
  });

  it('pairs replies with dispatches one for one', () => {
    const { ch, posted, setDispatcher } = channel();
    setDispatcher(() => ch.send('"trigger"'));
    ch.dispatch('[{"trigger":1}]');
    ch.dispatch('[{"trigger":1}]');
    ch.send('{"cmds":[]}');                          // ...and then rate() fires
    expect(posted.map((m) => m.solicited)).toEqual([true, true, false]);
  });

  it('a dispatch that threw does not steal the next program flush', () => {
    // No reply came, and none is coming. If the debt stayed on the books the
    // next thing rate() pushed would be counted as this dispatch's answer, and
    // the pacer would keep ticking through an animation for the rest of the run.
    const { ch, posted, errors, setDispatcher } = channel();
    setDispatcher(() => { throw new Error('boom'); });
    ch.dispatch('[{"trigger":1}]');
    expect(errors).toEqual(['boom']);
    expect(ch._owed()).toBe(0);
    ch.send('{"cmds":[]}');
    expect(posted[0].solicited).toBe(false);
  });

  it('a dispatch that threw AFTER flushing keeps the reply solicited', () => {
    const { ch, posted, setDispatcher } = channel();
    setDispatcher(() => { ch.send('"trigger"'); throw new Error('late boom'); });
    ch.dispatch('[{"trigger":1}]');
    expect(posted[0].solicited).toBe(true);
    expect(ch._owed()).toBe(0);
  });

  it('drops a trigger that arrives before the transport booted', () => {
    // A vpython run paces from the moment Run is clicked, so the first ticks
    // land while the wheel is still installing. Those are pacing, not data — and
    // crucially they must not be counted as owing a reply, or the transport's
    // very first flush (the eager boot handshake, which nobody asked for) would
    // be mislabelled solicited.
    const { ch, posted } = channel();
    ch.dispatch('[{"trigger":1}]');                  // no dispatcher installed yet
    expect(posted).toEqual([]);
    expect(ch._owed()).toBe(0);
    ch.send('"trigger"');                            // the eager boot flush
    expect(posted[0].solicited).toBe(false);
  });
});
