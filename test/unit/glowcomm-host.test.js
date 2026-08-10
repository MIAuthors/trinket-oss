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

  it('reset() clears the object registry', () => {
    const { g } = stubGlow();
    const fe = createGlowFrontend({ container: null, send: () => {}, glow: g });
    fe.handle(MSG0);
    fe.reset();
    expect(Object.keys(fe._objs()).length).toBe(0);
  });
});
