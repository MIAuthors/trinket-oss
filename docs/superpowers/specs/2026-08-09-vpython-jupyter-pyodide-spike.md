# Spike: does `vpython-jupyter` run under Pyodide in the #108 Web Worker?

**Date:** 2026-08-09
**Branch:** `spike/vpython-jupyter-pyodide` (off `trial/convergence` @ `37f1964`)
**Question this answers:** §14–16 of the worker-runtime design proposed dropping
our bespoke Pyodide Web VPython bridge and adopting `vpython-jupyter` wholesale.
The recommended next step was "a spike, not an implementation: install `vpython`
into Pyodide in the worker, import it, and see how far it gets before it needs a
transport."

**Answer: it gets all the way to the transport, and stops exactly there.**
Everything before that is packaging, and every packaging blocker is fixable in a
repository Steve owns.

Run against the **real worker** on a live trinket (`?runtime=worker`), not a
simulation — real Pyodide 3.13.2, real micropip, real network.

---

## Findings, in the order they were hit

### 1. PyPI's `vpython` cannot be installed by micropip at all

```
INSTALL FAILED: ValueError
Can't find a pure Python 3 wheel for 'vpython'.
```

The published wheels are platform wheels, because `setup.py` declares
`ext_modules` for the Cython `cyvector`. micropip only accepts `py3-none-any`
(or an Emscripten wheel). `keep_going=True` adds nothing — `vpython` itself is
the blocker, so its dependency tree is never even evaluated.

### 2. `install_requires` declares the whole Jupyter stack as hard dependencies

```python
install_requires = ['jupyter', 'jupyter-server-proxy', 'jupyterlab-vpython>=3.1.8',
                    'notebook>=7.0.0', 'numpy', 'ipykernel', 'autobahn>=22.6.1, <27']
```

§14 established that `ipykernel` / `IPython` are imported **lazily** and that the
core module imports stdlib only. That is true of the *code* — but the *packaging*
says otherwise, and micropip believes the packaging. Even with a pure-Python
wheel, micropip would try to resolve `notebook`, `jupyter-server-proxy` and
`autobahn`, none of which it can.

**This is the single most important finding.** The barrier is metadata, not
implementation.

### 3. A pure-Python wheel builds without difficulty

Removing `ext_modules` and trimming `install_requires` to `['numpy']` produced
**`vpython-7.6.5-py3-none-any.whl`** (3.5 MB) on the first attempt, with no
source changes. It installs into the worker cleanly (`INSTALL OK`).

`_vector_import_helper.py` already falls back to the pure-Python `vector.py`
when `cyvector` is absent, so dropping the extension costs performance, not
function — and a rebuilt wasm `cyvector` wheel would drop straight back in
through that same helper.

3.5 MB is larger than it needs to be: the wheel bundles `vpython_data/`
(textures, fonts) and `vpython_libraries/` (its own `glow.min.js`, jquery,
plotly). Trinket serves its own GlowScript, so a slim wheel is worth having.

### 4. `pkg_resources` is missing in Pyodide

```
FAILED vpython.vector -> ModuleNotFoundError: No module named 'pkg_resources'
```

`await micropip.install("setuptools")` fixes it. `pkg_resources` is deprecated
upstream regardless; moving to `importlib.metadata` / `importlib.resources`
would remove the dependency and shrink the boot.

### 5. With that, the whole core imports **in the worker**

```
runtime: worker
OK  vpython.vector
OK  vpython.gs_version
OK  vpython.shapespaths
OK  vpython.rate_control
OK  vpython.vpython      ← the ~3000-line object protocol
```

No DOM, no `window`, no Jupyter. This is the result the proposal turned on.

### 6. Constructing an object stops at the transport — precisely where §14 said

```
_isnotebook = False
SPHERE FAILED: ModuleNotFoundError: No module named 'autobahn'
  File "vpython/vpython.py", line 267, in __init__
    from .no_notebook import _
  File "vpython/no_notebook.py", line 12, in <module>
    from autobahn.asyncio.websocket import WebSocketServerProtocol, ...
```

`vpython.py:265-267` picks `with_notebook` or `no_notebook` at runtime. In a
worker `_isnotebook` is `False`, so it takes `no_notebook`, which stands up an
`http.server` and autobahn websockets — meaningless here.

**That line is the entire remaining blocker.** A third transport whose `sender`
posts on the #108 channel is what §14 predicted, and this confirms the seam is
reached with nothing else in the way.

### 7. Aside: the router will need to change

`usesVPython()` sends any program containing `import vpython` to the main thread
(decision D2). This spike had to reach the worker via
`importlib.import_module("vpython.vpython")` to dodge that rule. If Web VPython
moves off-thread, that routing rule inverts — worth remembering, since it is the
mechanism that currently protects VPython users from the worker.

---

## What this changes

§14 recommended a spike before any implementation and treated GlowScript version
alignment as the biggest risk. The spike says the risk is elsewhere and smaller:

| §14 expected | The spike found |
|---|---|
| Cython may block installation | it does — but only via `ext_modules`; a pure wheel builds unchanged |
| jupyter imported lazily, so fine | true in code, **false in packaging** — that is the real blocker |
| core imports stdlib only | **confirmed, in the worker** |
| a transport seam exists | **confirmed** — execution stops exactly at `vpython.py:267` |
| GlowScript version alignment is the big risk | untouched by this spike; still open, but now downstream of transport work |

## Recommended next steps, cheapest first

1. **Packaging changes in `vpython-jupyter`** (Steve's repo): move the
   jupyter/autobahn stack to extras (`[notebook]`, `[standalone]`), drop
   `ext_modules` from the default build, publish a `py3-none-any` wheel
   alongside the platform wheels, and replace `pkg_resources`. None of this
   affects existing notebook users.
2. **A third transport** — `trinket_worker.py` beside `with_notebook.py` /
   `no_notebook.py`, whose `sender` posts on the #108 channel. Then the browser
   half: `glowcomm.js` rewritten against that channel rather than
   `IPython.notebook.kernel.comm_manager`.
3. **Only then** the GlowScript alignment question (§15/§16).

Steps 1 and 2 are the work; step 3 is where the risk that §14 worried about
actually lives.

## Reproducing

`scratchpad/vpython-probe.js` drives a real browser: it loads
`/embed/python3?runtime=worker`, types a probe program into the editor, clicks
Run, and reads `#console-output`. Probes: `install`, `deps`, `wheel`, `core`,
`transport`. The wheel was served to the worker by copying it into the dev
container's `public/` and installing from `http://localhost:3001/…`.

The `vpython-jupyter` clone was **not modified** — the build ran against a copy.
