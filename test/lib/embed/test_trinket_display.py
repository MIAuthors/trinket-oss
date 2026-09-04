"""
Tests for embed/_trinket_display.py — the AST display hook and classifier behind
features.mathOutput.

The module is loaded directly from its file: it lives under public/js/embed/
because the page fetches it and writes it into the Pyodide filesystem, so it is
not importable as part of any package. Everything except run_program() is pure
standard library, which is what makes these tests possible outside Pyodide.

Run under BOTH 3.13 (what Pyodide 0.28.1 ships) and 3.14 (where Pyodide is
heading once #215 lifts the classic-worker cap). The ast node shapes are the
version-sensitive part of this feature, so the matrix is not optional.

    python3 test/lib/embed/test_trinket_display.py
"""
import ast
import importlib.util
import os
import sys

# inspect.CO_COROUTINE, spelled out so the test file stays import-light.
_CO_COROUTINE = 0x0080

_HERE = os.path.dirname(__file__)
_MODULE_PATH = os.path.join(
    _HERE, '..', '..', '..', 'public', 'js', 'embed', '_trinket_display.py')

_spec = importlib.util.spec_from_file_location('_trinket_display', _MODULE_PATH)
td = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(td)

# The async transform whose output this module has to compose with.
_TRANSFORM_PATH = os.path.join(
    _HERE, '..', '..', '..',
    'public', 'js', 'embed', 'wvpython', 'vpython', '_async_transform.py')
_tspec = importlib.util.spec_from_file_location('_async_transform', _TRANSFORM_PATH)
_tmod = importlib.util.module_from_spec(_tspec)
_tspec.loader.exec_module(_tmod)
transform_source = _tmod.transform_source


# ------------------------------------------------------------------- helpers

class Latexy(object):
    """Stand-in for a SymPy Printable: the only thing that matters is the method."""

    def __init__(self, latex='$x$', text='x'):
        self._latex = latex
        self._text = text

    def _repr_latex_(self):
        return self._latex

    def __str__(self):
        return self._text


class Exploding(object):
    def _repr_latex_(self):
        raise RuntimeError('student code in _repr_latex_')

    def __str__(self):
        return 'exploding'


class FakeSympy(object):
    """Minimal stand-in for the sympy module, for the container path."""

    @staticmethod
    def latex(obj):
        return r'\left[ x\right]'


def wrapped_calls(tree):
    """Line numbers passed to the hook, in source order."""
    out = []
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == td._HOOK_NAME):
            out.append(node.args[1].value)
    return sorted(out)


def run(src, sink=None, source_text=None, globals_=None):
    """Wrap, compile and exec ``src``; return (globals, recorded payloads)."""
    recorded = []
    td.install(sink if sink is not None else recorded.append,
               source_text if source_text is not None else src)
    tree = td.wrap_module(ast.parse(src))
    g = {} if globals_ is None else globals_
    exec(compile(tree, td._MAIN_FILENAME, 'exec'), g)
    return g, recorded


def reset():
    td.install(lambda payload: None, '')


def parse_async(src):
    """Parse to an AST with top-level ``await`` permitted.

    ``ast.parse`` has no ``flags`` parameter, so go through ``compile`` with
    ``PyCF_ONLY_AST`` — the same pair of flags Pyodide's CodeRunner uses.
    """
    return compile(src, td._MAIN_FILENAME, 'exec',
                   flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT | ast.PyCF_ONLY_AST)


# ---------------------------------------------------------------- the AST wrap

def test_wraps_every_module_level_expression():
    src = 'a\nb\nc\n'
    tree = td.wrap_module(ast.parse(src))
    assert wrapped_calls(tree) == [1, 2, 3], wrapped_calls(tree)


def test_does_not_wrap_inside_compound_statements():
    src = (
        'if x:\n'
        '    a\n'
        'for i in y:\n'
        '    b\n'
        'while x:\n'
        '    c\n'
        'with open(f) as h:\n'
        '    d\n'
        'def f():\n'
        '    e\n'
        'class K:\n'
        '    g\n'
        'top\n')
    tree = td.wrap_module(ast.parse(src))
    # Only the final module-level `top` on line 13 is wrapped.
    assert wrapped_calls(tree) == [13], wrapped_calls(tree)


def test_leading_docstring_is_left_alone():
    """Wrapping the docstring would silently blank __doc__.

    The plan text assumed wrapping a docstring was harmless because the
    classifier ignores strings. It is not: for module-level code,
    exec(compile(src, ..., 'exec'), g) stores a leading string constant as
    g['__doc__'], so wrapping it turns a program's __doc__ into None. That is a
    behaviour change with the flag on, which the feature is not allowed to make,
    so the docstring position is skipped.
    """
    src = "'''my program'''\n1 + 1\n"
    tree = td.wrap_module(ast.parse(src))
    assert wrapped_calls(tree) == [2], wrapped_calls(tree)

    g, _ = run(src)
    assert g.get('__doc__') == 'my program', repr(g.get('__doc__'))


def test_docstring_is_preserved_exactly_as_without_the_wrap():
    src = "'''doc'''\nx = 1\n"
    plain = {}
    exec(compile(ast.parse(src), '<exec>', 'exec'), plain)
    hooked, _ = run(src)
    assert hooked.get('__doc__') == plain.get('__doc__')


def test_a_non_first_bare_string_is_wrapped_but_stays_silent():
    src = 'x = 1\n"just a string"\n'
    tree = td.wrap_module(ast.parse(src))
    assert wrapped_calls(tree) == [2], wrapped_calls(tree)
    _, recorded = run(src)
    assert recorded == [], recorded


def test_lineno_matches_the_original_statement():
    src = 'x = 1\n\n\nexpr\n'
    tree = td.wrap_module(ast.parse(src))
    assert wrapped_calls(tree) == [4], wrapped_calls(tree)


def test_locations_are_complete_and_end_lineno_survives():
    src = 'x = 1\nfoo(\n  1,\n  2)\n'
    tree = td.wrap_module(ast.parse(src))
    stmt = tree.body[1]
    assert isinstance(stmt, ast.Expr)
    assert stmt.lineno == 2, stmt.lineno
    assert stmt.end_lineno == 4, stmt.end_lineno
    # fix_missing_locations must have reached every synthesised node.
    for node in ast.walk(tree):
        if isinstance(node, (ast.expr, ast.stmt)):
            assert hasattr(node, 'lineno') and node.lineno is not None, ast.dump(node)


def test_a_second_wrap_would_nest_so_the_runner_must_wrap_once():
    """Documents that wrap_module is NOT idempotent.

    Nothing guards against re-wrapping, so run_program() must be the single
    place it is applied. If a caller ever wraps twice the hook fires twice per
    expression, which is why this is pinned by a test rather than left to
    memory.
    """
    tree = td.wrap_module(ast.parse('expr\n'))
    assert wrapped_calls(tree) == [1]
    td.wrap_module(tree)
    assert wrapped_calls(tree) == [1, 1], wrapped_calls(tree)


def test_empty_and_statement_only_modules_are_untouched():
    for src in ('', 'x = 1\n', 'import os\n'):
        tree = td.wrap_module(ast.parse(src))
        assert wrapped_calls(tree) == [], (src, wrapped_calls(tree))


def test_wrap_module_tolerates_a_non_module_tree():
    assert td.wrap_module(ast.parse('x', mode='eval')) is not None


# ----------------------------------------------------- execution through the hook

def test_hook_returns_its_argument():
    src = 'x = 1\nx\n'
    tree = td.wrap_module(ast.parse(src))
    # Mimic Pyodide's last_expr return mode: split the trailing expression off
    # and evaluate it, which is only correct if the hook is transparent.
    last = tree.body.pop()
    reset()
    g = {}
    exec(compile(tree, '<exec>', 'exec'), g)
    value = eval(compile(ast.Expression(body=last.value), '<exec>', 'eval'), g)
    assert value == 1, value


def test_typesettable_values_reach_the_sink_in_order():
    src = 'a = A()\na\nb = A()\nb\n'
    recorded = []
    td.install(recorded.append, src)
    tree = td.wrap_module(ast.parse(src))
    exec(compile(tree, td._MAIN_FILENAME, 'exec'), {'A': Latexy})
    assert [p['lineno'] for p in recorded] == [2, 4], recorded
    assert [p['latex'] for p in recorded] == ['x', 'x'], recorded


def test_plain_values_are_silent():
    src = '1\n"text"\nx = 2\nNone\n[1, 2]\n{}\n'
    _, recorded = run(src)
    assert recorded == [], recorded


def test_source_echo_carries_the_students_line():
    src = 'import os\nsol = A(); sol\n'
    recorded = []
    td.install(recorded.append, src)
    tree = td.wrap_module(ast.parse(src))
    exec(compile(tree, td._MAIN_FILENAME, 'exec'), {'A': Latexy})
    assert len(recorded) == 1, recorded
    assert recorded[0]['source'] == 'sol = A(); sol', repr(recorded[0]['source'])
    assert recorded[0]['lineno'] == 2


def test_source_echo_spans_a_multiline_expression():
    src = 'f = A\nf(\n  1,\n  2)\n'
    recorded = []

    def make(*_a):
        return Latexy()

    td.install(recorded.append, src)
    tree = td.wrap_module(ast.parse(src))
    exec(compile(tree, td._MAIN_FILENAME, 'exec'), {'A': make})
    assert len(recorded) == 1, recorded
    assert recorded[0]['source'] == 'f(\n  1,\n  2)', repr(recorded[0]['source'])


def test_display_builtin_works_inside_a_loop():
    src = 'for i in range(3):\n    display(A())\n'
    recorded = []
    td.install(recorded.append, src)
    tree = td.wrap_module(ast.parse(src))
    exec(compile(tree, td._MAIN_FILENAME, 'exec'), {'A': Latexy, 'display': td.display})
    assert len(recorded) == 3, recorded
    assert [p['lineno'] for p in recorded] == [2, 2, 2], recorded
    assert all(p['source'] == 'display(A())' for p in recorded), recorded


def test_display_is_installed_on_builtins():
    reset()
    import builtins
    assert builtins.display is td.display
    assert getattr(builtins, td._HOOK_NAME) is td._hook


def test_display_of_a_plain_value_is_silent():
    recorded = []
    td.install(recorded.append, 'display(1)\n')
    td.display(1, 'text', None)
    assert recorded == [], recorded


def test_display_accepts_several_objects():
    recorded = []
    td.install(recorded.append, 'display(A(), A())\n')
    td.display(Latexy(), Latexy())
    assert len(recorded) == 2, recorded


def test_a_failing_sink_never_breaks_the_program():
    def bad(_payload):
        raise RuntimeError('sink is broken')

    src = 'A()\n'
    td.install(bad, src)
    tree = td.wrap_module(ast.parse(src))
    exec(compile(tree, td._MAIN_FILENAME, 'exec'), {'A': Latexy})  # must not raise


def test_a_raising_repr_latex_is_silent_not_fatal():
    src = 'E()\n'
    recorded = []
    td.install(recorded.append, src)
    tree = td.wrap_module(ast.parse(src))
    exec(compile(tree, td._MAIN_FILENAME, 'exec'), {'E': Exploding})
    assert recorded == [], recorded


def test_traceback_still_points_at_the_students_line():
    """The wrap must not move the line a traceback reports."""
    src = 'x = 1\nboom()\n'
    reset()
    tree = td.wrap_module(ast.parse(src))
    try:
        exec(compile(tree, td._MAIN_FILENAME, 'exec'), {})
    except NameError:
        tb = sys.exc_info()[2]
        while tb.tb_next is not None:
            tb = tb.tb_next
        assert tb.tb_lineno == 2, tb.tb_lineno
    else:
        raise AssertionError('expected a NameError')


# ------------------------------------------------ composing with the async transform

def test_composes_with_the_async_transform():
    src = (
        'import vpython\n'
        'def step():\n'
        '    rate(30)\n'
        'expr\n'
        'rate(30)\n')
    transformed = transform_source(src)
    # The transform preserves line numbers, which is the property this relies on.
    assert len(transformed.splitlines()) == len(src.splitlines())
    tree = parse_async(transformed)
    td.wrap_module(tree)
    # Both module-level expressions wrapped: `expr` and the awaited rate() call.
    assert wrapped_calls(tree) == [4, 5], wrapped_calls(tree)
    code = compile(tree, td._MAIN_FILENAME, 'exec',
                   flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    assert code.co_flags & _CO_COROUTINE, 'top-level await must still compile async'


def test_top_level_await_survives_the_wrap():
    src = 'await thing()\n'
    tree = parse_async(src)
    td.wrap_module(tree)
    # `await` is legal as a call argument, so wrapping it is safe.
    assert wrapped_calls(tree) == [1], wrapped_calls(tree)
    code = compile(tree, td._MAIN_FILENAME, 'exec',
                   flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    assert code.co_flags & _CO_COROUTINE, 'wrapped top-level await must stay a coroutine'


# --------------------------------------------------------------- the classifier

def test_repr_latex_string_forms():
    assert td._latex_of(Latexy('$x$')) == 'x'
    assert td._latex_of(Latexy('$$x$$')) == 'x'
    assert td._latex_of(Latexy(r'$\displaystyle \int x\, dx$')) == r'\displaystyle \int x\, dx'
    assert td._latex_of(Latexy('x')) == 'x'          # no delimiters at all


def test_displaystyle_is_kept():
    """The renderer runs with displayMode:false and relies on \\displaystyle."""
    out = td._latex_of(Latexy(r'$\displaystyle \frac{1}{2}$'))
    assert out.startswith(r'\displaystyle'), out


def test_repr_latex_returning_none_or_empty_is_silent():
    assert td._latex_of(Latexy(None)) is None
    assert td._latex_of(Latexy('')) is None
    assert td._latex_of(Latexy('   ')) is None


def test_repr_latex_returning_a_tuple():
    class T(object):
        def _repr_latex_(self):
            return ('$x$', {'meta': 1})

    assert td._latex_of(T()) == 'x'


def test_repr_latex_returning_an_empty_tuple_is_silent():
    class T(object):
        def _repr_latex_(self):
            return ()

    assert td._latex_of(T()) is None


def test_plain_values_classify_as_none():
    for value in (1, 0, -3, 2.5, 'text', b'bytes', None, True, [], (), {},
                  [1, 2], {'a': 1}, object()):
        assert td._latex_of(value) is None, repr(value)


def test_container_of_typesettable_objects_needs_sympy_loaded():
    items = [Latexy(), Latexy()]
    assert 'sympy' not in sys.modules
    assert td._latex_of(items) is None, 'must not typeset without sympy loaded'

    sys.modules['sympy'] = FakeSympy
    try:
        assert td._latex_of(items) == r'\left[ x\right]'
        assert td._latex_of((Latexy(),)) == r'\left[ x\right]'
        assert td._latex_of({Latexy(): Latexy()}) == r'\left[ x\right]'
        assert td._latex_of([[Latexy()], [Latexy()]]) == r'\left[ x\right]'
        # A container with a non-typesettable leaf stays silent.
        assert td._latex_of([Latexy(), 1]) is None
        assert td._latex_of({'a': Latexy()}) is None
        assert td._latex_of([]) is None
    finally:
        del sys.modules['sympy']


def test_the_module_never_imports_sympy():
    """Importing SymPy costs ~3.3 s; only the student's program may pay it."""
    assert 'sympy' not in sys.modules
    td._latex_of([Latexy()])
    td._latex_of(Latexy())
    td._latex_of(1)
    reset()
    td.display(Latexy(), [Latexy()], 1)
    assert 'sympy' not in sys.modules


def test_deeply_nested_containers_do_not_recurse_forever():
    deep = Latexy()
    for _ in range(20):
        deep = [deep]
    sys.modules['sympy'] = FakeSympy
    try:
        assert td._latex_of(deep) is None
    finally:
        del sys.modules['sympy']


def test_self_referential_container_is_silent_not_fatal():
    loop = []
    loop.append(loop)
    sys.modules['sympy'] = FakeSympy
    try:
        assert td._latex_of(loop) is None
    finally:
        del sys.modules['sympy']


# --------------------------------------------------------------- payload shape

def test_payload_shape_and_text_fallback():
    recorded = []
    td.install(recorded.append, 'A()\n')
    td.display(Latexy('$x$', 'Symbol("x")'))
    assert len(recorded) == 1
    payload = recorded[0]
    assert set(payload) == {'latex', 'text', 'lineno', 'source'}, sorted(payload)
    assert payload['latex'] == 'x'
    assert payload['text'] == 'Symbol("x")'


def test_text_fallback_is_a_single_line():
    recorded = []
    td.install(recorded.append, '')
    td.display(Latexy('$M$', 'Matrix([[1, 2],\n        [3, 4]])'))
    assert '\n' not in recorded[0]['text'], repr(recorded[0]['text'])


def test_text_fallback_survives_a_broken_str():
    class BadStr(object):
        def _repr_latex_(self):
            return '$x$'

        def __str__(self):
            raise RuntimeError('no str for you')

    recorded = []
    td.install(recorded.append, '')
    td.display(BadStr())
    assert recorded[0]['text'] == ''


def test_source_is_empty_when_the_line_is_out_of_range():
    recorded = []
    td.install(recorded.append, 'short\n')
    td._emit(Latexy(), 999)
    assert recorded[0]['source'] == ''
    assert recorded[0]['lineno'] == 999


def test_set_source_resets_between_runs():
    td.install(lambda p: None, 'first line\n')
    assert td._source_at(1) == 'first line'
    td.set_source('a totally different line\n')
    assert td._source_at(1) == 'a totally different line'


def test_no_sink_installed_is_not_an_error():
    td._sink = None
    td._emit(Latexy(), 1)     # must not raise


if __name__ == "__main__":
    # Dependency-free runner so CI can invoke this file directly (also works
    # under pytest). Exits non-zero on any failure.
    _fns = [v for k, v in sorted(globals().items())
            if k.startswith("test_") and callable(v)]
    _failed = 0
    for _fn in _fns:
        reset()
        try:
            _fn()
            print("PASS", _fn.__name__)
        except AssertionError as _e:
            _failed += 1
            print("FAIL", _fn.__name__, "-", _e or "assertion failed")
        except Exception as _e:  # noqa: BLE001
            _failed += 1
            print("ERROR", _fn.__name__, "-", repr(_e))
    print()
    print("%d/%d passed" % (len(_fns) - _failed, len(_fns)))
    sys.exit(1 if _failed else 0)
