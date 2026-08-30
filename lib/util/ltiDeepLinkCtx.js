// Deep-linking context, carried in the URL instead of a cookie.
//
// WHY THIS EXISTS: a deep-linking launch arrives in an LMS iframe — a third-party
// context. Current browsers refuse third-party cookies outright, so the session the
// launch establishes cannot be stored, and the very next request (the picker) is
// anonymous. The instructor lands on a login page inside the frame even though they
// are already signed in to this deploy in the same browser. See issue #217.
//
// The fix is to stop depending on the cookie surviving: the launch signs the
// deep-linking context into a short-lived token and puts it in the picker URL. The
// picker then runs in a TOP-LEVEL tab, where the instructor's own first-party cookie
// works normally.
//
// ⚠️ THIS TOKEN DELIBERATELY CARRIES NO IDENTITY. It would have been simpler to put a
// user id in it and mint a session from it, but that turns any leaked URL — a
// referrer header, a screenshot in a support ticket, a proxy log — into a live
// session for that instructor. Authentication stays with the user's own cookie in a
// first-party context; this token only says WHICH deep-link request is being answered.
//
// Stateless by necessity as well as design: Cloud Run runs several instances with no
// shared cache, so a server-side token table would work only by luck. Same reasoning
// as ltiState.js, and the same signing key.
var ltiKeys = require('./ltiKeys');

// Long enough for a human to click through a picker, short enough to be uninteresting
// if it leaks. The instructor can always relaunch from the LMS.
var CTX_TTL = '15m';
var TYP     = 'lti-dl-ctx';

module.exports = {
  TYP: TYP,

  // dl is the same shape stashed in the session by the launch. Only the fields the
  // picker and the select step actually need are carried; nothing about the user.
  //
  // Returns null rather than throwing when no signing key is configured. The token is
  // an ENHANCEMENT — it rescues the flow in browsers that drop the launch cookie — so
  // it must never be able to break a launch that would otherwise have worked. LTI 1.1
  // deep linking needs no 1.3 keypair, and a 1.1-only deploy has no LTI_PRIVATE_KEY;
  // signing unconditionally made every such launch fail (caught by
  // test/lib/api/lti11-deeplink.test.js).
  sign: function (dl) {
    try {
      return ltiKeys.signJwt({
        typ  : TYP,
        v    : dl.version,
        ru   : dl.deep_link_return_url,
        data : dl.data,
        mode : dl.mode,
        am   : !!dl.acceptMultiple,
        aa   : dl.assignmentAllowed !== false,
        ck   : dl.consumerKey || null,     // 1.1: which consumer to re-read the secret from
        pi   : dl.platformIss || null,     // 1.3: platform issuer
        pc   : dl.platformCid || null,     // 1.3: client id
        di   : dl.deploymentId || null
      }, { expiresIn: CTX_TTL });
    } catch (e) {
      return null;   // no key configured: fall back to session-only behaviour
    }
  },

  // Returns the dl-shaped object, or null when the token is absent, malformed,
  // expired, or of the wrong type. Callers treat null as "no context".
  verify: function (token) {
    if (!token) return null;
    var p;
    try { p = ltiKeys.verifyJwt(token); } catch (e) { return null; }
    if (!p || p.typ !== TYP || !p.ru) return null;
    return {
      version              : p.v,
      deep_link_return_url : p.ru,
        data                 : p.data,
        mode                 : p.mode,
      acceptMultiple       : !!p.am,
      assignmentAllowed    : p.aa !== false,
      consumerKey          : p.ck || undefined,
      platformIss          : p.pi || undefined,
      platformCid          : p.pc || undefined,
      deploymentId         : p.di || undefined
    };
  }
};
