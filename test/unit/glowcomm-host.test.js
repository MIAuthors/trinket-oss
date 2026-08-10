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
  const mk = (name) => (cfg) => { calls.push({ name, cfg }); return { __stub: name, pos: null }; };
  const names = ['canvas','sphere','box','arrow','cone','cylinder','helix','pyramid','ring',
                 'curve','points','vertex','distant_light','local_light','label','gcurve','gdots',
                 'vec','vector','attach_arrow','attach_trail'];
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
