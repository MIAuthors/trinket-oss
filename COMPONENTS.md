# Trinket Component Dependencies

Frontend components live in `public/components/` (gitignored, like node_modules).

Run `npm run setup-vendor` to install required components.

## Components by Feature

### Python Embed (`/embed/python`)
| Component | Repository | Version | Notes |
|-----------|------------|---------|-------|
| skulpt | [trinketapp/skulpt-dist](https://github.com/trinketapp/skulpt-dist) | 0.11.1.34 | Python-to-JS compiler (Trinket fork) |
| marked | [trinketapp/marked](https://github.com/trinketapp/marked) | master | Markdown parser (Trinket fork) |
| jq-console | [trinketapp/jq-console](https://github.com/trinketapp/jq-console) | v2.13.2.1 | Console/REPL UI |
| traqball.js | [trinketapp/traqball.js](https://github.com/trinketapp/traqball.js) | 1.0.3 | 3D rotation for turtle graphics |
| detectizr | [trinketapp/Detectizr](https://github.com/trinketapp/Detectizr) | 2.3.0 | Browser/device detection |

### Python3/Pygame Embed (`/embed/python3`, `/embed/pygame`)
Server-side execution - requires separate code runner service (not included).

Additional components:
| Component | Repository | Version | Notes |
|-----------|------------|---------|-------|
| systemjs | [systemjs/systemjs](https://github.com/systemjs/systemjs) | 0.21.3 | Module loader (pygame) |
| webrtc-adapter | [webrtc/adapter](https://github.com/webrtc/adapter) | 6.2.1 | WebRTC compatibility (pygame) |

### Blocks Embed (`/embed/blocks`)
| Component | Repository | Version | Notes |
|-----------|------------|---------|-------|
| blockly | [trinketapp/blockly](https://github.com/trinketapp/blockly) | v20211018 | Visual block editor (Trinket fork) |
| skulpt | (see above) | | |

### GlowScript Embed (`/embed/glowscript`)
| Component | Repository | Version | Notes |
|-----------|------------|---------|-------|
| glowscript | [trinketapp/glowscript](https://github.com/trinketapp/glowscript) | 2.7.5 | 3D graphics (Trinket fork) |
| vpython-glowscript | [trinketapp/vpython-glowscript](https://github.com/trinketapp/vpython-glowscript) | 3.2.2 | VPython bindings — **no longer referenced by anything.** The tarball still installs it; every loader now points at the 3.2.3 build below. Kept only as the on-disk rollback for the `GLOW_SRC` pin. |
| rsWVPRunner package | rsWVPRunner repo, deployed to `gs://rswvprunner/package/` | 3.2 (pinned locally as 3.2.3) | Current Web VPython runtime, and now the **only** glow build any path loads. Built by `build_package.py` in rsWVPRunner; the Dockerfile downloads `glow`/`RScompiler`/`RSrun` `3.2.min.js` from the bucket into `public/components/vpython-glowscript/package/` as `*.3.2.3.min.js`. The versionMap in `lib/views/embed/glowscript-config.html` points `3.2` at trinket version `3.2.3`; `GLOW_SRC` in `public/js/embed/pyodide.js` points the Pyodide VPython paths (main-thread bridge **and** the worker scene) at the same file. That is one renderer for `/embed/glowscript` and `/embed/python3` alike — a rebuild here now moves both at once. Includes the `glowscript.print` postMessage patch (in `lib/glow/api_misc.js` upstream) used by calculator runMode. |
| glowscript-blocks | [txst-per-group/Glowscript-Blocks](https://github.com/txst-per-group/Glowscript-Blocks) | 0.1.11 | Block editor for GlowScript |

### Worker VPython (`features.workerVPython`, opt-in)

`public/components/vpython-worker/` is **fetched, not committed** — like the
rest of this directory. Both files are release assets of
[vpython-jupyter](https://github.com/vpython/vpython-jupyter), pinned by tag
and sha256 in the Dockerfile's `ARG VPYTHON_WHEEL_RELEASE` block (currently
`v7.6.6.dev0`; the pin moves to the coordinated vpython-jupyter release when
that ships — the GitHub release, not PyPI, is the canonical artifact).

| Component | Source | Notes |
|-----------|--------|-------|
| glowcomm_host.js | vpython-jupyter release asset | Host-agnostic browser front-end for the VPython wire protocol — the ported half of glowcomm.js. |
| vpython-*.whl | vpython-jupyter release asset (pure-Python wheel) | Installed into Pyodide by the worker at run time. Filename is duplicated in `VPYTHON_WHEEL_NAME` (`public/js/embed/pyodide.js`). |

* **Images**: the Dockerfile fetches both files and verifies their sha256s —
  same pattern as the rsWVPRunner files above.
* **Local dev**: `scripts/sync-vpython-worker.sh` performs the identical fetch.
  It parses the Dockerfile's ARGs (so the two paths cannot drift) and reads
  `VPYTHON_WHEEL_NAME` back from pyodide.js (so a one-sided version bump fails
  at sync time instead of as a run-time 404).
* **Verifying a running deploy**: the page logs
  `[vpython] worker path: front-end <v>, wheel <file>` once at load.

**Edit these files in vpython-jupyter, never here.** A change means: land it
upstream, cut a release, update the Dockerfile's tag + sha256 ARGs, re-run the
sync script locally.


### Other Components
| Component | Repository | Version | Used By |
|-----------|------------|---------|---------|
| foundation | [trinketapp/bower-foundation](https://github.com/trinketapp/bower-foundation) | 5.5.3.1 | Base UI framework |
| closure-library | [google/closure-library](https://github.com/google/closure-library) | v20180204 | Blockly dependency |
| midi | [trinketapp/MIDI.js](https://github.com/trinketapp/MIDI.js) | master | Music embed |
| Processing.js | ? | ? | Processing embed |
| viewerjs | [nickvergessen/ViewerJS](https://github.com/nickvergessen/ViewerJS) | v0.2.1 | Document viewer |

### Skulpt Extension Modules (`.sk`)
These are Python modules that run in Skulpt:
| Component | Repository | Notes |
|-----------|------------|-------|
| json.sk | [trinketapp/json.sk](https://github.com/trinketapp/json.sk) | JSON support |
| xml.sk | [trinketapp/xml.sk](https://github.com/trinketapp/xml.sk) | XML support |
| processing.sk | [trinketapp/processing.sk](https://github.com/trinketapp/processing.sk) | Processing graphics |
| pygame.sk | [trinketapp/pygame.sk](https://github.com/trinketapp/pygame.sk) | Pygame compatibility |
| skulpt_numpy | [trinketapp/skulpt_numpy](https://github.com/trinketapp/skulpt_numpy) | NumPy subset |
| skulpt_matplotlib | [trinketapp/skulpt_matplotlib](https://github.com/trinketapp/skulpt_matplotlib) | Matplotlib subset |

## Feature Flags (TODO)

Eventually, features should be toggleable so users can skip unnecessary dependencies:

- `ENABLE_PYTHON_EMBED` - Basic Python (skulpt)
- `ENABLE_PYTHON3_EMBED` - Server-side Python3
- `ENABLE_BLOCKS_EMBED` - Visual blocks (blockly)
- `ENABLE_GLOWSCRIPT_EMBED` - 3D graphics
- `ENABLE_MUSIC_EMBED` - Music/MIDI
- `ENABLE_PYGAME_EMBED` - Pygame (server-side)

## Notes

- Most components are Trinket forks with customizations
- Original bower.json preserved for reference but bower is deprecated
- Components should be cloned/downloaded via setup script, not committed
