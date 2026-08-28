// LTI 1.1 Basic Outcomes — tell a 1.1 platform that a submission exists and where to
// view it. The 1.1 counterpart of ltiAgs, and the only channel available: 1.1 has no
// AGS, so replaceResult IS the reporting mechanism.
//
// The payload that matters is resultData/ltiLaunchUrl. A platform that supports it
// stores the URL as the student's submission and relaunches the tool there when an
// instructor opens the grader — the same end state Canvas's submission extension
// gives us over AGS in 1.3 (verified against a live Canvas: submission_type
// "basic_lti_launch", one distinct tool URL per student).
//
// NO SCORE by default. Trinket has no concept of a grade; the human grades in the
// LMS. `score` is opt-in precisely so that stays a deliberate decision.
//
// Signing differs from a launch: the body is XML, not form-encoded, so its
// parameters cannot go into the signature base. OAuth 1.0a covers it with
// oauth_body_hash = base64(sha1(body)) carried as an oauth parameter instead.
'use strict';
var crypto = require('crypto');
var lti11Verify = require('./lti11Verify');

var NS = 'http://www.imsglobal.org/services/ltiv1p1/xsd/imsoms_v1p0';

// Outcomes calls are made while a user waits, so they get a deadline.
var REQUEST_TIMEOUT_MS = 10000;

function xmlEscape(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function bodyHash(body) {
  return crypto.createHash('sha1').update(body, 'utf8').digest('base64');
}

// score: omit entirely for "there is a submission, no grade". Some platforms may
// reject that — the caller sees the platform's own imsx_description if so.
function buildReplaceResult(args) {
  var score = (args.score === undefined || args.score === null) ? null : String(args.score);
  var scoreXml = score === null ? ''
    : '\n          <resultScore><language>en</language><textString>' + xmlEscape(score) + '</textString></resultScore>';
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<imsx_POXEnvelopeRequest xmlns="' + NS + '">\n' +
    '  <imsx_POXHeader>\n' +
    '    <imsx_POXRequestHeaderInfo>\n' +
    '      <imsx_version>V1.0</imsx_version>\n' +
    '      <imsx_messageIdentifier>' + xmlEscape(args.messageId) + '</imsx_messageIdentifier>\n' +
    '    </imsx_POXRequestHeaderInfo>\n' +
    '  </imsx_POXHeader>\n' +
    '  <imsx_POXBody>\n' +
    '    <replaceResultRequest>\n' +
    '      <resultRecord>\n' +
    '        <sourcedGUID><sourcedId>' + xmlEscape(args.sourcedId) + '</sourcedId></sourcedGUID>\n' +
    '        <result>' + scoreXml + '\n' +
    '          <resultData><ltiLaunchUrl>' + xmlEscape(args.launchUrl) + '</ltiLaunchUrl></resultData>\n' +
    '        </result>\n' +
    '      </resultRecord>\n' +
    '    </replaceResultRequest>\n' +
    '  </imsx_POXBody>\n' +
    '</imsx_POXEnvelopeRequest>';
}

// Ask the platform what score it holds for this student, so trinket can tell that a
// human graded the work in the LMS. 1.1's counterpart of the AGS Result service —
// and unlike AGS it needs NO extra scope, because it is the same signed POST to the
// same outcomes URL as replaceResult.
function buildReadResult(args) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<imsx_POXEnvelopeRequest xmlns="' + NS + '">\n' +
    '  <imsx_POXHeader>\n' +
    '    <imsx_POXRequestHeaderInfo>\n' +
    '      <imsx_version>V1.0</imsx_version>\n' +
    '      <imsx_messageIdentifier>' + xmlEscape(args.messageId) + '</imsx_messageIdentifier>\n' +
    '    </imsx_POXRequestHeaderInfo>\n' +
    '  </imsx_POXHeader>\n' +
    '  <imsx_POXBody>\n' +
    '    <readResultRequest>\n' +
    '      <resultRecord>\n' +
    '        <sourcedGUID><sourcedId>' + xmlEscape(args.sourcedId) + '</sourcedId></sourcedGUID>\n' +
    '      </resultRecord>\n' +
    '    </readResultRequest>\n' +
    '  </imsx_POXBody>\n' +
    '</imsx_POXEnvelopeRequest>';
}

// A platform answers "not graded yet" as SUCCESS with an absent or empty
// textString — not as an error. Treating that as a score would mark every
// unmarked submission graded the moment a line item exists.
function readScore(xml) {
  var verdict = readVerdict(xml);
  var m = /<resultScore>[\s\S]*?<textString>([\s\S]*?)<\/textString>[\s\S]*?<\/resultScore>/.exec(String(xml || ''));
  var raw = m ? m[1].trim() : '';
  var score = (raw === '') ? null : Number(raw);
  if (score !== null && !isFinite(score)) score = null;
  return { ok: verdict.ok, codeMajor: verdict.codeMajor, description: verdict.description,
           graded: verdict.ok && score !== null, score: score };
}

function authHeader(method, url, key, secret, hash, opts) {
  var params = {
    oauth_body_hash        : hash,
    oauth_consumer_key     : key,
    oauth_nonce            : opts.nonce,
    oauth_signature_method : 'HMAC-SHA1',
    oauth_timestamp        : String(opts.timestamp),
    oauth_version          : '1.0'
  };
  params.oauth_signature = lti11Verify.sign(method, url, params, secret);
  var r = lti11Verify.rfc3986;
  return 'OAuth ' + Object.keys(params).sort().map(function (k) {
    return r(k) + '="' + r(params[k]) + '"';
  }).join(',');
}

// A POX response is 200 even when the operation failed; the verdict is in
// imsx_codeMajor. Surface imsx_description verbatim — when a platform refuses a
// resultData-only post, its own words are the most useful thing we can report.
function readVerdict(xml) {
  var text = String(xml || '');
  var major = /<imsx_codeMajor>\s*([^<\s]+)\s*<\/imsx_codeMajor>/.exec(text);
  var desc  = /<imsx_description>([\s\S]*?)<\/imsx_description>/.exec(text);
  return {
    ok: !!major && major[1].toLowerCase() === 'success',
    codeMajor: major ? major[1] : null,
    description: desc ? desc[1].trim() : null
  };
}

// Shared transport for both POX operations: sign the body with oauth_body_hash and
// POST it. Kept in one place so replaceResult and readResult cannot drift apart.
function postPox(args, body) {
  var opts = args.opts || {};
  var hash = bodyHash(body);
  var header = authHeader('POST', args.serviceUrl, args.consumerKey, args.secret, hash, {
    nonce    : opts.nonce || crypto.randomBytes(12).toString('hex'),
    timestamp: opts.timestamp || Math.floor(Date.now() / 1000)
  });
  // A platform that accepts the connection and then stalls would otherwise hold the
  // request open indefinitely. Harmless for a background submit; a page hang once
  // this is called during an instructor page load.
  return fetch(args.serviceUrl, {
    method : 'POST',
    headers: { 'content-type': 'application/xml', authorization: header },
    body   : body,
    signal : (opts.signal !== undefined) ? opts.signal
           : (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
              ? AbortSignal.timeout(opts.timeoutMs || REQUEST_TIMEOUT_MS)
              : undefined)
  }).then(function (res) {
    return Promise.resolve(res.text()).then(function (text) {
      if (!res.ok) throw new Error('Basic Outcomes POST returned HTTP ' + res.status);
      return text;
    });
  });
}

// Returns { graded, score } — graded:false means "the platform answered, nobody has
// marked it yet", which is NOT an error and must not be logged as one.
function readResult(args) {
  var opts = args.opts || {};
  var body = buildReadResult({
    sourcedId: args.sourcedId,
    messageId: opts.messageId || crypto.randomBytes(8).toString('hex')
  });
  return postPox(args, body).then(function (text) {
    var out = readScore(text);
    if (!out.ok) {
      throw new Error('Basic Outcomes readResult failed (' + out.codeMajor + ')' +
                      (out.description ? ': ' + out.description : ''));
    }
    return out;
  });
}

function postSubmission(args) {
  var opts = args.opts || {};
  var body = buildReplaceResult({
    sourcedId: args.sourcedId,
    launchUrl: args.launchUrl,
    score    : args.score,
    messageId: opts.messageId || crypto.randomBytes(8).toString('hex')
  });
  return postPox(args, body).then(function (text) {
    var verdict = readVerdict(text);
    if (!verdict.ok) {
      throw new Error('Basic Outcomes replaceResult failed (' + verdict.codeMajor + ')' +
                      (verdict.description ? ': ' + verdict.description : ''));
    }
    return verdict;
  });
}

module.exports = {
  REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS,
  buildReplaceResult: buildReplaceResult,
  buildReadResult: buildReadResult,
  readScore: readScore,
  readResult: readResult,
  bodyHash: bodyHash,
  authHeader: authHeader,
  readVerdict: readVerdict,
  postSubmission: postSubmission
};
