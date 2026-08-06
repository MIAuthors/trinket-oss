const config   = require('config');
const features = require('../../../lib/util/features');

describe('features.isAccessCodeEnrollmentEnabled', () => {
  let prev;
  beforeEach(() => { prev = config.features.accessCodeEnrollment; });
  afterEach(()  => { config.features.accessCodeEnrollment = prev; });

  it('is true only when the flag is exactly true', () => {
    config.features.accessCodeEnrollment = true;
    expect(features.isAccessCodeEnrollmentEnabled()).toBe(true);
  });
  it('is false when the flag is false', () => {
    config.features.accessCodeEnrollment = false;
    expect(features.isAccessCodeEnrollmentEnabled()).toBe(false);
  });
  it('is false when the flag is undefined', () => {
    delete config.features.accessCodeEnrollment;
    expect(features.isAccessCodeEnrollmentEnabled()).toBe(false);
  });
});
