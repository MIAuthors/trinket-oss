# Trinket Component Dependencies

Frontend components live in `public/components/` (gitignored, like node_modules)
— with one deliberate exception, `vpython-worker/`, which is **committed**; see
below.

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

### Worker VPython (`features.workerVPython`, opt-in) — **committed, not vendored**

`public/components/vpython-worker/` is the one directory here that is **in git**,
via a `.gitignore` negation. It is not installed by `setup-vendor` and there is
no upstream package to fetch: both files are build artifacts of a *sibling
checkout*, copied in by `scripts/sync-vpython-worker.sh`.

| Component | Source | Version | Notes |
|-----------|--------|---------|-------|
| glowcomm_host.js | [vpython-jupyter](https://github.com/vpython/vpython-jupyter) checkout, `vpython/vpython_libraries/` | 7.6.5 (`GLOWCOMM_HOST_VERSION`) | Host-agnostic browser front-end for the VPython wire protocol — the ported half of glowcomm.js. |
| vpython-*.whl | same checkout, `dist/` (`VPYTHON_PURE_PYTHON=1 … python3 -m build --wheel`) | 7.6.5 | Pure-Python vpython wheel the worker installs into Pyodide. Filename is duplicated in `VPYTHON_WHEEL_NAME` (`public/js/embed/pyodide.js`). |

**Edit them in vpython-jupyter, never here.** A `.py` change needs the wheel
rebuilt *first*; then run `scripts/sync-vpython-worker.sh`, which copies both
files, deletes any stale wheel, refuses to run if the filename or version does
not match what the page expects, and pushes the copies into the dev container
(the compose stack mounts a named volume over `public/components`, so a worktree
copy is otherwise invisible to a running stack). The page logs
`[vpython] worker path: front-end <v>, wheel <file>` once at load, which is how
you check a *running* deploy.

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
