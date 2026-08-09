'use strict';
// #108: with the interpreter in the worker, the REPL cannot ask Python whether a
// statement is finished — jq-console's continuation callback must answer
// synchronously. This is the pure approximation of CPython's rule.
const { isComplete, indentLevel } = require('../../public/js/embed/repl-continuation.js');

describe('isComplete', () => {
  it('treats a simple expression as complete', () => {
    expect(isComplete('6*7')).toBe(true);
    expect(isComplete('x = 5')).toBe(true);
    expect(isComplete('print("hi")')).toBe(true);
  });

  it('treats a blank line as complete', () => {
    expect(isComplete('')).toBe(true);
    expect(isComplete('   ')).toBe(true);
  });

  it('continues after a line opening a suite', () => {
    expect(isComplete('for i in range(3):')).toBe(false);
    expect(isComplete('def f():')).toBe(false);
    expect(isComplete('if x:')).toBe(false);
    expect(isComplete('class Foo:')).toBe(false);
  });

  it('keeps reading an indented suite', () => {
    expect(isComplete('for i in range(3):\n    print(i)')).toBe(false);
  });

  it('ends a suite on a blank line, as CPython does', () => {
    expect(isComplete('for i in range(3):\n    print(i)\n')).toBe(true);
  });

  it('continues inside an unclosed bracket', () => {
    expect(isComplete('xs = [1, 2,')).toBe(false);
    expect(isComplete('f(a,')).toBe(false);
    expect(isComplete('d = {"a": 1,')).toBe(false);
  });

  it('completes once brackets balance', () => {
    expect(isComplete('xs = [1, 2, 3]')).toBe(true);
    expect(isComplete('f(a, b)')).toBe(true);
  });

  it('continues inside a triple-quoted string', () => {
    expect(isComplete('s = """hello')).toBe(false);
    expect(isComplete("s = '''hello")).toBe(false);
  });

  it('completes when the triple quote closes', () => {
    expect(isComplete('s = """hello"""')).toBe(true);
    expect(isComplete('s = """hello\nworld"""')).toBe(true);
  });

  it('does NOT continue on an unterminated single-quoted string', () => {
    // Python rejects this outright; submitting shows a SyntaxError the student
    // can read, whereas continuing would hang the prompt.
    expect(isComplete('print("helo')).toBe(true);
  });

  it('continues on an explicit backslash continuation', () => {
    expect(isComplete('x = 1 + \\')).toBe(false);
  });

  it('ignores brackets and quotes inside comments', () => {
    expect(isComplete('x = 1  # [ unclosed "quote')).toBe(true);
  });

  it('ignores a colon inside a string or comment', () => {
    expect(isComplete('print("for i in range(3):")')).toBe(true);
    expect(isComplete('x = 1  # def f():')).toBe(true);
  });

  it('handles escaped quotes inside a string', () => {
    expect(isComplete('s = "she said \\"hi\\""')).toBe(true);
  });
});

describe('indentLevel', () => {
  it('opens one level after a colon', () => {
    expect(indentLevel('for i in range(3):')).toBe(1);
  });

  it('holds the current indent otherwise', () => {
    expect(indentLevel('    print(i)')).toBe(0);
    expect(indentLevel('xs = [1,')).toBe(0);
  });
});

describe('compound statements need a blank line, as at the CPython prompt', () => {
  it('continues after a one-line compound statement', () => {
    // >>> while True: pass
    // ...
    expect(isComplete('while True: pass')).toBe(false);
    expect(isComplete('if x: print(1)')).toBe(false);
    expect(isComplete('for i in r: print(i)')).toBe(false);
    expect(isComplete('def f(): return 1')).toBe(false);
  });

  it('finishes it on the blank line', () => {
    expect(isComplete('while True: pass\n')).toBe(true);
    expect(isComplete('def f(): return 1\n')).toBe(true);
  });

  it('does not mistake an identifier that merely starts with a keyword', () => {
    expect(isComplete('formatted = 1')).toBe(true);   // starts with "for"
    expect(isComplete('ifx = 2')).toBe(true);         // starts with "if"
    expect(isComplete('classes = []')).toBe(true);    // starts with "class"
  });
});
