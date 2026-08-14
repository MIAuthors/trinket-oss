'use strict';
// #142: `help(numpy)` froze the page. The console received 70,605 separate
// writes (Pyodide's batched stdout flushes per newline), each one forcing a
// layout through jqconsole's _ScrollToEnd. This buffer is the accounting half
// of the fix — queue so the caller can write once per frame, and cap so a big
// enough program cannot build a DOM the browser gives up on.
const { createOutputBuffer } = require('../../public/js/embed/console-buffer.js');

describe('createOutputBuffer — coalescing', () => {
  it('joins many pushes into a single drained string', () => {
    const buf = createOutputBuffer();
    for (let i = 0; i < 100; i++) buf.pushStream('line ' + i + '\n');
    const out = buf.drain();
    expect(out.split('\n')).toHaveLength(101);  // 100 lines + trailing ''
    expect(out.startsWith('line 0\n')).toBe(true);
    expect(out.endsWith('line 99\n')).toBe(true);
  });

  it('drain empties the queue, so a second flush writes nothing', () => {
    const buf = createOutputBuffer();
    buf.pushStream('x\n');
    expect(buf.hasPending()).toBe(true);
    expect(buf.drain()).toBe('x\n');
    expect(buf.hasPending()).toBe(false);
    expect(buf.drain()).toBe('');
  });

  it('preserves order between program output and system messages', () => {
    const buf = createOutputBuffer();
    buf.pushStream('output\n');
    buf.pushSystem('[stopped]\n');
    buf.pushStream('more\n');
    expect(buf.drain()).toBe('output\n[stopped]\nmore\n');
  });
});

describe('createOutputBuffer — the cap', () => {
  it('passes everything through below the limit', () => {
    const buf = createOutputBuffer({ maxLines: 10 });
    buf.pushStream('a\nb\nc\n');
    expect(buf.isCapped()).toBe(false);
    expect(buf.drain()).toBe('a\nb\nc\n');
  });

  it('accepts a chunk that lands exactly on the limit', () => {
    const buf = createOutputBuffer({ maxLines: 3 });
    buf.pushStream('a\nb\nc\n');
    expect(buf.isCapped()).toBe(false);
    expect(buf.drain()).toBe('a\nb\nc\n');
  });

  it('keeps exactly maxLines and cuts on a line boundary, never mid-line', () => {
    const buf = createOutputBuffer({ maxLines: 3 });
    buf.pushStream('a\nb\nc\nd\ne\n');
    const out = buf.drain();
    expect(out.startsWith('a\nb\nc\n')).toBe(true);
    // 'd' would be line 4: it must not appear even partially.
    expect(out).not.toMatch(/^d/m);
    expect(buf.isCapped()).toBe(true);
  });

  it('counts lines across separate pushes, not just within one', () => {
    const buf = createOutputBuffer({ maxLines: 3 });
    buf.pushStream('a\n');
    buf.pushStream('b\n');
    expect(buf.isCapped()).toBe(false);
    buf.pushStream('c\nd\n');
    expect(buf.isCapped()).toBe(true);
    expect(buf.drain()).toMatch(/^a\nb\nc\n/);
  });

  it('explains itself once, and says the program is still running', () => {
    const buf = createOutputBuffer({ maxLines: 2 });
    buf.pushStream('a\nb\nc\n');
    const out = buf.drain();
    expect(out).toMatch(/output stopped after 2 lines/);
    expect(out).toMatch(/still running/);
  });

  it('drops further program output once capped, and reports it', () => {
    const buf = createOutputBuffer({ maxLines: 2 });
    buf.pushStream('a\nb\nc\n');
    buf.drain();
    expect(buf.pushStream('ignored\n')).toBe(false);
    expect(buf.drain()).toBe('');
  });

  it('still delivers system messages after the cap is hit', () => {
    // The whole point of exempting these: a truncated run must still be able
    // to say '[stopped]' or report an error.
    const buf = createOutputBuffer({ maxLines: 1 });
    buf.pushStream('a\nb\n');
    buf.drain();
    buf.pushSystem('\n[stopped]\n');
    expect(buf.drain()).toBe('\n[stopped]\n');
  });

  it('handles the help(numpy) shape: one huge write, capped, page survives', () => {
    const buf = createOutputBuffer({ maxLines: 5000 });
    // pydoc's plain_pager hands the whole thing over in a single write.
    buf.pushStream('doc line\n'.repeat(70605));
    const out = buf.drain();
    expect(buf.isCapped()).toBe(true);
    expect(buf.lineCount()).toBe(5000);
    expect(out.match(/doc line/g)).toHaveLength(5000);
  });
});

describe('createOutputBuffer — resets', () => {
  it('reset() discards queued text and clears the cap', () => {
    const buf = createOutputBuffer({ maxLines: 1 });
    buf.pushStream('a\nb\n');
    buf.reset();
    expect(buf.hasPending()).toBe(false);
    expect(buf.isCapped()).toBe(false);
    expect(buf.drain()).toBe('');
  });

  it('resetCap() clears the cap but keeps queued text', () => {
    // Per REPL statement: a previous help(numpy) must not mute the session,
    // but output already queued still belongs on screen.
    const buf = createOutputBuffer({ maxLines: 1 });
    buf.pushStream('a\nb\n');
    buf.resetCap();
    expect(buf.isCapped()).toBe(false);
    expect(buf.hasPending()).toBe(true);
    buf.pushStream('after\n');
    expect(buf.drain()).toMatch(/after\n$/);
  });
});
