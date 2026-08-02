var _        = require('underscore'),
    config   = require('config'),
    defaults = {};

defaults.extend = function(custom, defaults) {
  if (typeof defaults === 'string') {
    defaults = this[defaults];
  }
  
  return _.extend({}, defaults, custom);
}

defaults.user = {
  fullname: 'test user',
  // name:     'test',
  username: 'testing',
  email:    'test@dummy.com',
  password: 'bacon'
};

defaults.user2 = {
  fullname: 'test user 2',
  username: 'testing2',
  email:    'test2@dummy.com',
  password: 'bacon2'
};

defaults.admin = {
  fullname: 'admin user',
  // name:     'admin',
  username: 'administrator',
  email:    'admin@example.com',
  password: 'fakin',
  roles: [{
    context : "site", roles : [ "admin" ]
  }]
};

defaults.login = {
  email:    defaults.user.email,
  password: defaults.user.password
};

defaults.course = {
  name:        'test course',
  description: 'test course description'
};

defaults.lesson = {
  name: 'test lesson'
};

defaults.material = {
  name: 'test material',
  type: 'page'
};

defaults.section = {
  name: 'test section'
};

defaults.content = {
  content: 'test content'
};

defaults.patch = {
  patch: '@@ -1 +1,2 @@\n test content\n+No newline at end of file\n'
}

defaults.file = {
  upload: 'test/data/transparent.gif',
  name: 'transparent.gif',
  type: 'embed'
};

defaults.ipynb = {
  upload: 'test/data/test.ipynb',
  name: 'test.ipynb',
  type: 'download'
};

defaults.trinket = {
  code: 'import turtle'
};

defaults.snapshot = {
  code: defaults.trinket.code,
  assets: [],
  lang: 'python',
  shortCode: 'abcd1234'
};

defaults.trinketRunError = {
  state: 'encountered',
  error: 'ParseError: bad token on line 1',
  session: 'abc-123',
  group: 1,
  type: 'ParseError',
  message: 'bad token',
  line: 1,
  code: 'print "missing quote',
  attempt: 0,
  lang: 'python'
};

defaults.recaptcha = {
  'g-recaptcha-response': 'testing'
};

module.exports = defaults;
