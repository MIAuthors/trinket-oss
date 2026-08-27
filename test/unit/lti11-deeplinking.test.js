'use strict';

// The 1.1 deep-linking return is an OAuth-signed FORM post, so unlike the outcomes
// XML its parameters DO belong in the signature base and no body hash is involved.
// If content_items were left out of the signature, a platform could not detect
// tampering with the very payload the whole message exists to deliver.
const d = require('../../lib/util/lti11DeepLinking');
const v = require('../../lib/util/lti11Verify');

const RETURN = 'https://canvas.example/courses/1/external_content/success/external_tool_dialog';
const KEY = 'ck', SECRET = 'cs';
const fixed = { nonce: 'n1', timestamp: 1700000000 };

describe('content items', () => {
  it('carries per-placement targeting as custom params', () => {
    const item = d.assignmentContentItem({ courseId: 'c1', materialId: 'm1', title: 'HW 1' });
    expect(item.custom.trinket_course).toBe('c1');
    expect(item.custom.trinket_assignment).toBe('m1');
  });

  it('gives an assignment a lineItem — without it the LMS makes no gradebook column', () => {
    // No column means no lis_outcome_service_url on later launches, which means
    // nothing can ever be reported back. This is the load-bearing bit.
    const item = d.assignmentContentItem({ courseId: 'c1', materialId: 'm1', title: 'HW 1' });
    expect(item.lineItem).toBeTruthy();
    expect(item.lineItem.scoreConstraints.totalMaximum).toBe(100);
  });

  it('gives a course/topic link NO lineItem', () => {
    expect(d.linkContentItem({ courseId: 'c1', title: 'Course' }).lineItem).toBeUndefined();
  });

  it('carries the topic id only for a topic link', () => {
    expect(d.linkContentItem({ courseId: 'c1', lessonId: 'l1', title: 'T' }).custom.trinket_topic).toBe('l1');
    expect(d.linkContentItem({ courseId: 'c1', title: 'C' }).custom.trinket_topic).toBeUndefined();
  });

  it('wraps items in the IMS ContentItem graph', () => {
    const parsed = JSON.parse(d.contentItemsJson([d.linkContentItem({ courseId: 'c1', title: 'C' })]));
    expect(parsed['@context']).toContain('ContentItem');
    expect(parsed['@graph'][0]['@type']).toBe('LtiLinkItem');
  });
});

describe('buildReturnForm', () => {
  const form = () => d.buildReturnForm({
    returnUrl: RETURN, consumerKey: KEY, secret: SECRET,
    contentItems: [d.assignmentContentItem({ courseId: 'c1', materialId: 'm1', title: 'HW 1' })],
    opts: fixed
  });

  it('declares itself a ContentItemSelection', () => {
    expect(form().lti_message_type).toBe('ContentItemSelection');
    expect(form().lti_version).toBe('LTI-1p0');
  });

  it('signs content_items — the payload must not be tamperable', () => {
    const f = form();
    const check = Object.assign({}, f);
    delete check.oauth_signature;
    expect(v.sign('POST', RETURN, check, SECRET)).toBe(f.oauth_signature);

    // Alter the items and the signature must no longer match.
    check.content_items = check.content_items.replace('HW 1', 'HW 2');
    expect(v.sign('POST', RETURN, check, SECRET)).not.toBe(f.oauth_signature);
  });

  it('echoes opaque platform data when present, and omits it when not', () => {
    const withData = d.buildReturnForm({ returnUrl: RETURN, consumerKey: KEY, secret: SECRET,
                                         contentItems: [], data: 'opaque-1', opts: fixed });
    expect(withData.data).toBe('opaque-1');
    expect(form().data).toBeUndefined();
  });

  it('signs against the platform return URL, not our own', () => {
    const f = form();
    const check = Object.assign({}, f); delete check.oauth_signature;
    expect(v.sign('POST', 'https://elsewhere.example/return', check, SECRET)).not.toBe(f.oauth_signature);
  });
});
