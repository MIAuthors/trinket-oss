const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The #247 gate: features.mathOutput is a no-op for programs that do not ask
// for typeset output.
//
// WHY THIS EXISTS. The deploy-wide flag is safe only because the feature
// changes nothing for existing trinkets (#239, Andrew's condition): bare ints,
// strings, plain lists, matplotlib return values and module docstrings all stay
// silent, and only objects with `_repr_latex_` display. #247 made that
// "testable rather than arguable" the gate before the flag goes near
// trinket.gopicup.org. This file is that test.
//
// WHAT IT ASSERTS, per program, comparing a flag-OFF run with a flag-ON run of
// the same deploy:
//   1. #console-output text is IDENTICAL once the math cards are taken out --
//      and a program that produced no cards must be identical outright. The
//      one allowance: the first card of a page announces KaTeX with a single
//      "Loading math…" line (ensureKatex() in pyodide.js), which is part of the
//      card, not a change to the program's own output. It is removed only when
//      that run produced a card, and only once.
//   2. no .math-card appears unless the program imports SymPy (or the corpus
//      entry says why it may: see numpy-polynomial below).
//   3. flag-OFF produces no .math-card at all, ever.
//
// HOW IT IS INVOKED. By a person -- nothing runs this file automatically.
// specs-deploy/ is run by no workflow (#293: browser-smoke.yml ends with a bare
// `npx playwright test`, which takes the default config and testDir ./specs).
// The flag is read at server boot, so off and on are two runs of this file
// against ONE deploy, with the flag flipped and the server restarted between
// them. Order does not matter; the second run does the comparing.
//
//   # 1. flag off
//   TRINKET_BASE_URL=http://localhost:3000 npx playwright test \
//     -c playwright.deploy.config.js math-output-noop math-output
//   # 2. flip features.mathOutput, restart the server, run the same command again
//
// Each run records what it saw in test/browser/.mathoutput-noop/<host>.json
// (gitignored). A run that finds no record of the other phase SKIPS with a
// printed reason -- it is half a measurement, and must not read as a pass.
// Delete the file to start over.
//
// RUN math-output.spec.js ALONGSIDE IT (the command above does). That spec is
// the positive control: flag-off and a feature that silently does nothing both
// satisfy every assertion here, and only a control that MUST typeset tells the
// two apart. The built-in `sympy-bare` entry below is a second, in-corpus
// control, and it is always run for the same reason.
//
// THE CORPUS, and what a pass does and does not prove.
//   TRINKET_CORPUS=abc123,def456   short codes ON THE TARGET DEPLOY. This is
//                                  what #247 asks for, and the only mode that
//                                  says anything about the trinkets people
//                                  actually have there.
//   (unset)                        a built-in set of program SHAPES typed into
//                                  a blank embed. A pass proves "a no-op for
//                                  programs like these" -- NOT "a no-op for the
//                                  trinkets on <deploy>". Do not report one as
//                                  the other; the difference is why #247 exists.
//
// WHY IT LIVES HERE, AND DOES NOT SEED ITS OWN DATA. Every spec in this
// directory that can run anonymously does, and this one never signs in and
// never writes: a short code is opened read-only at /embed/python3/<code>, and
// the built-in programs are typed into the blank embed, exactly as
// math-output.spec.js does. That keeps it safe to aim at production, which is
// the one deploy it exists for -- ephemeral-identity.js refuses to mint an
// identity on trinket.gopicup.org at all, so a spec that created its corpus
// could never run where the gate is. Seeding would buy nothing locally either:
// a seeded trinket is a program somebody wrote for the test, which is the
// built-in corpus with a database write in front of it.
//
// OPTIONAL KNOBS
//   MATH_NOOP_RUNTIME=main|worker  append ?runtime= to every embed. Unset runs
//                                  the deploy's default, which is what students
//                                  get unless a trinket pins its runtime.
//   MATH_NOOP_ANSWER=3             the reply to every input() (default "3").
//
// A program must FINISH to be compared: a `while True: rate(30)` animation has
// no final console to compare, and this file fails it by name rather than
// comparing a timing-dependent prefix.

const SHORT_CODES = (process.env.TRINKET_CORPUS || '').split(/[\s,]+/).filter(Boolean);
const RUNTIME = process.env.MATH_NOOP_RUNTIME || '';
const ANSWER = process.env.MATH_NOOP_ANSWER || '3';
const RECORD_DIR = path.join(__dirname, '..', '.mathoutput-noop');

// How long one run may take. The first Run downloads and boots Pyodide from
// jsDelivr (~10 MB) plus whatever wheels the program imports.
const RUN_TIMEOUT = 150_000;

// ONE browser context for the whole file, a fresh PAGE per program. A page is
// a fresh interpreter, which is all the isolation a run needs; a context is
// also a fresh HTTP cache, and Playwright's default of one context per test
// would download Pyodide and its wheels again for every program -- hundreds of
// MB across a corpus, on someone else's CDN, possibly over a metered link.
let sharedContext = null;
async function freshPage(browser, baseURL) {
  if (!sharedContext) {
    sharedContext = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } });
  }
  return sharedContext.newPage();
}

// The built-in corpus. `cards` is what flag-ON must produce: 0 exactly, or
// 'some'. Every program terminates and is deterministic -- a program that
// prints random numbers differs from ITSELF, and would fail here for a reason
// that has nothing to do with the flag.
const BUILTIN = [
  {
    id: 'plain-script',
    cards: 0,
    code: [
      '"""A module docstring is a bare string expression, and must stay silent."""',
      'def area(r):',
      '    """So is a function docstring."""',
      '    3.14159 * r * r      # a bare expression inside a def',
      '    return 3.14159 * r * r',
      'total = 0',
      'for i in range(5):',
      '    total += i',
      '    i * 2                # a bare expression inside a loop',
      'print("total", total)',
      'print(f"area {area(2):.3f}")',
      'total;',
    ].join('\n'),
  },
  {
    id: 'bare-values',
    cards: 0,
    code: [
      '42',
      '"a string"',
      '[1, 2, 3]',
      '(1, "two", 3.0)',
      '{"a": 1, "b": [2, 3]}',
      'None',
      '3.5e-3',
      'print("bare values done")',
    ].join('\n'),
  },
  {
    id: 'student-object',
    // The classifier looks up _repr_latex_ on the TYPE, so a class whose
    // __getattr__ raises KeyError -- an everyday student bug -- must neither
    // typeset nor break a program that runs fine with the flag off.
    cards: 0,
    code: [
      'class Particle:',
      '    def __init__(self):',
      '        self.cache = {}',
      '    def __getattr__(self, name):',
      '        return self.cache[name]',
      '    def __repr__(self):',
      '        return "Particle()"',
      'p = Particle()',
      'p',
      'print("particle ok", repr(p))',
    ].join('\n'),
  },
  {
    id: 'numpy',
    cards: 0,
    code: [
      'import numpy as np',
      'x = np.linspace(0, 1, 5)',
      'x',
      'np.float64(2.5)',
      'print(x)',
      'print("mean", x.mean(), "sum", np.sum(x ** 2))',
      'm = np.array([[1, 2], [3, 4]])',
      'print(m @ m)',
    ].join('\n'),
  },
  {
    id: 'numpy-polynomial',
    // The exception to "no card without SymPy", and the reason the rule is
    // written with a way out. numpy's Polynomial has its own _repr_latex_, and
    // the feature's actual contract is "objects with _repr_latex_ display" --
    // so a bare Polynomial typesets with no SymPy anywhere. The non-card text
    // must still be identical.
    cards: 'some',
    why: 'numpy.polynomial.Polynomial defines _repr_latex_',
    code: [
      'from numpy.polynomial import Polynomial',
      'print("before")',
      'Polynomial([1, 2, 3])',
      'print("after")',
    ].join('\n'),
  },
  {
    id: 'matplotlib',
    cards: 0,
    code: [
      'import matplotlib.pyplot as plt',
      'plt.plot([0, 1, 2], [0, 1, 4])     # returns a list of Line2D',
      'plt.title("parabola")              # returns a Text',
      'plt.xlabel("t (s)")',
      'plt.show()',
      'print("plotted")',
    ].join('\n'),
  },
  {
    id: 'vpython',
    cards: 0,
    code: [
      'from vpython import *',
      'ball = sphere(pos=vector(0, 0, 0), radius=0.5)',
      'ball.velocity = vector(1, 0, 0)',
      'dt = 0.1',
      'for step in range(20):',
      '    rate(1000)',
      '    ball.pos = ball.pos + ball.velocity * dt',
      'ball.pos',
      'print("final x", round(ball.pos.x, 3))',
    ].join('\n'),
  },
  {
    id: 'input',
    cards: 0,
    code: [
      'name = input("name? ")',
      'n = int(input("how many? "))',
      'for i in range(n):',
      '    print("hello", name, i)',
      'n',
    ].join('\n'),
  },
  {
    id: 'traceback',
    // An error mid-program: the traceback is console text too, and the display
    // hook rewrites the module's statements, so line numbers are at stake.
    cards: 0,
    code: [
      'print("about to fail")',
      'values = [1, 2, 0]',
      'for v in values:',
      '    print(10 / v)',
    ].join('\n'),
  },
  {
    id: 'sympy-print-only',
    // Imports SymPy, so cards are ALLOWED -- but it only ever print()s, which
    // gives str(). A card here would mean print() had started typesetting.
    cards: 0,
    code: [
      'from sympy import symbols, integrate, sqrt, simplify',
      'x = symbols("x")',
      'print(integrate(sqrt(x), x))',
      'print(simplify((x**2 - 1) / (x - 1)))',
    ].join('\n'),
  },
  {
    id: 'sympy-bare',
    // THE IN-CORPUS POSITIVE CONTROL. Flag-on must typeset this; if it does
    // not, every "identical" above is as consistent with a dead feature as with
    // a correct one.
    cards: 'some',
    control: true,
    code: [
      'from sympy import symbols, Integral, sqrt',
      'x = symbols("x")',
      'print("BEFORE")',
      'Integral(sqrt(1/x), x)',
      'print("AFTER")',
    ].join('\n'),
  },
];

const CORPUS = SHORT_CODES.length
  ? SHORT_CODES.map((c) => ({ id: c, shortCode: c }))
      .concat(BUILTIN.filter((e) => e.control))
  : BUILTIN;

const IMPORTS_SYMPY = /^\s*(?:import\s+sympy\b|from\s+sympy(?:\.\w+)*\s+import\b)/m;

function embedUrl(entry) {
  const base = entry.shortCode ? '/embed/python3/' + encodeURIComponent(entry.shortCode)
                               : '/embed/python3';
  return RUNTIME ? base + '?runtime=' + encodeURIComponent(RUNTIME) : base;
}

// --- the record, one file per deploy ------------------------------------------

function recordPath(baseURL) {
  return path.join(RECORD_DIR, new URL(baseURL).host.replace(/[^\w.-]/g, '_') + '.json');
}
function loadRecord(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
}
function saveRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
}

// --- one run of one program -----------------------------------------------

async function runOnce(page, entry) {
  // finishRun() posts "complete" to window.parent; for a top-level page the
  // parent IS the window, so counting those messages is a completion signal
  // both runtimes share. readyForSnapshot is not: input() sets it too.
  await page.addInitScript(() => {
    window.__noopComplete = 0;
    window.addEventListener('message', (e) => {
      if (e.data === 'complete') window.__noopComplete++;
    });
  });
  // The main thread answers input() through window.prompt.
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? ANSWER : undefined));

  const resp = await page.goto(embedUrl(entry));
  expect(resp && resp.status(), 'the embed must load: ' + embedUrl(entry)).toBeLessThan(400);
  await expect(page.locator('.ace_editor').first()).toBeVisible();

  const html = await page.content();
  const flags = {
    math:   /mathOutput\s*:\s*true/.test(html),
    worker: /workerRuntime\s*:\s*true/.test(html),
  };

  if (!entry.shortCode) {
    await page.evaluate((src) => {
      document.querySelector('.ace_editor').env.editor.setValue(src, 1);
    }, entry.code);
  }

  // Every file, not just the one on screen: a multi-file trinket can import
  // SymPy from a helper module.
  const files = await page.evaluate(() => window.jQuery('#editor').codeEditor('getAllFiles'));
  const source = Object.keys(files).sort().map((k) => '# ' + k + '\n' + files[k]).join('\n');
  expect(source.trim().length, 'the trinket must have code to run').toBeGreaterThan(0);

  // The embed's own run event, which is what Ctrl-Enter uses. Clicking .run-it
  // at narrow widths opens the split button's menu and runs nothing.
  await page.evaluate(() =>
    window.jQuery('#editor').trigger('trinket.code.run', { action: 'code.run' }));

  // Wait for completion, answering input() on the worker (an inline jqconsole
  // field rather than a dialog) as it comes up.
  const input = page.locator('#console-output .jqconsole-input');
  const deadline = Date.now() + RUN_TIMEOUT;
  let finished = false;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => window.__noopComplete > 0)) { finished = true; break; }
    if (await input.isVisible().catch(() => false)) {
      const box = page.locator('textarea:not(.ace_text-input)');
      await box.pressSequentially(ANSWER);
      await box.press('Enter');
      // Let the field close before looking again, or a second answer lands in
      // the NEXT prompt and the console depends on timing.
      await expect(input).toBeHidden({ timeout: 10_000 }).catch(() => {});
    }
    await page.waitForTimeout(250);
  }

  const out = await page.evaluate(() => {
    const el = document.querySelector('#console-output');
    if (!el) return { text: '', bare: '', cards: 0 };
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.math-card-wrap, .math-card').forEach((n) => n.remove());
    // textContent, not innerText: below ~1100 px the output pane is tabbed and
    // innerText of the hidden console is ''.
    return {
      text:  el.textContent || '',
      bare:  clone.textContent || '',
      cards: el.querySelectorAll('.math-card').length,
    };
  });

  // The build, where the deploy reports one. Two phases on different builds
  // compare two programs, not one program with the flag flipped.
  const version = await page.request.get('/version').then((r) => r.json()).catch(() => ({}));

  return {
    finished,
    flags,
    commit: version.commit || 'unknown',
    sha: crypto.createHash('sha256').update(source).digest('hex').slice(0, 16),
    sympy: IMPORTS_SYMPY.test(source),
    ...out,
  };
}

// The one line the feature itself adds when -- and only when -- it typesets.
const KATEX_NOTICE = 'Loading math…\n';
function withoutKatexNotice(run) {
  return run.cards > 0 ? run.bare.replace(KATEX_NOTICE, '') : run.bare;
}

// First index where two strings differ, with a little of each around it --
// "not identical" on two 4 KB consoles is useless without this.
function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 60);
  return 'first difference at char ' + i + ':\n'
    + '  OFF: ' + JSON.stringify(a.slice(from, i + 60)) + '\n'
    + '  ON : ' + JSON.stringify(b.slice(from, i + 60));
}

test.describe('mathOutput is a no-op for programs that do not ask for it (#247)', () => {
  // Above the config's 90 s: one run may take RUN_TIMEOUT, and a mismatch
  // re-runs once to tell a flag effect from a program that differs from itself.
  // Must EXCEED 2 x RUN_TIMEOUT, or the test cap fires before the wait reports.
  test.describe.configure({ timeout: 2 * RUN_TIMEOUT + 60_000 });

  test.beforeAll(() => {
    console.log('  [math-noop] corpus: ' + (SHORT_CODES.length
      ? SHORT_CODES.length + ' short code(s) from TRINKET_CORPUS, plus the sympy-bare control'
      : BUILTIN.length + ' BUILT-IN program shapes -- this says nothing about the '
        + 'trinkets stored on the deploy; set TRINKET_CORPUS for that'));
  });

  test.afterAll(async () => {
    if (sharedContext) await sharedContext.close();
    sharedContext = null;
  });

  for (const entry of CORPUS) {
    test(entry.id, async ({ browser, baseURL }) => {
      const page = await freshPage(browser, baseURL);
      const run = await runOnce(page, entry);
      await page.close();
      const phase = run.flags.math ? 'on' : 'off';
      const other = phase === 'on' ? 'off' : 'on';
      const where = embedUrl(entry);

      expect(run.finished, entry.id + ' did not finish within ' + RUN_TIMEOUT / 1000 + ' s. '
        + 'A program that never ends has no final console to compare; drop it from the '
        + 'corpus. Console so far: ' + JSON.stringify(run.text.slice(-300))).toBe(true);

      // Record this phase before asserting anything else, so a failure below
      // still leaves a usable half for the next run.
      const file = recordPath(baseURL);
      const record = loadRecord(file);
      record[phase] = record[phase] || {};
      const key = entry.id + (RUNTIME ? '@' + RUNTIME : '');
      record[phase][key] = {
        at: new Date().toISOString(), url: where, worker: run.flags.worker, commit: run.commit,
        sha: run.sha, sympy: run.sympy, cards: run.cards, text: run.text, bare: run.bare,
      };
      saveRecord(file, record);

      expect(phase !== 'off' || run.cards === 0,
        'flag OFF must never produce a math card, and ' + entry.id + ' produced ' + run.cards)
        .toBe(true);

      const prev = record[other] && record[other][key];
      if (!prev) {
        console.log('  [math-noop] ' + entry.id + ': recorded mathOutput ' + phase.toUpperCase()
          + '; nothing to compare yet -- flip the flag, restart, and run again');
        test.skip(true, 'recorded the ' + phase + ' half only; the ' + other + ' half is missing');
      }

      // Refuse comparisons that would not mean anything.
      expect(prev.sha, entry.id + ' changed between the two runs (source sha '
        + prev.sha + ' -> ' + run.sha + '); re-record both halves').toBe(run.sha);
      expect(prev.worker, 'the deploy default runtime changed between the two runs '
        + '(workerRuntime ' + prev.worker + ' -> ' + run.flags.worker + ')').toBe(run.flags.worker);

      if (prev.commit !== 'unknown' && run.commit !== 'unknown') {
        expect(prev.commit, 'the deploy was REBUILT between the two runs; re-record both halves')
          .toBe(run.commit);
      } else {
        console.log('  [math-noop] ' + entry.id + ': the deploy reports no commit, so it '
          + 'cannot confirm both halves ran the same build');
      }

      const off = phase === 'off' ? record[phase][key] : prev;
      const on  = phase === 'on'  ? record[phase][key] : prev;

      // The cards rule.
      const allowed = entry.cards !== undefined ? entry.cards : (run.sympy ? 'some' : 0);
      if (allowed === 0) {
        expect(on.cards, entry.id + ' produced ' + on.cards + ' math card(s) with the flag on'
          + (run.sympy ? '' : ' and does not import SymPy')).toBe(0);
      } else if (entry.cards === 'some') {
        expect(on.cards, entry.id + ' must typeset with the flag on'
          + (entry.control ? ' -- this is the positive control, and without it every '
            + '"identical" in this run is as consistent with a dead feature as a working one'
            : ' (' + entry.why + ')')).toBeGreaterThan(0);
      } else if (on.cards > 0) {
        console.log('  [math-noop] ' + entry.id + ': imports SymPy and typeset ' + on.cards
          + ' card(s) with the flag on -- allowed; the text around them is still compared');
      }

      // The identity rule. With no cards, bare === text and nothing is
      // removed, so this IS the byte-for-byte console comparison #247 asks for.
      const onBare = withoutKatexNotice(on);
      if (off.bare === onBare) return;

      // Different. Is that the flag, or a program that differs from itself?
      // Re-run THIS phase once in a fresh context and see whether it agrees
      // with its own first run.
      const retry = await freshPage(browser, baseURL);
      const again = await runOnce(retry, entry);
      await retry.close();
      const selfConsistent = again.finished
        && withoutKatexNotice(again) === withoutKatexNotice(record[phase][key]);
      expect(off.bare, (selfConsistent
        ? 'FLAG EFFECT: ' + entry.id + ' prints different console text with mathOutput on, '
          + 'and a second ' + phase + ' run reproduced this phase exactly, so it is not noise. '
        : 'NONDETERMINISTIC: ' + entry.id + ' differs from ITSELF between two ' + phase
          + ' runs, so it cannot be evidence either way; drop it from the corpus. ')
        + firstDifference(off.bare, onBare)).toBe(onBare);
    });
  }
});
