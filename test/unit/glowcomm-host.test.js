'use strict';
// The vpython-jupyter front-end factory, fed the EXACT packages the transport
// emitted in the channel spike. The glow registry is a stub that records
// constructor calls — rendering correctness is Task 2's browser canary.
const { createGlowFrontend } = require('../../public/components/vpython-worker/glowcomm_host.js');

// MSG0: transport boot flush — canvas + lights. NOTE the second entry has NO
// `cmd` key ({"lights":"empty_list","idx":0}) — it exercises handle_cmds'
// non-constructor path; do not "fix" the fixture.
const MSG0 = {"cmds": [{"cmd": "canvas", "idx": 0}, {"lights": "empty_list", "idx": 0}, {"cmd": "distant_light", "idx": 2, "direction": [0.22, 0.44, 0.88], "color": [0.8, 0.8, 0.8], "canvas": 0}, {"cmd": "distant_light", "idx": 3, "direction": [-0.88, -0.22, -0.44], "color": [0.3, 0.3, 0.3], "canvas": 0}]};
// MSG1: sphere constructor + ball.pos=vector(1,2,3) as a compact attr code.
const MSG1 = {"cmds": [{"cmd": "sphere", "idx": 4, "color": [1.0, 0.0, 0.0], "size": [3.0, 3.0, 3.0], "canvas": 0}], "attrs": ["a4a1,2,3"]};

function stubGlow() {
  const calls = [];
  // `ret` is recorded too: idx-valued cfg keys (canvas, graph, v0…v3) are meant
  // to arrive as the constructed OBJECT, and only identity proves that.
  const mk = (name) => (cfg) => {
    const ret = { __stub: name, pos: null };
    calls.push({ name, cfg, ret });
    return ret;
  };
  const names = ['canvas','sphere','box','arrow','cone','cylinder','helix','pyramid','ring',
                 'curve','points','vertex','distant_light','local_light','label','graph','gcurve',
                 'gdots','gvbars','ghbars','vec','vector','attach_arrow','attach_trail'];
  const g = {}; names.forEach(n => g[n] = mk(n));
  g.vec = (x,y,z) => ({x,y,z,__vec:true}); g.vector = g.vec;
  return { g, calls };
}

describe('createGlowFrontend', () => {
  it('constructs canvas, lights, sphere from the captured stream', () => {
    const { g, calls } = stubGlow();
    const fe = createGlowFrontend({ container: null, send: () => {}, glow: g });
    fe.handle(MSG0); fe.handle(MSG1);
    const names = calls.map(c => c.name);
    expect(names).toContain('canvas');
    expect(names.filter(n => n === 'distant_light').length).toBe(2);
    expect(names).toContain('sphere');
  });

  it('converts vector-valued cfg entries via o2vec3', () => {
    const { g, calls } = stubGlow();
    createGlowFrontend({ container: null, send: () => {}, glow: g }).handle(MSG1);
    const sphere = calls.find(c => c.name === 'sphere');
    expect(sphere.cfg.color.__vec).toBe(true);          // [1,0,0] became a vec
    expect(sphere.cfg.size.__vec).toBe(true);
  });

  it('applies a compact attr code to the constructed object', () => {
    const { g, calls } = stubGlow();
    const fe = createGlowFrontend({ container: null, send: () => {}, glow: g });
    fe.handle(MSG0); fe.handle(MSG1);                    // "a4a1,2,3" → idx 4 pos=(1,2,3)
    const sphere = calls.find(c => c.name === 'sphere');
    // handle_attrs mutates the registry object handle_cmds stored
    expect(fe._objs()[4].pos).toEqual(g.vec(1,2,3));
  });

  it('tolerates the cmd-less entry and the bare trigger handshake', () => {
    const { g } = stubGlow();
    const fe = createGlowFrontend({ container: null, send: () => {}, glow: g });
    expect(() => { fe.handle(MSG0); fe.handle('trigger'); }).not.toThrow();
  });

  // Added after review: glow reads its mount point off window.__context, which is
  // also its own scratch space (canvas_selected / canvas_all / print_container),
  // and stores the container as a jQuery object — canvas.container.css(...) on the
  // print path throws on a raw element.
  it('merges into glow __context and hands the container to jQuery', () => {
    const { g } = stubGlow();
    globalThis.$ = (el) => ({ __jq: true, el });
    globalThis.__context = { canvas_all: ['pre-existing'] };
    try {
      const el = { tagName: 'DIV' };
      createGlowFrontend({ container: el, send: () => {}, glow: g }).handle(MSG0);
      expect(globalThis.__context.canvas_all).toEqual(['pre-existing']);  // merged, not replaced
      expect(globalThis.__context.glowscript_container.__jq).toBe(true);  // $-wrapped
      expect(globalThis.__context.glowscript_container.el).toBe(el);
    } finally {
      delete globalThis.$;
      delete globalThis.__context;
    }
  });

  // Added after review: a synthesized widget/bind event is NOT a safe no-op —
  // vpython.py's handle_msg indexes object_registry by evt['idx'] / evt['canvas']
  // and reads evt['value'], so a partial event raises inside the kernel loop.
  // The stubs must warn and drop until the real event capture is ported.
  it('widget bind stubs warn without sending a partial event', () => {
    const { g } = stubGlow();
    g.button = (cfg) => ({ __stub: 'button', cfg });
    const sent = [];
    const fe = createGlowFrontend({ container: null, send: (e) => sent.push(e), glow: g });
    fe.handle({ cmds: [{ cmd: 'canvas', idx: 0 }, { cmd: 'button', idx: 1, text: 'go', canvas: 0 }] });
    const bind = fe._objs()[1].cfg.bind;
    expect(typeof bind).toBe('function');   // glow gets a handler, as upstream
    bind(fe._objs()[1]);                    // what a real click would call
    expect(sent).toEqual([]);               // nothing invalid reaches Python
  });

  // Task 10. Captured verbatim from a worker run of
  //   graph(title=…); gcurve(graph=gd, color=color.blue);
  //   gdots(graph=gd, color=color.red, size=8)
  // Two things in it are load-bearing and easy to "tidy" into breakage:
  // `size` is a bare NUMBER (on gcurve/gdots it is a dot diameter, not a
  // vector — everywhere else in VPython `size` is a triple), and `graph: 4` is
  // an object idx that has to be resolved through the registry like `canvas`.
  // The 6 is not a typo for the 8 above: vpython's gobj.setup assigns `_size`
  // directly instead of through the derived `size` property, so the constructor
  // argument never takes effect. Upstream Python bug, out of scope here — the
  // fixture records what the wire ACTUALLY carries.
  const MSG_GRAPH = {"cmds": [
    {"cmd": "graph", "idx": 4, "title": "T", "xtitle": "x", "ytitle": "y"},
    {"cmd": "gcurve", "idx": 5, "color": [0, 0, 1], "graph": 4},
    {"cmd": "gdots", "idx": 6, "color": [1, 0, 0], "graph": 4, "size": 6}]};

  it('keeps gcurve/gdots size a scalar and resolves the graph idx', () => {
    const { g, calls } = stubGlow();
    const fe = createGlowFrontend({ container: null, send: () => {}, glow: g });
    fe.handle(MSG0); fe.handle(MSG_GRAPH);

    const dots = calls.find(c => c.name === 'gdots');
    // THE QUIRK: through o2vec3 this would be vec(undefined, undefined, undefined).
    expect(dots.cfg.size).toBe(6);
    expect(dots.cfg.size.__vec).toBeUndefined();
    // …and the branch is narrow — the neighbouring vector attribute still converts.
    expect(dots.cfg.color.__vec).toBe(true);

    // `graph` is an idx, like `canvas`: both plot objects must receive the
    // constructed graph object, not the integer 4.
    const graphObj = fe._objs()[4];
    expect(graphObj).toBe(calls.find(c => c.name === 'graph').ret);
    expect(dots.cfg.graph).toBe(graphObj);
    expect(calls.find(c => c.name === 'gcurve').cfg.graph).toBe(graphObj);

    // graph/gcurve/gdots are the constructors upstream strips `idx` from —
    // they throw on any argument they do not recognise.
    expect('idx' in calls.find(c => c.name === 'graph').cfg).toBe(false);
    expect('idx' in dots.cfg).toBe(false);
  });

  it('reset() clears the object registry', () => {
    const { g } = stubGlow();
    const fe = createGlowFrontend({ container: null, send: () => {}, glow: g });
    fe.handle(MSG0);
    fe.reset();
    expect(Object.keys(fe._objs()).length).toBe(0);
  });
});

// --- Task 9: the event channel ----------------------------------------------
// The shapes asserted here are a WIRE CONTRACT, not an implementation detail:
// vpython.py's handle_msg (:394-425) routes on the presence of 'widget' and
// 'trigger', then canvas.handle_event (:3287) destructures the rest. A missing
// key is a KeyError inside the kernel's message loop, so these tests are about
// the exact field set glowcomm.js emits, not about "an event was sent".

// A stub glow whose `canvas` static carries a hasmouse pointing at a fake
// canvas — the only way the browser tells Python the mouse moved or the camera
// turned. `equals` is glow's vector comparison; the port diffs with it.
function stubGlowWithMouse() {
  const { g, calls } = stubGlow();
  g.vec = (x, y, z) => ({
    x, y, z, __vec: true,
    equals: function (o) { return !!o && o.x === this.x && o.y === this.y && o.z === this.z; },
  });
  g.vector = g.vec;
  g.keysdown = () => [];
  // Each test installs its own `canvas` constructor over this one, returning the
  // fakeCanvas it wants to drive; `hasmouse` is the class static the port reads.
  g.canvas = Object.assign((cfg) => { calls.push({ name: 'canvas', cfg }); return {}; },
                           { hasmouse: null });
  return { g, calls };
}

// A canvas as glow presents one: an idx, a mouse, and the three user-motion
// flags update_canvas gates the camera fields on.
function fakeCanvas(g, idx) {
  const v = (x, y, z) => g.vec(x, y, z);
  return {
    idx,
    mouse: { pos: v(1, 2, 3), ray: v(0, 0, 1), alt: false, ctrl: false, shift: true },
    userspin: true, userpan: true, userzoom: true,
    forward: v(0, 0, -1), up: v(0, 1, 0), center: v(7, 8, 9),
    range: 1, autoscale: true,
    width: 640, height: 400,
  };
}

describe('createGlowFrontend event channel', () => {
  it('tick() on a still scene sends the bare pacing handshake', () => {
    const { g } = stubGlow();
    const sent = [];
    const fe = createGlowFrontend({ container: null, send: (e) => sent.push(e), glow: g });
    fe.handle(MSG0);
    fe.tick();
    // glowcomm.js send(): an empty tick is still a MESSAGE, because the message
    // is what makes the kernel flush its buffered updates. The transport skips
    // entries carrying 'trigger' rather than feeding them to handle_msg.
    expect(sent).toEqual([[{ event: 'update_canvas', trigger: 1 }]]);
  });

  it('tick() reports mouse and camera state for the canvas under the mouse', () => {
    const { g } = stubGlowWithMouse();
    const sent = [];
    const fe = createGlowFrontend({ container: null, send: (e) => sent.push(e), glow: g });
    const cvs = fakeCanvas(g, 0);
    g.canvas = Object.assign(() => cvs, { hasmouse: null });
    fe.handle({ cmds: [{ cmd: 'canvas', idx: 0 }] });
    g.canvas.hasmouse = cvs;

    fe.tick();
    expect(sent.length).toBe(1);
    const evt = sent[0][0];
    expect(evt.event).toBe('update_canvas');
    expect(evt.canvas).toBe(0);                  // the idx handle_msg indexes object_registry by
    expect(evt.pos).toEqual([1, 2, 3]);          // plain triples, not vectors: JSON has to carry them
    expect(evt.ray).toEqual([0, 0, 1]);
    expect(evt.forward).toEqual([0, 0, -1]);
    expect(evt.up).toEqual([0, 1, 0]);
    expect(evt.center).toEqual([7, 8, 9]);
    // ...and only what CHANGED: the diff is seeded at the origin, so a canvas
    // still sitting at center=(0,0,0) reports no center at all.

    // Nothing moved since: a still scene must fall back to the handshake, or an
    // idle student's mouse would re-send the whole camera 30 times a second.
    fe.tick();
    expect(sent[1]).toEqual([{ event: 'update_canvas', trigger: 1 }]);
  });

  it('ignores a canvas left in glow.hasmouse by a torn-down generation', () => {
    // canvas.hasmouse is a CLASS static and outlives reset(). Its idx would then
    // name a different object in Python's (persistent) registry.
    const { g } = stubGlowWithMouse();
    const sent = [];
    const fe = createGlowFrontend({ container: null, send: (e) => sent.push(e), glow: g });
    const cvs = fakeCanvas(g, 0);
    g.canvas = Object.assign(() => cvs, { hasmouse: null });
    fe.handle({ cmds: [{ cmd: 'canvas', idx: 0 }] });
    g.canvas.hasmouse = cvs;

    fe.reset();                                   // new generation; hasmouse still set
    fe.tick();
    expect(sent).toEqual([[{ event: 'update_canvas', trigger: 1 }]]);
  });

  it('a bound click reaches Python with every field handle_event reads', () => {
    const { g } = stubGlowWithMouse();
    const sent = [];
    const fe = createGlowFrontend({ container: null, send: (e) => sent.push(e), glow: g });
    const cvs = fakeCanvas(g, 0);
    let handler = null;
    cvs.bind = (types, fn) => { handler = fn; };
    g.canvas = Object.assign(() => cvs, { hasmouse: null });
    fe.handle({ cmds: [{ cmd: 'canvas', idx: 0 }] });
    // "mG click" — method code G is bind, applied to idx 0.
    fe.handle({ attrs: ['m0Gclick'] });
    expect(typeof handler, 'scene.bind() never reached a glow handler').toBe('function');

    // What glow hands a bound handler when the user clicks.
    handler({ type: 'click', canvas: cvs, pos: g.vec(4, 5, 6),
              press: false, release: true, which: 1 });

    expect(sent.length, 'the click was queued for a tick that will never come').toBe(1);
    expect(sent[0][0]).toEqual({
      event: 'click', canvas: 0,
      pos: [4, 5, 6],                      // handle_event -> list_to_vec -> evt.pos
      press: false, release: true, which: 1,
      ray: [0, 0, 1],                      // read off the canvas mouse, not the event
      alt: false, ctrl: false, shift: true, // handle_event reads all three for non-key events
      bind: true,                          // process_binding's marker
    });
  });

  it('batches events into the next tick while the host is pacing', () => {
    // The immediate flush above is the fallback for a host with no clock. With a
    // clock running, glowcomm.js's 33 ms coalescing is the point of the queue:
    // a bound mousemove must not cost one worker round trip per mouse pixel.
    const { g } = stubGlowWithMouse();
    const sent = [];
    const fe = createGlowFrontend({ container: null, send: (e) => sent.push(e), glow: g });
    const cvs = fakeCanvas(g, 0);
    let handler = null;
    cvs.bind = (types, fn) => { handler = fn; };
    g.canvas = Object.assign(() => cvs, { hasmouse: null });
    fe.handle({ cmds: [{ cmd: 'canvas', idx: 0 }] });
    fe.handle({ attrs: ['m0Gmousemove'] });

    fe.tick();                                   // the host's clock is now "running"
    sent.length = 0;
    const move = (x) => handler({ type: 'mousemove', canvas: cvs, pos: g.vec(x, 0, 0),
                                  press: false, release: false, which: 0 });
    move(1); move(2); move(3);
    expect(sent, 'each mouse event went out on its own despite a live clock').toEqual([]);

    fe.tick();
    expect(sent.length).toBe(1);
    expect(sent[0].map((e) => e.pos)).toEqual([[1, 0, 0], [2, 0, 0], [3, 0, 0]]);
  });

  it('reset() drops queued events — their idxs mean nothing to the next scene', () => {
    const { g } = stubGlowWithMouse();
    const sent = [];
    const fe = createGlowFrontend({ container: null, send: (e) => sent.push(e), glow: g });
    const cvs = fakeCanvas(g, 0);
    let handler = null;
    cvs.bind = (types, fn) => { handler = fn; };
    g.canvas = Object.assign(() => cvs, { hasmouse: null });
    fe.handle({ cmds: [{ cmd: 'canvas', idx: 0 }] });
    fe.handle({ attrs: ['m0Gmousemove'] });

    fe.tick();
    sent.length = 0;
    handler({ type: 'mousemove', canvas: cvs, pos: g.vec(1, 0, 0),
              press: false, release: false, which: 0 });
    expect(sent).toEqual([]);                    // queued, clock is live
    fe.reset();
    fe.tick();
    expect(sent).toEqual([[{ event: 'update_canvas', trigger: 1 }]]);
  });

  // --- I1: the host NOTIFIES, it is not inferred from a timer ----------------
  // A click landing in the ~100 ms after the pacer's FINAL tick still looks (to
  // the grace window) like it has a tick coming. It does not. Without an
  // explicit "the clock stopped" it sits in the queue until some later event
  // happens to flush it — which, for a program that has ended, may be never.

  function boundClickFixture() {
    const { g } = stubGlowWithMouse();
    const sent = [];
    const fe = createGlowFrontend({ container: null, send: (e) => sent.push(e), glow: g });
    const cvs = fakeCanvas(g, 0);
    let handler = null;
    cvs.bind = (types, fn) => { handler = fn; };
    g.canvas = Object.assign(() => cvs, { hasmouse: null });
    fe.handle({ cmds: [{ cmd: 'canvas', idx: 0 }] });
    fe.handle({ attrs: ['m0Gclick'] });
    const click = (x) => handler({ type: 'click', canvas: cvs, pos: g.vec(x, 0, 0),
                                   press: false, release: true, which: 1 });
    return { g, fe, cvs, sent, click };
  }

  it('pacingStopped() delivers a click queued just before the clock died', () => {
    const { fe, sent, click } = boundClickFixture();
    fe.tick();                 // the pacer's final tick
    sent.length = 0;
    click(9);                  // ...and the student clicks 5 ms later
    expect(sent, 'precondition: inside the grace window a click is queued').toEqual([]);

    fe.pacingStopped();        // stopVPythonPacer() says so
    expect(sent.length, 'the click was stranded in the queue').toBe(1);
    expect(sent[0][0].event).toBe('click');
    expect(sent[0][0].pos).toEqual([9, 0, 0]);
  });

  it('after pacingStopped() every later event flushes itself immediately', () => {
    const { fe, sent, click } = boundClickFixture();
    fe.tick();
    fe.pacingStopped();
    sent.length = 0;
    click(1);
    click(2);
    // Two messages, not one batch waiting for a tick: there is no tick.
    expect(sent.map((m) => m[0].pos)).toEqual([[1, 0, 0], [2, 0, 0]]);
  });

  it('pacingStopped() on an empty queue says nothing', () => {
    // The fixture has to make the guard EARNABLE. An earlier version used the
    // bare stubGlow, whose canvas static has no `hasmouse` — so update_canvas()
    // returned null and a mutant pacing_stopped() that drained and sent
    // unconditionally would have stayed silent too, for entirely the wrong
    // reason. Here the mouse IS over the canvas and the camera HAS moved since
    // the last tick, so the canvas poll has plenty to say: the only thing
    // keeping this quiet is flush()'s "empty queue -> don't poll, don't send".
    const { g } = stubGlowWithMouse();
    const sent = [];
    const fe = createGlowFrontend({ container: null, send: (e) => sent.push(e), glow: g });
    const cvs = fakeCanvas(g, 0);
    g.canvas = Object.assign(() => cvs, { hasmouse: null });
    fe.handle({ cmds: [{ cmd: 'canvas', idx: 0 }] });
    g.canvas.hasmouse = cvs;
    fe.tick();                                  // consume the initial diff
    sent.length = 0;
    cvs.forward = g.vec(1, 0, 0);               // the student orbited...
    cvs.mouse.pos = g.vec(5, 5, 5);             // ...and moved the mouse

    // Precondition, so the fixture cannot rot back into the accidental pass: a
    // tick right now WOULD have something to report.
    expect(fe.poll().length, 'the canvas poll had nothing to say — the guard below is vacuous')
      .toBeGreaterThan(0);
    sent.length = 0;
    cvs.forward = g.vec(0, 1, 0);               // move it again, so the diff is live
    fe.pacingStopped();
    expect(sent).toEqual([]);
  });

  it('the grace window remains as a backstop for a host that never says stop', () => {
    const { fe, sent, click } = boundClickFixture();
    // No tick has ever happened, so there is demonstrably no clock.
    click(3);
    expect(sent.length).toBe(1);
  });

  // --- Task 11: the two clocks ----------------------------------------------
  // While the student's own loop is calling rate(), the PROGRAM is flushing the
  // scene (up to rate_control.MAX_RENDERS a second) and the host's handshake is
  // pure overhead — measured at 91 host messages against 254 packages over three
  // seconds. poll() is the tick a host uses in that state: it does the half only
  // the browser can do and skips the half the program is already doing.

  it('poll() says nothing when the browser has nothing to say', () => {
    const { g } = stubGlow();
    const sent = [];
    const fe = createGlowFrontend({ container: null, send: (e) => sent.push(e), glow: g });
    fe.handle(MSG0);
    fe.tick();
    expect(sent, 'precondition: tick() DOES send the handshake').toEqual(
      [[{ event: 'update_canvas', trigger: 1 }]]);
    sent.length = 0;

    fe.poll();
    expect(sent, 'poll() sent the handshake anyway — it is just tick() again').toEqual([]);
  });

  it('poll() still carries queued events and current camera state', () => {
    // The saving is the empty handshake, not the browser's half of the channel:
    // a click, or a camera the student orbited mid-animation, must still get
    // through on a polled tick.
    const { g, fe, cvs, sent, click } = boundClickFixture();
    g.canvas.hasmouse = cvs;
    fe.tick();                       // consume the initial diff
    sent.length = 0;

    cvs.forward = g.vec(1, 0, 0);    // orbited while the animation runs
    click(7);
    fe.poll();

    expect(sent.length).toBe(1);
    expect(sent[0].map((e) => e.event)).toEqual(['click', 'update_canvas']);
    expect(sent[0][0].pos).toEqual([7, 0, 0]);
    expect(sent[0][1].forward).toEqual([1, 0, 0]);
  });

  it('poll() keeps the clock alive, so events still batch', () => {
    // poll() stamps last_tick like tick() does. If it did not, the grace window
    // would decide the clock had died and every mouse event during an animation
    // would pay its own round trip — the opposite of the point.
    const { fe, sent, click } = boundClickFixture();
    fe.poll();
    sent.length = 0;
    click(1); click(2);
    expect(sent, 'poll() left the front-end thinking the clock was gone').toEqual([]);
    fe.poll();
    expect(sent.length).toBe(1);
    expect(sent[0].map((e) => e.pos)).toEqual([[1, 0, 0], [2, 0, 0]]);
  });

  // --- I2: an event-driven flush still carries the canvas poll ---------------

  it('an immediate flush carries current camera state, not the run-end values', () => {
    // glowcomm.js polled the canvas on EVERY message out, because it only had
    // one path out. With no clock running, a handler that reads scene.forward or
    // keysdown() would otherwise see whatever was true when the clock stopped.
    const { g, fe, cvs, sent, click } = boundClickFixture();
    g.canvas.hasmouse = cvs;
    fe.tick();                                  // consume the initial diff
    sent.length = 0;

    cvs.forward = g.vec(1, 0, 0);               // the student orbited after the run ended
    cvs.mouse.pos = g.vec(5, 5, 5);
    fe.pacingStopped();                         // no clock from here on
    click(2);

    expect(sent.length).toBe(1);
    const msg = sent[0];
    // Upstream ordering: queued events first, then the canvas poll appended.
    expect(msg.map((e) => e.event)).toEqual(['click', 'update_canvas']);
    expect(msg[1].forward).toEqual([1, 0, 0]);
    expect(msg[1].pos).toEqual([5, 5, 5]);
  });

  it('pick and compound answers never wait for a tick', () => {
    // Python blocks inside _wait() for both, so a queued answer is a deadlock —
    // even with the host's clock running.
    const { g } = stubGlowWithMouse();
    const sent = [];
    g.compound = (objs, cfg) => ({ canvas: { idx: 0 }, pos: g.vec(1, 1, 1),
                                   size: g.vec(2, 2, 2), up: g.vec(0, 1, 0) });
    const fe = createGlowFrontend({ container: null, send: (e) => sent.push(e), glow: g });
    fe.handle({ cmds: [{ cmd: 'canvas', idx: 0 }] });
    fe.tick();
    sent.length = 0;
    fe.handle({ cmds: [{ cmd: 'compound', idx: 5, obj_idxs: [], canvas: 0 }] });
    expect(sent.length, 'the compound measurement waited for a tick').toBe(1);
    expect(sent[0][0]).toEqual({ event: '_compound', canvas: 0,
                                pos: [1, 1, 1], size: [2, 2, 2], up: [0, 1, 0] });
  });
});
