// "Connect your LMS" — an approved instructor mints either a Dynamic Registration link (LTI 1.3,
// modern LMSes) or a key/secret pair (LTI 1.1 — legacy platforms and WileyPLUS-hosted Canvas,
// where course admins may only self-install key/secret tools). Thin wrappers over
// ltiRegistration.mintRegistrationToken and the LtiConsumer model.
'use strict';
var crypto = require('crypto');
var Boom = require('@hapi/boom');
var ltiRegistration = require('../util/ltiRegistration');
var LtiConsumer = require('../models/ltiConsumer');
var Course = require('../models/course');

module.exports = {
  page: function(request, reply) {
    // The instructor's own courses, so the page can offer ready-made
    // config-XML URLs (custom trinket_course baked in) per course.
    return Promise.resolve(Course.find({ _owner: request.user.id }))
      .catch(function() { return []; })
      .then(function(courses) {
        return request.success({
          myCourses: (courses || []).map(function(c) { return { id: c.id, name: c.name }; })
        });
      });
  },
  createToken: function(request, reply) {
    var label = (request.payload && request.payload.label) || '';
    return ltiRegistration.mintRegistrationToken({ label: label, initiatedByEmail: request.user.email })
      .then(function(out) { return request.success({ url: out.url }); })
      .catch(function(e) { return reply(Boom.badImplementation('Could not create a registration link: ' + e.message)); });
  },
  // POST /lti/connect/lti11-key — mint an LTI 1.1 consumer key/secret owned by
  // this instructor. The secret is stored server-side and shown to the
  // instructor here; rotating = mint a new pair (old one can be disabled by an
  // operator until a management UI exists).
  createLti11Key: function(request, reply) {
    var label = ((request.payload && request.payload.label) || '').slice(0, 80);
    var consumer = new LtiConsumer({
      key: 'trinket-' + crypto.randomBytes(6).toString('hex'),
      secret: crypto.randomBytes(24).toString('hex'),
      name: label || (request.user.email + ' (LTI 1.1)'),
      ownerUserId: request.user.id
    });
    return Promise.resolve(consumer.save())
      .then(function() {
        return request.success({ key: consumer.key, secret: consumer.secret });
      })
      .catch(function(e) { return reply(Boom.badImplementation('Could not create the key: ' + e.message)); });
  }
};
