'use strict';
const mailer = require('../../lib/util/mailer');

describe('mailer.logFailure', () => {
  let errSpy;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const lines = () => errSpy.mock.calls.map((c) => c.join(' '));

  it('writes one MAIL_SEND_FAILED line with type, recipient, codes and message', () => {
    const err = Object.assign(new Error('Message failed: 421 not allowed'), {
      code: 'EENVELOPE',
      responseCode: 421,
    });
    mailer.logFailure(err, { type: 'password-reset', to: 'a@b.edu' });
    expect(lines()).toEqual([
      'MAIL_SEND_FAILED type=password-reset to=a@b.edu code=EENVELOPE responseCode=421 message="Message failed: 421 not allowed"',
    ]);
  });

  it('collapses newlines, neutralises quotes and caps the message length', () => {
    const err = new Error('line one\r\nline "two"\n' + 'x'.repeat(1000));
    mailer.logFailure(err, { type: 't', to: 'a@b.edu' });
    const out = lines();
    expect(out).toHaveLength(1);
    expect(out[0]).not.toMatch(/[\r\n]/);
    expect(out[0]).toContain("message=\"line one line 'two' xxx");
    expect(out[0].length).toBeLessThan(600);
  });

  it('does not throw on non-Error rejections or a missing context', () => {
    expect(() => mailer.logFailure('plain string')).not.toThrow();
    expect(() => mailer.logFailure(undefined, undefined)).not.toThrow();
    expect(() => mailer.logFailure(null, { to: undefined, type: undefined })).not.toThrow();
    const out = lines();
    expect(out[0]).toBe('MAIL_SEND_FAILED type=unknown to= code= responseCode= message="plain string"');
    expect(out[1]).toBe('MAIL_SEND_FAILED type=unknown to= code= responseCode= message=""');
    expect(out).toHaveLength(3);
  });
});

describe('mailer.sendSafe', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns what send() returns on success and logs nothing', async () => {
    const errSpy  = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sendSpy = vi.spyOn(mailer, 'send').mockResolvedValue({ messageId: 'm1' });
    const result  = await mailer.sendSafe('a@b.edu', 'Hi', { html: '<p>x</p>', type: 'verify-email' });
    expect(result).toEqual({ messageId: 'm1' });
    expect(sendSpy).toHaveBeenCalledWith('a@b.edu', 'Hi', { html: '<p>x</p>', type: 'verify-email' });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('never rejects: resolves { failed, error } and logs one MAIL_SEND_FAILED line', async () => {
    const boom   = new Error('Message failed: 421 sandbox');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(mailer, 'send').mockRejectedValue(boom);
    const result = await mailer.sendSafe('a@b.edu', 'Hi', { type: 'password-reset' });
    expect(result).toEqual({ failed: true, error: boom });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toContain('MAIL_SEND_FAILED type=password-reset to=a@b.edu');
  });

  it('copes with a missing options object', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(mailer, 'send').mockRejectedValue(new Error('x'));
    await expect(mailer.sendSafe('a@b.edu', 'Hi')).resolves.toMatchObject({ failed: true });
  });
});
