# Inline `console.input()` for Pyodide (python3) trinkets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give python3 (Pyodide) trinkets an inline, console-based input that reads like standard Python (`console.input(...)`), while leaving the existing `input()` popup working and fixing its prompt-ordering bug.

**Architecture:** Ship a small `console` Python module whose async `input()` awaits jqconsole's inline field (the same widget the Skulpt runner already uses), and reuse the WebVPython async source-transform — already in production — to insert the `await` so students write `console.input(...)` with no `await`. The transform is applied on the python3 path **only when the program imports `console`** (import-gate), and only rewrites `console.input()` calls (namespace scope). Existing `input()` (`window.prompt`) is untouched except for a small ordering fix.

**Tech Stack:** Pyodide (CPython/WASM), `pyodide.runPythonAsync` (top-level await), jqconsole (jQuery terminal), the pure-`ast` transform in `public/js/embed/wvpython/vpython/_async_transform.py`, Playwright (browser specs), dependency-free Python test runner (transform).

## Global Constraints

- **`input()` behavior is preserved.** Existing trinkets rely on the `window.prompt` path; the only change to it is *where the prompt echo is written* (Task 1). No trinket that uses `input()` may change behavior otherwise.
- **`_async_transform.py` is VENDORED from wmWVPRunner** and is "kept in sync with wmWVPRunner's test/test_async_transform.py" (see the header of `test/lib/wvpython/test_async_transform.py`). Console support must be a **backward-compatible addition**: with no `console` import present, the transform's output must be **byte-for-byte identical** to today's. Add a short comment marking the console addition as trinket-local / upstreamable so a future vendor-sync does not silently clobber it.
- **python3 programs that do NOT import `console` must be byte-for-byte unaffected** — the transform must not run on them at all (import-gate).
- **Namespace scope:** only `console.input()` (or an aliased `import console as c` → `c.input()`) is ever awaited. `builtins.input()`, and `foo.input()` on any non-`console` object, must never be awaited.
- **Embed-safe:** no new architecture — no Web Worker, no `SharedArrayBuffer`, no `COOP`/`COEP` headers, no new CDN/CORP dependency. Reuse `runPythonAsync` + jqconsole (both already loaded on the embed page).
- **Module name is `console`** (decision doc; the `console` vs `async_input` naming is flagged there as an open question — implement `console`).
- **Browser specs run on the make-gcp Playwright stack.** Per `reference_browser_smoke_tests`: stop the VeriDose emulators holding ports 8080/9099/4000, mask `config/local.yaml`, and restart the app container after first boot; restore the emulators after (`docker compose -f ~/Development/VeriDose/docker-compose.yaml up -d --no-deps --force-recreate firebase`). Transform tests need none of this — plain `python3`.
- Spec: `docs/pyodide-inline-input-decision.md`.

---

## File Structure

- `public/js/embed/pyodide.js` (modify) — the Pyodide runner. Owns stdout/stdin wiring, the `input()` override, jqconsole output, and the run dispatch. All JS glue lives here (consistent with the existing `input()` override and `runVpython` already in this file):
  - a `__trinket_console_write(text)` bridge (direct console write, bypasses buffered stdout) — used by Task 1 and Task 3.
  - a `__trinket_console_input(prompt)` bridge (inline jqconsole field → Promise) — Task 3.
  - a `CONSOLE_MODULE_CODE` constant + writing `console.py` into the Pyodide FS at init — Task 3.
  - `usesConsole(prog)` sniff + import-gated transform application on the python3 branch — Task 4.
- `public/js/embed/wvpython/vpython/_async_transform.py` (modify) — add backward-compatible recognition of `console.input()` — Task 2.
- `test/lib/wvpython/test_async_transform.py` (modify) — add console-transform cases — Task 2.
- `test/browser/specs/input.spec.js` (modify) — add ordering test (Task 1) and `console.input()` end-to-end tests (Tasks 3 & 4).

---

## Task 1: Ordering fix for legacy `input()` (prompt echoes before the dialog)

**Why:** `_trinket_input` does `print(prompt, end="")` then `js.window.prompt(...)`. `print(..., end="")` has no newline, so Pyodide's **batched** stdout buffers it and it never reaches the console DOM before the synchronous `window.prompt` modal opens — the user's complaint ("inputs came up before any text was printed"). Fix: echo the prompt via a **direct** console write (jqconsole, synchronous, not buffered) so it is in the DOM before the modal.

**Files:**
- Modify: `public/js/embed/pyodide.js` — add `__trinket_console_write` bridge (near `writeOut`, ~line 104); change `_trinket_input` (~lines 136–147).
- Test: `test/browser/specs/input.spec.js`

**Interfaces:**
- Produces: global `window.__trinket_console_write(text)` — writes `text` to the trinket console immediately (wraps `writeOut`). Reused by Task 3.

- [ ] **Step 1: Write the failing test** — append to `test/browser/specs/input.spec.js` inside the existing `describe('Pyodide input()')`:

```javascript
  test('the input() prompt is echoed to the console BEFORE the dialog opens', async ({ page }) => {
    // When the prompt dialog appears, the prompt text must already be visible in
    // the console (the old bug: print(prompt, end="") was buffered, so nothing
    // showed until after the dialog was dismissed).
    let consoleTextWhenDialogOpened = null;
    page.on('dialog', async (dialog) => {
      consoleTextWhenDialogOpened = await page.evaluate(() => {
        const out = document.querySelector('#outputContainer');
        return out ? (out.innerText || '') : '';
      });
      await dialog.accept('Ada');
    });

    await page.goto('/embed/python3');
    await expect(page.locator('.ace_editor')).toBeVisible();
    await page.evaluate(() => {
      document.querySelector('.ace_editor').env.editor.setValue(
        'name = input("your name? ")\nprint("hi", name)', 1);
    });
    await page.locator('.run-it').first().click();

    await expect(async () => {
      expect(consoleTextWhenDialogOpened).not.toBeNull();
      expect(consoleTextWhenDialogOpened).toContain('your name?'); // echoed before the modal
    }).toPass({ timeout: 90_000 });
  });
```

- [ ] **Step 2: Run it to confirm it fails**

Bring up the stack and run only the new test (see Global Constraints for the emulator/`local.yaml` prep):
```bash
npx playwright test test/browser/specs/input.spec.js -g "echoed to the console BEFORE" --reporter=line
```
Expected: FAIL — `consoleTextWhenDialogOpened` does not contain `your name?` (the echo was buffered).

- [ ] **Step 3: Add the direct-write bridge.** In `public/js/embed/pyodide.js`, immediately after the `writeOut` function (ends ~line 109), add:

```javascript
// Direct, synchronous console write that bypasses Pyodide's *batched* stdout
// (which buffers partial lines until a newline). Used to echo an input prompt
// into the console before a blocking window.prompt, and by the console module's
// inline input. Exposed on window so Pyodide's `from js import ...` can reach it.
window.__trinket_console_write = function(text) {
  writeOut(String(text));
};
```

- [ ] **Step 4: Echo the prompt directly instead of via buffered `print`.** In the `_trinket_input` definition (the `py.runPython([...])` array, ~lines 136–147), the function body already begins with `'    import js',` — leave that. Replace only the echo line:

```javascript
        '        print(prompt, end="")',
```
with:
```javascript
        '        js.window.__trinket_console_write(str(prompt))',
```
Leave the rest (`import js`, `r = js.window.prompt(...)`, the `EOFError` on cancel, `print(r)`, `return str(r)`) unchanged.

- [ ] **Step 5: Run the test to confirm it passes**

```bash
npx playwright test test/browser/specs/input.spec.js -g "echoed to the console BEFORE" --reporter=line
```
Expected: PASS. Also re-run the existing `input()` test to confirm no regression:
```bash
npx playwright test test/browser/specs/input.spec.js -g "reads from the prompt dialog" --reporter=line
```
Expected: PASS (`hi Ada`, no `I/O error`).

- [ ] **Step 6: Commit**

```bash
git add public/js/embed/pyodide.js test/browser/specs/input.spec.js
git commit -m "fix(pyodide): echo input() prompt to console before the dialog opens"
```

---

## Task 2: Teach the async transform to await `console.input()` (backward-compatible)

**Why:** The transform already inserts `await` before vpython primitives and colors callers async. We extend it to also await `console.input()` — but only when a `console` module alias is in scope — so `console.input(...)` can be written without `await`. This is pure-`ast` and unit-tested with the existing dependency-free runner. **No behavior change when `console` is not imported.**

**Files:**
- Modify: `public/js/embed/wvpython/vpython/_async_transform.py`
- Test: `test/lib/wvpython/test_async_transform.py`

**Interfaces:**
- Consumes: existing `transform_source(src) -> str`, `_module`-alias tracking, `_is_trigger_call(...)`.
- Produces: `transform_source` now inserts `await` before `<console-alias>.input(...)` calls and promotes/propagates async exactly as it does for vpython primitives. Public signature unchanged (`transform_source(src) -> str`).

- [ ] **Step 1: Write the failing tests.** In `test/lib/wvpython/test_async_transform.py`, add these functions just **before** the `if __name__ == "__main__":` block:

```python
# --- console.input(): awaited only on a `console` module alias -----------------

def test_console_input_toplevel_is_awaited():
    out = t("import console\nname = console.input('Name? ')\n")
    assert "await console.input(" in out

def test_console_input_aliased_import_is_awaited():
    out = t("import console as c\nname = c.input('Name? ')\n")
    assert "await c.input(" in out

def test_console_input_nested_is_awaited():
    out = t("import console\nn = int(console.input('n? '))\n")
    assert "await console.input(" in out

def test_console_input_in_user_function_promotes_and_propagates():
    src = (
        "import console\n"
        "def ask():\n"
        "    return console.input('x? ')\n"
        "v = ask()\n"
    )
    out = t(src)
    assert "async def ask" in out          # function that gained an await is async
    assert "await console.input(" in out
    assert "await ask()" in out            # caller of the now-async function is awaited

def test_console_input_output_is_valid_python():
    out = t("import console\nname = console.input('Name? ')\n")
    assert is_valid_python("async def _m():\n" + "".join("    " + ln + "\n" for ln in out.splitlines()))

def test_builtin_input_is_never_awaited():
    # No `console` import: input() is the untouched builtin — must NOT be awaited.
    out = t("name = input('Name? ')\n")
    assert "await" not in out

def test_input_attr_on_non_console_object_not_awaited():
    # `.input` on something that isn't a console module alias must not be awaited.
    src = "import console\nwidget = get_widget()\nwidget.input('x')\n"
    out = t(src)
    assert "await widget.input" not in out

def test_no_console_import_is_byte_for_byte_unchanged():
    # The backward-compat guarantee: without `console`, output == input.
    src = "x = 1\nprint(x)\ny = input()\n"
    assert t(src) == src
```

- [ ] **Step 2: Run to confirm they fail**

```bash
python3 test/lib/wvpython/test_async_transform.py
```
Expected: the new `test_console_*` and `test_input_attr_*` tests FAIL (`await console.input(` not present); the pre-existing 27 tests and the two guard tests (`test_builtin_input_is_never_awaited`, `test_no_console_import_is_byte_for_byte_unchanged`) PASS.

- [ ] **Step 3: Implement the backward-compatible extension** in `public/js/embed/wvpython/vpython/_async_transform.py`.

3a. Below `_BASE_AWAIT_ATTRS` (near the top), add:

```python
# Trinket-local addition (upstream candidate for wmWVPRunner; keep in sync).
# Namespaced primitives keyed by the module whose alias must own the call, so
# `console.input()` is awaited while `builtins.input()` / `widget.input()` are
# not. Awaited ONLY when the object is an in-scope alias of the named module.
_MODULE_AWAIT_ATTRS = {'console': frozenset({'input'})}
```

3b. Generalize the alias tracker. Replace the body of `_vpython_module_aliases` (or add a sibling and have it delegate) with a module-parameterized helper, keeping `_vpython_module_aliases` working for existing callers:

```python
def _module_aliases(tree, module):
    """Names bound to the top-level `module` package by an ``import`` statement.

    ``import M`` / ``import M.sub`` bind ``M``; ``import M as x`` binds ``x``.
    ``import M.sub as bar`` binds the submodule, not ``M``, so it's excluded.
    """
    aliases = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name == module:
                    aliases.add(a.asname or module)
                elif a.name.startswith(module + '.') and a.asname is None:
                    aliases.add(module)
    return aliases


def _vpython_module_aliases(tree):
    return _module_aliases(tree, 'vpython')
```

3c. Extend `_is_trigger_call` to also await configured module primitives. Add, as the final check on the `ast.Attribute` branch (before `return False`), a lookup against a `module_alias_map` argument — a dict `{module_name: set_of_aliases}`:

```python
        # Configured namespaced primitives (console.input()): awaited only when
        # the object is an in-scope alias of the owning module.
        if isinstance(func.value, ast.Name):
            for _mod, _attrs in _MODULE_AWAIT_ATTRS.items():
                if func.attr in _attrs and func.value.id in module_alias_map.get(_mod, ()):
                    return True
```

Thread `module_alias_map` through the same call path that already threads `vp_aliases`: add it as a parameter to `_is_trigger_call` and to `_compute_async` (mirroring `vp_aliases`), and in `transform_source` build it once with
```python
    module_alias_map = {mod: _module_aliases(tree, mod) for mod in _MODULE_AWAIT_ATTRS}
```
then pass it wherever `vp_aliases` is passed. (Follow the existing `vp_aliases` threading exactly — the tests in Step 1 pin the required behavior, so anything mis-threaded will fail them.)

- [ ] **Step 4: Run the tests to confirm all pass**

```bash
python3 test/lib/wvpython/test_async_transform.py
```
Expected: `N/N passed` — all pre-existing vpython tests **and** the new console tests green. If any pre-existing test changed output, the backward-compat constraint is violated — fix the threading so non-console programs are untouched.

- [ ] **Step 5: Commit**

```bash
git add public/js/embed/wvpython/vpython/_async_transform.py test/lib/wvpython/test_async_transform.py
git commit -m "feat(transform): await console.input() on a console module alias (backward-compatible)"
```

---

## Task 3: The `console` module + inline jqconsole input (`await console.input()` works)

**Why:** This is the runtime half — a `console` Python module whose async `input()` awaits an inline jqconsole field (mirroring the proven Skulpt `skulpt_inputfun`). Shippable and testable on its own with an explicit `await` (Flavor 1); Task 4 removes the need for `await`.

**Files:**
- Modify: `public/js/embed/pyodide.js` — add `__trinket_console_input` bridge; add `CONSOLE_MODULE_CODE`; write `console.py` into the FS at init.
- Test: `test/browser/specs/input.spec.js`

**Interfaces:**
- Consumes: `window.__trinket_console_write` (Task 1); `jqconsole`, `writeOut` (existing).
- Produces:
  - global `window.__trinket_console_input(prompt) -> Promise<string|null>` — appends `prompt` to jqconsole, opens the inline input field, resolves with the typed line (or `null` on cancel).
  - a `console` module importable in user code exposing `async def input(prompt='') -> str` (raises `EOFError` on cancel).

- [ ] **Step 1: Write the failing test.** Add a new describe block to `test/browser/specs/input.spec.js`:

```javascript
test.describe('Pyodide console.input()', () => {
  // Types into the inline jqconsole field (NOT a window.prompt dialog).
  async function answerInlineConsole(page, value) {
    await expect(page.locator('#console-output.console-active')).toBeVisible({ timeout: 90_000 });
    await page.locator('#console-output').click();
    await page.keyboard.type(value);
    await page.keyboard.press('Enter');
  }

  test('await console.input() reads inline from the console', async ({ page }) => {
    await page.goto('/embed/python3');
    await expect(page.locator('.ace_editor')).toBeVisible();
    await page.evaluate(() => {
      document.querySelector('.ace_editor').env.editor.setValue(
        'import console\nname = await console.input("your name? ")\nprint("hi", name)', 1);
    });
    await page.locator('.run-it').first().click();

    await answerInlineConsole(page, 'Ada');

    await expect(async () => {
      const text = await page.evaluate(() => {
        const out = document.querySelector('#outputContainer');
        return out ? (out.innerText || '') : '';
      });
      expect(text).toContain('your name?'); // prompt echoed inline
      expect(text).toContain('hi Ada');     // value returned
      expect(text).not.toContain('I/O error');
    }).toPass({ timeout: 90_000 });
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
npx playwright test test/browser/specs/input.spec.js -g "reads inline from the console" --reporter=line
```
Expected: FAIL — `import console` raises `ModuleNotFoundError` (module not created yet).

- [ ] **Step 3: Add the inline-input JS bridge.** In `public/js/embed/pyodide.js`, next to `__trinket_console_write` (from Task 1), add — mirroring `skulpt_inputfun` in `python.js`:

```javascript
// Inline console input for the `console` module: append the prompt, open a
// jqconsole input field, resolve with the typed line (null on cancel). Same
// widget/flow the Skulpt runner uses (python.js: skulpt_inputfun).
window.__trinket_console_input = function(prompt) {
  initConsoleOutput();
  window.readyForSnapshot = true;
  return new Promise(function(resolve) {
    if (prompt) { jqconsole.Write(String(prompt)); }
    var active = document.activeElement;
    $('#console-output').addClass('console-active');
    jqconsole.Input(function(line) {
      $('#console-output').removeClass('console-active');
      resolve(line);
      if (active) { try { $(active).focus(); } catch (e) {} }
    });
    jqconsole.Focus();
  });
};
```

- [ ] **Step 4: Add the `console` module source.** Near `MATPLOTLIB_SETUP_CODE` (~line 32), add:

```javascript
// The `console` module surfaced to python3 user code: an async input() that
// reads inline from the trinket console. `input()` (the builtin) is unchanged;
// this is an opt-in, importable alternative. runPythonAsync permits the await.
var CONSOLE_MODULE_CODE = [
  'import js',
  '',
  'async def input(prompt=""):',
  '    r = await js.window.__trinket_console_input(str(prompt) if prompt else "")',
  '    if r is None:',
  '        raise EOFError',
  '    return str(r)',
  ''
].join('\n');
```

- [ ] **Step 5: Write `console.py` into the Pyodide FS at init.** In the `loadPyodide(...).then(function(py){ ... })` block (where `_trinket_input` is installed, ~line 148), after that `try { py.runPython([...]) } catch {}`, add:

```javascript
    // Make `import console` resolve to the inline-input module (opt-in; the
    // builtin input() above is unchanged). Written to the FS root, which is on
    // sys.path, so a plain `import console` finds it.
    try {
      py.FS.writeFile('console.py', CONSOLE_MODULE_CODE);
    } catch (e) {}
```

- [ ] **Step 6: Run the test to confirm it passes**

```bash
npx playwright test test/browser/specs/input.spec.js -g "reads inline from the console" --reporter=line
```
Expected: PASS. If the inline field selector needs adjustment (jqconsole markup), tune `answerInlineConsole` until the typed value is accepted — the assertion (`hi Ada` inline, no `I/O error`) is the spec.

- [ ] **Step 7: Commit**

```bash
git add public/js/embed/pyodide.js test/browser/specs/input.spec.js
git commit -m "feat(pyodide): add console module with inline async input()"
```

---

## Task 4: Import-gated transform on the python3 path (`console.input()` without `await`)

**Why:** Deliver the student-facing goal — `console.input(...)` reads like ordinary Python. Apply the Task 2 transform on the python3 run path, but **only when the program imports `console`**, so every other program is byte-for-byte unchanged.

**Files:**
- Modify: `public/js/embed/pyodide.js` — add `usesConsole(prog)`; fetch + apply the transform in the python3 branch when `console` is used.
- Test: `test/browser/specs/input.spec.js`

**Interfaces:**
- Consumes: `transform_source` from `_async_transform.py` (fetched as a standalone module — it is pure `ast`, no vpython runtime); `runPythonAsync`; `usesVPython`, `usesMatplotlib` (existing sniff helpers).
- Produces: `usesConsole(prog) -> bool`; the python3 non-vpython branch transforms the source before `runPythonAsync` **iff** `usesConsole(prog)`.

- [ ] **Step 1: Write the failing tests.** Add to the `describe('Pyodide console.input()')` block:

```javascript
  test('console.input() works WITHOUT await (source is transformed)', async ({ page }) => {
    await page.goto('/embed/python3');
    await expect(page.locator('.ace_editor')).toBeVisible();
    await page.evaluate(() => {
      document.querySelector('.ace_editor').env.editor.setValue(
        'import console\nname = console.input("your name? ")\nprint("hi", name)', 1);
    });
    await page.locator('.run-it').first().click();
    await answerInlineConsole(page, 'Ada');
    await expect(async () => {
      const text = await page.evaluate(() => {
        const out = document.querySelector('#outputContainer');
        return out ? (out.innerText || '') : '';
      });
      expect(text).toContain('hi Ada');
      expect(text).not.toContain('SyntaxError'); // proves the await was inserted
      expect(text).not.toContain('coroutine');   // not left un-awaited
    }).toPass({ timeout: 90_000 });
  });

  test('a program that does not import console is unaffected', async ({ page }) => {
    await page.goto('/embed/python3');
    await expect(page.locator('.ace_editor')).toBeVisible();
    await page.evaluate(() => {
      document.querySelector('.ace_editor').env.editor.setValue(
        'print("no console here")\nprint(sum(range(5)))', 1);
    });
    await page.locator('.run-it').first().click();
    await expect(async () => {
      const text = await page.evaluate(() => {
        const out = document.querySelector('#outputContainer');
        return out ? (out.innerText || '') : '';
      });
      expect(text).toContain('no console here');
      expect(text).toContain('10');
    }).toPass({ timeout: 90_000 });
  });
```

- [ ] **Step 2: Run to confirm the no-await test fails**

```bash
npx playwright test test/browser/specs/input.spec.js -g "WITHOUT await" --reporter=line
```
Expected: FAIL — without the transform, `name = console.input(...)` assigns a coroutine (never awaited); output shows a `coroutine` warning / no `hi Ada`. (The "does not import console" test should already PASS — it is the guard.)

- [ ] **Step 3: Add the `usesConsole` sniff.** In `public/js/embed/pyodide.js`, next to `usesVPython` (~line 250):

```javascript
// True when the program opts into the inline console module. Gate for applying
// the async transform on the python3 path — programs that don't import console
// take the untouched runPythonAsync path.
function usesConsole(code) {
  return /(^|\n)\s*(import\s+console\b|from\s+console\b)/.test(code);
}
```

- [ ] **Step 4: Add a memoized loader for the standalone transform.** Near `ensureVpython` (~line 300), add — this loads the pure-`ast` transform without pulling in the vpython runtime:

```javascript
var ASYNC_TRANSFORM_URL = '/js/embed/wvpython/vpython/_async_transform.py';
var consoleTransformLoading = null;
// Fetch the pure-ast transform source and expose transform_source in a private
// module, WITHOUT importing the vpython package (heavy: glow/scene/etc.).
function ensureConsoleTransform() {
  if (consoleTransformLoading) return consoleTransformLoading;
  consoleTransformLoading = fetch(ASYNC_TRANSFORM_URL)
    .then(function(r) { return r.text(); })
    .then(function(src) {
      pyodide.FS.writeFile('_trinket_async_transform.py', src);
      return pyodide.runPythonAsync(
        'from _trinket_async_transform import transform_source');
    });
  return consoleTransformLoading;
}
```

- [ ] **Step 5: Apply the transform on the python3 branch when console is used.** In `runCode` (~line 1481), the plain fallthrough `return pyodide.runPythonAsync(prog || '');` at the end of the `loadPackagesFromImports(...).then(...)` block becomes gated:

```javascript
      if (usesConsole(prog)) {
        return ensureConsoleTransform().then(function() {
          pyodide.globals.set('__user_source__', prog || '');
          var asyncProg = pyodide.runPython(
            'transform_source(__user_source__)');
          return pyodide.runPythonAsync(asyncProg);
        });
      }
      return pyodide.runPythonAsync(prog || '');
```

(Leave the matplotlib sub-branch above it unchanged. A program that imports both `console` and matplotlib is out of scope for v1 — matplotlib trinkets rarely read input; note it and move on.)

- [ ] **Step 6: Run both tests to confirm they pass**

```bash
npx playwright test test/browser/specs/input.spec.js -g "WITHOUT await" --reporter=line
npx playwright test test/browser/specs/input.spec.js -g "does not import console" --reporter=line
```
Expected: both PASS. Then run the whole spec to confirm no regressions across Tasks 1, 3, 4:
```bash
npx playwright test test/browser/specs/input.spec.js --reporter=line
```
Expected: all input specs green.

- [ ] **Step 7: Commit**

```bash
git add public/js/embed/pyodide.js test/browser/specs/input.spec.js
git commit -m "feat(pyodide): import-gated console.input() transform on the python3 path"
```

---

## Final verification (after all tasks)

- [ ] Transform unit suite: `python3 test/lib/wvpython/test_async_transform.py` → `N/N passed`.
- [ ] Browser input suite (make-gcp stack up, per Global Constraints): `npx playwright test test/browser/specs/input.spec.js --reporter=line` → all green.
- [ ] Sanity: a WebVPython trinket still runs (the transform change is backward-compatible) — `npx playwright test test/browser/specs/webvpython.spec.js --reporter=line`.
- [ ] Restore the VeriDose emulators and unmask `config/local.yaml`.

## Notes / follow-ups (not in scope)

- **Default template comment:** surfacing `console.input()` in the new-python3 starter template is a nice-to-have; do it in a separate change once the feature lands.
- **`console` + matplotlib in one program:** the matplotlib sub-branch isn't transform-gated; out of scope for v1 (documented in Task 4 Step 5).
- **Naming:** decision doc flags `console` vs `async_input` as an open question for Andrew/Todd — this plan implements `console`.
- **Vendored-sync:** the `_async_transform.py` console addition should be offered upstream to wmWVPRunner so a future vendor-sync keeps it.
