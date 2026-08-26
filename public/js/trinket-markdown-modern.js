/* Modern markdown engine: marked 12 + DOMPurify, GFM, per the
 * markdown-engine-bridge spec. Dependency-injected so ONE file serves the
 * server (require + jsdom DOMPurify) and the browser (script tag).
 * The legacy engine (trinket-markdown.js) is frozen and untouched. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory; }
  else { root.trinketMarkdownModern = factory; }
}(typeof self !== 'undefined' ? self : this, function (markedModern, purifier, hljs, trinketConfig) {

  // Port of legacy's known-hosts computation (lib/shared/trinket-markdown.js
  // ~lines 20-35), rebuilt from trinketConfig.getKnownHosts() instead of a
  // server-only config read, per the Task 5 brief.
  var _knownHosts = (trinketConfig.getKnownHosts && trinketConfig.getKnownHosts()) || [];
  var trinket_hosts = _knownHosts.slice();
  var _port = trinketConfig.getPort && trinketConfig.getPort();
  if (_port && _port !== 80 && _port !== 443) {
    _knownHosts.forEach(function (h) { trinket_hosts.push(h + ':' + _port); });
  }
  var trinket_types = ['python', 'pyodide', 'html', 'music', 'glowscript', 'blocks', 'python3', 'java', 'glowscript-blocks', 'R', 'pygame'];
  // Legacy references python_types (a type-aliasing table) that is empty in
  // the shipped public/js/trinket-markdown.js — lifted as empty here too.
  var python_types = [];

  // Lifted verbatim from legacy EMBED_URLS (lib/shared/trinket-markdown.js
  // ~lines 39-89), except entry 4 (self-hosted trinket URLs): legacy's url()
  // there returns a bare root-relative path, which only worked because
  // legacy's processLink/processImage output bypasses its own HTML sanitizer
  // entirely. In the modern engine ALL renderer output flows through
  // DOMPurify (Task 4's security-driven decision), so this entry is made
  // absolute via trinketConfig.getUrl() — the same canonicalization
  // trinketFence already uses — so it can be matched by an explicit
  // known-hosts src whitelist entry below instead of silently surviving
  // via a bypass that no longer exists.
  var EMBED_URLS = [
    {
      regex: /^(?:https?\:)?\/\/(?:www\.)?youtu\.?be(?:\.com)?\/(?:watch\?v=|embed\/)?(\S+)$/i,
      attrs: 'width="420" height="315" frameborder="0" allowfullscreen',
      url: function (match) {
        return '//www.youtube.com/embed/' + match[1];
      }
    },
    {
      regex: /^(?:https?\:)?\/\/(?:www\.)?vimeo(?:\.com)?\/(?:video\/)?(\S+)$/i,
      attrs: 'width="500" height="281" frameborder="0" webkitallowfullscreen mozallowfullscreen allowfullscreen',
      url: function (match) {
        return '//player.vimeo.com/video/' + match[1];
      }
    },
    {
      regex: /^\/components\/viewerjs\/index\.html#/i,
      attrs: 'width="600" height="400" frameborder="0" scrolling="no" allowfullscreen mozallowfullscreen webkitallowfullscreen',
      url: function (match) {
        return trinketConfig.getUrl(match.input);
      }
    },
    {
      regex: new RegExp(
                '^(?:https?\\:)?\\/\\/(?:www\\.)?'
                + '(' + trinket_hosts.join('|') + ')'
                + '(?:\\/embed)?\\/(' + trinket_types.join('|') + ')(.*)', 'i'
              ),
      attrs: 'class="embedded-trinket" width="100%" height="400" frameborder="0" scrolling="no"',
      url: function (match) {
        var type = python_types.indexOf(match[2]) >= 0 ? 'python' : match[2];
        return trinketConfig.getUrl('/embed/' + type + match[3]);
      }
    },
    {
      regex: /^(?:https?\:)?\/\/www\.slideshare\.net\/slideshow\/embed_code\//i,
      attrs: 'width="427" height="356" frameborder="0" marginwidth="0" marginheight="0" scrolling="no" style="border:1px solid #CCC; border-width:1px 1px 0; margin-bottom:5px; max-width: 100%;" allowfullscreen'
    },
    {
      regex: /^(?:https?\:)?\/\/www\.google\.com\/maps\/embed/i,
      attrs: 'width="600" height="450" frameborder="0" style="border:0"'
    },
    {
      regex: /^(?:https?\:)?\/\/phet\.colorado\.edu\/sims\//i,
      attrs: 'width="800" height="600" scrolling="no"'
    },
    {
      regex: /^(?:https?\:)?\/\/parsons\.herokuapp\.com\/puzzle\//i,
      attrs: 'width="600" height="400" frameborder="0"'
    }
  ];

  var IPYNB_REGEXP = /\.ipynb$/i;

  // Attribute-value escaping. Only the quote character can break out of an
  // attribute value we build, and marked has ALREADY entity-escaped the text
  // it hands renderers — re-escaping `&` here would double-escape it into
  // visible `&amp;lt;` noise. (Everything we emit is re-parsed and
  // re-serialized by DOMPurify anyway, which normalizes the rest.)
  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/"/g, '&quot;');
  }

  // Ported unchanged from legacy checkForEmbedUrl.
  function checkForEmbedUrl(href, title, text) {
    var match;
    for (var i = 0; i < EMBED_URLS.length; i++) {
      match = href.match(EMBED_URLS[i].regex);
      if (match) {
        return '<iframe title="' + (title || text) + '"'
             + ' src="'
             + (EMBED_URLS[i].url ? EMBED_URLS[i].url(match) : match.input)
             + '" ' + EMBED_URLS[i].attrs + '></iframe>';
      }
    }
    return false;
  }

  // Port of legacy processImage (plotly branch, embed-URL branch,
  // root-relative getUrl prefix, =WxH branch). One behavioral change: where
  // legacy falls through to originalImage.call(...), this returns false so
  // marked's own default image renderer applies. One bug fix while porting
  // the =WxH branch: legacy builds `style="style="width: ...px""` (a
  // duplicated, malformed nested style= — the `style` local already carries
  // a literal `style="` prefix from its first assignment, then gets wrapped
  // in `style="..."` again). That is clearly unintentional (nobody meant to
  // double-wrap the attribute) and would produce a garbage attribute value
  // once DOMPurify's DOM parse/reserialize round-trip touches it. Ported as
  // a clean `style="width: Wpx; height: Hpx"` instead.
  function processImage(href, title, text) {
    if (text === 'plotly') {
      var plotly_parts = href.split(':')
        , plotly_user = plotly_parts[0]
        , plotly_id = plotly_parts[1]
        , plotly_width = 640
        , plotly_height = 480
        , plotly_attr, plotly_code;

      if (/\s+=\d+(x\d+)?/.test(plotly_id)) {
        plotly_attr = /\s+=(\d+)(x(\d+))?/.exec(plotly_id);
        if (plotly_attr[1]) {
          plotly_width = plotly_attr[1];
        }
        if (plotly_attr[3]) {
          plotly_height = plotly_attr[3];
        }
        plotly_id = plotly_id.replace(/\s+=.+/, '');
      }

      plotly_code = '<iframe '
        + "width='" + plotly_width + "' "
        + "height='" + plotly_height + "' "
        + "frameborder='0' seamless='seamless' scrolling='no' "
        + "src='https://plot.ly/~" + plotly_user + '/' + plotly_id + '/.embed'
        + '?width=' + plotly_width + '&height=' + plotly_height + "'></iframe>";

      return plotly_code;
    }
    else {
      var embedUrl = checkForEmbedUrl(href, title, text);
      if (embedUrl) { return embedUrl; }

      if (/^\//.test(href)) {
        href = trinketConfig.getUrl(href);
      }

      if (/\s+=\d+x\d*/.test(href)) {
        var attr = href.match(/\s+=(\d+)x(\d*)/);
        var width = attr[1] || '';
        var height = attr[2] || '';
        var style = '';
        var img;

        href = href.replace(attr[0], '');

        img = '<img src="' + escapeAttr(href) + '" alt="' + escapeAttr(text) + '"';

        if (width) {
          img += ' width="' + width + '"';
          style = 'width: ' + width + 'px;';

          if (height) {
            img += ' height="' + height + '"';
            style += ' height: ' + height + 'px';
          }
          else {
            style += ' height: auto';
          }

          img += ' style="' + style + '"';
        }

        if (title) {
          img += ' title="' + escapeAttr(title) + '"';
        }

        img += '>';
        return img;
      }
      else {
        // No `=WxH` suffix. This branch used to `return false` and let marked's
        // own image renderer run — which discarded the getUrl() rewrite made
        // above, emitted the ORIGINAL root-relative href, and then lost the
        // whole src to the img.src whitelist (which requires an absolute or
        // root-relative URL). Every unsized uploaded course image rendered
        // blank. Build the tag here so the rewritten href is the one shipped.
        var plain = '<img src="' + escapeAttr(href) + '" alt="' + escapeAttr(text) + '"';
        if (title) { plain += ' title="' + escapeAttr(title) + '"'; }
        return plain + '>';
      }
    }
  }

  // Port of legacy processImage's image-with-size markdown syntax
  // (`![alt](url =WxH)`). marked 12 is strict CommonMark: the destination
  // parser does not accept trailing unquoted text like ` =300x200` inside
  // the parens, so `![alt](url =300x200)` never reaches the built-in image
  // tokenizer at all (legacy's looser destination parser passed the whole
  // thing through as href, which is what processImage's `=WxH` regex branch
  // above expects). This extension recognizes the syntax explicitly and
  // reconstructs the href-with-suffix form so it can reuse processImage's
  // existing WxH branch unchanged.
  var imageSizeExtension = {
    name: 'imageSize', level: 'inline',
    start: function (src) { var i = src.indexOf('!['); return i < 0 ? undefined : i; },
    tokenizer: function (src) {
      var m = /^!\[([^\]]*)\]\((\S+)\s+=(\d+)x(\d*)\)/.exec(src);
      if (m) {
        return { type: 'imageSize', raw: m[0], href: m[2] + ' =' + m[3] + 'x' + m[4], text: m[1] };
      }
    },
    renderer: function (token) {
      var out = processImage(token.href, null, token.text);
      return out === false ? false : out;
    }
  };

  function highlightCode(code, infostring) {
    var lang = (infostring || '').trim().split(/\s+/)[0];
    if (lang && hljs && hljs.getLanguage && hljs.getLanguage(lang)) {
      return '<pre><code class="hljs">' + hljs.highlight(lang, code).value + '</code></pre>';
    }
    return false; // fall through to marked's default code renderer
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // MathJax typesets the page AFTER markdown renders; our only job is to get
  // TeX through the parser un-chewed. Each extension captures a delimited
  // span and re-emits it verbatim (escaped), delimiters included.
  var mathExtensions = [
    { name: 'mathBlockDollar', level: 'block',
      start: function (src) { var i = src.indexOf('$$'); return i < 0 ? undefined : i; },
      tokenizer: function (src) {
        // Bounded to paragraph boundaries: content cannot contain blank lines.
        // Negative lookahead (?!\n[ \t]*\n) ensures we stop at the first blank line.
        var m = /^\$\$((?:(?!\n[ \t]*\n)[\s\S])+?)\$\$/.exec(src);
        if (m) { return { type: 'mathBlockDollar', raw: m[0], text: m[0] }; }
      },
      renderer: function (token) { return '<p>' + escapeHtml(token.text) + '</p>\n'; } },
    { name: 'mathBlockBracket', level: 'block',
      start: function (src) { var i = src.indexOf('\\['); return i < 0 ? undefined : i; },
      tokenizer: function (src) {
        // Bounded to paragraph boundaries: content cannot contain blank lines.
        // Negative lookahead (?!\n[ \t]*\n) ensures we stop at the first blank line.
        var m = /^\\\[((?:(?!\n[ \t]*\n)[\s\S])+?)\\\]/.exec(src);
        if (m) { return { type: 'mathBlockBracket', raw: m[0], text: m[0] }; }
      },
      renderer: function (token) { return '<p>' + escapeHtml(token.text) + '</p>\n'; } },
    { name: 'mathInlineDollar', level: 'inline',
      start: function (src) { var i = src.indexOf('$'); return i < 0 ? undefined : i; },
      tokenizer: function (src) {
        // single-$ inline math: no space just inside the delimiters, closing $
        // not followed by a digit (so "$5 and $6" is prices, not math).
        //
        // The "no space before the closing $" half was a lookbehind,
        // `(?<!\s)\$`. Regex literals are parsed with the whole script, so on
        // Safari < 16.4 (no lookbehind support) that one character class made
        // THIS ENTIRE FILE fail to parse — trinketMarkdownModern would be
        // undefined and every modern course silently rendered through legacy,
        // on exactly the older iPads students bring to class. Expressed as a
        // check on the captured content instead, which every engine can parse.
        var m = /^\$(?!\s)((?:\\.|[^\\$])+?)\$(?!\d)/.exec(src);
        if (m && !/\s$/.test(m[1])) { return { type: 'mathInlineDollar', raw: m[0], text: m[0] }; }
      },
      renderer: function (token) { return escapeHtml(token.text); } },
    { name: 'mathInlineParen', level: 'inline',
      start: function (src) { var i = src.indexOf('\\('); return i < 0 ? undefined : i; },
      tokenizer: function (src) {
        var m = /^\\\(([\s\S]+?)\\\)/.exec(src);
        if (m) { return { type: 'mathInlineParen', raw: m[0], text: m[0] }; }
      },
      renderer: function (token) { return escapeHtml(token.text); } }
  ];

  var inline_trinkets = ['python', 'pyodide', 'python3', 'html', 'glowscript', 'java', 'R', 'pygame'];

  // Port of legacy processCode's trinket-fence branch. Unlike legacy, this
  // output is NOT trusted-by-construction and exempted from sanitization —
  // the fence's arg string (`:k=v,...`) is author-controlled, and an author
  // can smuggle `key="value" onload="..."` through the attr-parsing loop
  // below. So this markup is returned as ordinary renderer output and flows
  // through purifier.sanitize() like everything else (see SANITIZE_PROFILE
  // below), which strips event-handler attributes DOMPurify doesn't allow.
  function trinketFence(code, infostring) {
    var parts = /^([a-zA-Z0-9]+)\.((?:run|trinket|console))(?:\:(.*))?$/.exec((infostring || '').trim());
    var attrs = { width: '100%', height: '400' };
    var attrStr = '', url, arg;

    if (!parts || inline_trinkets.indexOf(parts[1]) === -1) { return false; }

    if (parts[3]) {
      while ((arg = /(\w+)=([^,]+)/.exec(parts[3]))) {
        attrs[arg[1]] = arg[2].replace(/^("|')|("|')$/g, '');
        parts[3] = parts[3].substr(arg[0].length);
      }
    }

    url = trinketConfig.getUrl('/embed/' + parts[1]);
    if (attrs.autorun !== 'false') { url = url + '?start=result'; }

    if ((parts[1] === 'python' || parts[1] === 'python3') && parts[2] === 'console') {
      url = url + '&runMode=console&outputOnly=true&runOption=console&leftMenu=true';
      code = code + '\n';
      if (parts[1] === 'python') { attrs.height = 300; }
    }

    for (var key in attrs) { attrStr += ' ' + key + '="' + attrs[key] + '"'; }

    url = (url + '#code=' + encodeURIComponent(code)).replace(/'/g, '%27');
    return '<iframe class="embedded-trinket" src="' + url + '"' + attrStr
         + ' frameborder="0" marginwidth="0" marginheight="0" allowfullscreen></iframe>';
  }

  // marked 12 removed headerIds (its heading renderer literally comments
  // "// ignore IDs"). Legacy (the marked 0.3.2 fork) emits them, course
  // material links to `#some-heading` anchors, and the course-page table of
  // contents relies on them — so a course switching engines would break every
  // in-page anchor. Reproduce legacy's algorithm EXACTLY (marked 0.3.2's
  // `raw.toLowerCase().replace(/[^\w]+/g, '-')`, over the unescaped raw text
  // that marked 12 still passes as the third argument), not GitHub's newer
  // slugger — matching legacy is the whole point.
  function headingId(raw) {
    return String(raw || '').toLowerCase().replace(/[^\w]+/g, '-');
  }

  // Port of legacy processLink (lib/shared/trinket-markdown.js ~440-449):
  // embed conversion first, then .ipynb -> nbviewer, then "open in a new
  // window" for everything that isn't an in-page anchor.
  function processLink(href, title, text) {
    var embed = checkForEmbedUrl(href, title, text);
    if (embed) { return embed; }

    if (IPYNB_REGEXP.test(href)) {
      // Legacy only ever reached its nbviewer branch for ROOT-RELATIVE hrefs:
      // `if (ipynb = href.match(RE) && href.charAt(0) == '/')` assigns the
      // whole conjunction, so an external .ipynb link fell through to a plain
      // anchor. Root-relative keeps legacy's exact output (byte-identical in
      // the engine-diff report); absolute http(s) .ipynb links now convert
      // too, using nbviewer's documented /urls/<host><path> form.
      if (href.charAt(0) === '/') {
        return '<a href="http://nbviewer.org/urls/' + escapeAttr(trinketConfig.get('apphostname') + href) + '"'
             + (title ? ' title="' + escapeAttr(title) + '"' : '') + '>' + text + '</a>';
      }
      var absolute = /^(https?:)?\/\//i.exec(href);
      if (absolute) {
        return '<a href="https://nbviewer.org/urls/' + escapeAttr(href.replace(/^(https?:)?\/\//i, '')) + '"'
             + (title ? ' title="' + escapeAttr(title) + '"' : '') + '>' + text + '</a>';
      }
    }

    var link = markedModern.Renderer.prototype.link.call(this, href, title, text);
    if (href.charAt(0) !== '#') {
      link = link.replace(/^<a\s/, '<a target="_blank" ');
    }
    return link;
  }

  var renderer = {
    code: function (code, infostring, escaped) {
      var embed = trinketFence(code, infostring);
      if (embed) { return embed; }
      return highlightCode(code, infostring);
    },
    heading: function (text, level, raw) {
      var id = headingId(raw);
      return '<h' + level + (id ? ' id="' + id + '"' : '') + '>' + text + '</h' + level + '>\n';
    },
    link: processLink,
    image: function (href, title, text) {
      return processImage(href, title, text); // false -> marked's default image renderer
    }
  };

  var engine = new markedModern.Marked({ gfm: true });
  engine.use({ renderer: renderer, extensions: mathExtensions.concat([imageSizeExtension]) });

  // Port of legacy HTML_WHITELIST (lib/shared/trinket-markdown.js ~lines
  // 91-165): same tags, same per-tag attribute regexes, same iframe src
  // whitelist — enforced with DOMPurify hooks instead of legacy's regex
  // scanner (which only ever ran against raw HTML *blocks* in the source
  // markdown; renderer output bypassed it entirely — the modern engine runs
  // every hook against the whole document, renderer output included).
  //
  // Deliberate deviations from legacy's table, each required by a test in
  // markdown-modern-embeds.test.js / markdown-modern-sanitize.test.js:
  //  - img.src: legacy only allowed Google-Drawings URLs (raw-HTML-only
  //    concern, since markdown-generated <img> bypassed the whitelist
  //    entirely in legacy). Now that ALL <img> output — including
  //    processImage's own markdown-generated tags — flows through this same
  //    hook, keeping legacy's strictness would strip every ordinary
  //    markdown image. Loosened to "any http(s) URL", matching the brief's
  //    own suggested rule; there is no way to distinguish "came from raw
  //    HTML" vs "came from markdown image syntax" once both are the same
  //    <img> node in the sanitizer's DOM.
  //  - iframe.class: legacy's table has no `class` key at all (raw <iframe>
  //    HTML was never expected to carry one). trinket-fence iframes and the
  //    self-hosted-trinket embed conversion both emit `class="embedded-trinket"`,
  //    and — per the same "renderer output isn't exempt anymore" reasoning —
  //    that attribute must be explicitly allowed or it gets silently
  //    stripped from markup this module itself generates.
  //  - input: new tag (GFM task-list checkboxes; legacy predates GFM task
  //    lists in this renderer).
  //  - IFRAME_SRC_WHITELIST's known-hosts entry: rebuilt from
  //    trinketConfig.getKnownHosts() per the brief, instead of legacy's
  //    server-only config read.
  var CLASS_RE = /^[a-z\-\s]+$/;
  // Heading ids are generated by headingId() above (legacy's algorithm), so
  // the shape is known: word characters and dashes only.
  var ID_RE = /^[a-z0-9\-_]+$/;
  // href values markdown legitimately produces: absolute/protocol-relative
  // http(s), mailto:, site-relative (/…), in-page anchors (#…) and bare
  // relative paths (02-lesson.md). Everything carrying SOME OTHER scheme —
  // javascript:, data:, vbscript:, file: — is rejected by the negative
  // lookahead in the third alternative. Values containing whitespace never
  // match at all.
  var HREF_RE = /^(?:(?:https?:)?\/\/\S+|mailto:\S+|(?![a-z][a-z0-9+.\-]*:)\S+)$/i;
  var ATTR_RULES = {
    em: { 'class': CLASS_RE },
    br: { 'class': CLASS_RE },
    i: { 'class': CLASS_RE },
    b: { 'class': CLASS_RE },
    u: { 'class': CLASS_RE },
    strong: { 'class': CLASS_RE },
    blockquote: { 'class': CLASS_RE },
    pre: { 'class': CLASS_RE },
    code: { 'class': CLASS_RE },
    h1: { 'class': CLASS_RE, id: ID_RE },
    h2: { 'class': CLASS_RE, id: ID_RE },
    h3: { 'class': CLASS_RE, id: ID_RE },
    h4: { 'class': CLASS_RE, id: ID_RE },
    h5: { 'class': CLASS_RE, id: ID_RE },
    h6: { 'class': CLASS_RE, id: ID_RE },
    sup: { 'class': CLASS_RE },
    sub: { 'class': CLASS_RE },
    dd: { 'class': CLASS_RE },
    dl: { 'class': CLASS_RE },
    dt: { 'class': CLASS_RE },
    ol: { 'class': CLASS_RE, start: /^[0-9]+$/, type: /^[ai]$/i },
    ul: { 'class': CLASS_RE },
    li: { 'class': CLASS_RE },
    strike: { 'class': CLASS_RE },
    del: { 'class': CLASS_RE },
    span: { 'class': CLASS_RE },
    hr: { 'class': CLASS_RE },
    a: { 'class': CLASS_RE, href: HREF_RE, title: /^[^"']+$/, target: /^_blank$/ },
    p: { 'class': CLASS_RE },
    tr: { 'class': CLASS_RE },
    td: { 'class': CLASS_RE },
    th: { 'class': CLASS_RE },
    thead: { 'class': CLASS_RE },
    tbody: { 'class': CLASS_RE },
    tfoot: { 'class': CLASS_RE },
    table: { 'class': CLASS_RE, width: /^\d+(px|%)?$/ },
    // style is intentionally narrow, not a general CSS allowlist: processImage's
    // WxH branch is the only source of a style attribute on modern-generated
    // <img> tags, and it only ever emits "width: Npx; height: (Mpx|auto)".
    // src also accepts root-relative URLs: processImage prefixes those with
    // trinketConfig.getUrl(), but getUrl is host-relative in some browser
    // configurations, so the rewritten value can still start with `/`.
    img: { src: /^((https?\:)?\/\/|\/)[^\s]/i, alt: /.*/, title: /^[^"']+$/, width: /^\d+$/, height: /^\d+$/, style: /^width:\s*\d+px;?(\s*height:\s*(\d+px|auto);?)?$/ },
    input: { type: /^checkbox$/, checked: /^(checked|)$/, disabled: /^(disabled|)$/ },
    iframe: {
      'class': CLASS_RE,
      // checkForEmbedUrl emits title="<link text>" on every converted embed;
      // without a rule for it the attribute was stripped from every iframe
      // this module generates (an accessibility regression vs legacy, whose
      // renderer output never went through a sanitizer).
      title: /^[^"']*$/,
      align: /^(left|right|top|middle|bottom)$/i,
      frameborder: /^(0|1)$/,
      width: /^\d+(%|px)?$/,
      height: /^\d+(%|px)?$/,
      marginwidth: /^\d+$/,
      marginheight: /^\d+$/,
      scrolling: /^(no|yes|auto)$/i,
      seamless: /^seamless$/i,
      allowfullscreen: /^(allowfullscreen|true)$/i,
      webkitallowfullscreen: /^(webkitallowfullscreen|true)$/i,
      mozallowfullscreen: /^(mozallowfullscreen|true)$/i,
      style: /^(.(?!expression|javascript|\-moz\-binding))*$/i,
      src: [
        /^(https?\:)?\/\/(www\.)?youtu(be\.com|\.be)\/embed\//i,
        /^(https?\:)?\/\/(www\.)?player\.vimeo\.com\/video\//i,
        /^(https?\:)?\/\/(www\.)?google\.com\/maps\/embed/i,
        /^(https?\:)?\/\/(www\.)?slideshare\.net\/slideshow\/embed_code\//i,
        /^(https?\:)?\/\/(www\.)?geogebra(tube)?\.org\//i,
        /^(https?\:)?\/\/(www\.)?pythontutor\.com\/iframe-embed\.html/i,
        /^(https?\:)?\/\/(www\.)?screencast\-o\-matic\.com\/embed/i,
        /^(https?\:)?\/\/(www\.)?plot\.ly\/\~[\w-]+\/\d+\/?\.embed/i,
        /^(https?\:)?\/\/docs\.google\.com\/.*(presentation|document|spreadsheets|forms)\//i,
        /^(https?\:)?\/\/linus\.highpoint\.edu/i,
        /^(https?\:)?\/\/physics\.highpoint\.edu/i,
        /^(https?\:)?\/\/phet\.colorado\.edu\/sims\//i,
        /^(https?\:)?\/\/parsons\.herokuapp\.com\/puzzle\//i,
        /^(https?\:)?\/\/(www\.)?loom\.com\/embed\//i,
        /^(https?\:)?\/\/forms\.office\.com\//i,
        /^(https?\:)?\/\/quizizz\.com\//i,
        /^(https?\:)?\/\/embed\.kahoot\.it\//i,
        new RegExp(
          '^(https?\\:)?\\/\\/(www\\.)?'
          + '(' + trinket_hosts.join('|') + ')'
          + '\\/embed\\/', 'i'
        ),
        // Self-hosted ViewerJS embeds (PDF/ODP/ODT/ODS/FODT course material
        // uploads — public/js/courseEditor/controllers/materialControl.js
        // inserts `![name](/components/viewerjs/index.html#... "name")` for
        // these). checkForEmbedUrl's EMBED_URLS[2] already canonicalizes
        // this to an absolute trinketConfig.getUrl() URL (same pattern as
        // the self-hosted-trinket entry below); this whitelist entry is
        // what lets that absolute URL actually survive uponSanitizeElement.
        new RegExp(
          '^(https?\\:)?\\/\\/(www\\.)?'
          + '(' + trinket_hosts.join('|') + ')'
          + '\\/components\\/viewerjs\\/', 'i'
        )
      ]
    }
  };

  var IFRAME_SRC_WHITELIST = ATTR_RULES.iframe.src;

  var SANITIZE_PROFILE = {
    // Every allowed tag MUST have an ATTR_RULES entry: the attribute hook
    // below drops all attributes on a tag it has no rules for, so a tag added
    // here alone would silently lose attributes (and, before that guard was
    // inverted, would instead have accepted ANY name in the union
    // ALLOWED_ATTR set — e.g. `style` on <em>).
    ALLOWED_TAGS: Object.keys(ATTR_RULES),
    ALLOWED_ATTR: (function () {
      var names = {};
      Object.keys(ATTR_RULES).forEach(function (t) {
        Object.keys(ATTR_RULES[t]).forEach(function (a) { names[a] = true; });
      });
      return Object.keys(names);
    })()
  };

  // Legacy's sanitizeTag allowed ANY whitelisted attribute outright when its
  // parsed value was `null` (i.e. no `="..."` at all, as regex-matched from
  // raw markup text). That's broader than intended here: this hook instead
  // sees a DOM already parsed by jsdom, where non-boolean attributes written
  // as `href=""` also normalize to attrValue === '', and legacy's own
  // sanitizeTag would in fact have stripped a genuinely empty `href=""`
  // (value present but failing the href regex) — the `null`-value carve-out
  // only ever fired for true boolean attributes in practice. So the carve-out
  // here is restricted to the actual boolean-shaped attributes this module's
  // own renderer output ever emits bare (fence/embed iframes' allowfullscreen
  // family, task-list checkboxes' checked/disabled), rather than reopened for
  // every attribute name in a tag's rule set.
  var BOOLEAN_ATTRS = { allowfullscreen: true, webkitallowfullscreen: true, mozallowfullscreen: true, seamless: true, checked: true, disabled: true };

  purifier.addHook('uponSanitizeAttribute', function (node, data) {
    var tag = node.nodeName.toLowerCase();
    var rules = ATTR_RULES[tag];
    // Default-deny: a tag with no rule table keeps no attributes at all.
    // (Returning early here instead would hand any rule-less tag the whole
    // union of attribute names collected into ALLOWED_ATTR below.)
    if (!rules) { data.keepAttr = false; return; }
    var rule = rules[data.attrName];
    if (!rule) { data.keepAttr = false; return; }
    // A bare boolean attribute (`allowfullscreen`, no `="..."`) serializes
    // with attrValue === '' once parsed into a DOM; testing that against a
    // value-shaped regex like /^(allowfullscreen|true)$/i would fail it, so
    // presence alone is accepted for the specific attributes that are
    // legitimately boolean.
    if (data.attrValue === '' && BOOLEAN_ATTRS[data.attrName]) { return; }
    if (rule instanceof RegExp) {
      if (!rule.test(data.attrValue)) { data.keepAttr = false; }
    }
    else if (rule instanceof Array) {
      var matched = false;
      for (var i = 0; i < rule.length; i++) {
        if (rule[i] instanceof RegExp && rule[i].test(data.attrValue)) { matched = true; break; }
      }
      if (!matched) { data.keepAttr = false; }
    }
  });

  purifier.addHook('uponSanitizeElement', function (node, data) {
    if (data.tagName === 'iframe') {
      var src = node.getAttribute && node.getAttribute('src');
      var ok = false;
      for (var i = 0; src && i < IFRAME_SRC_WHITELIST.length; i++) {
        if (IFRAME_SRC_WHITELIST[i].test(src)) { ok = true; break; }
      }
      if (!ok && node.parentNode) { node.parentNode.removeChild(node); }
    }
  });

  return function parse(src) {
    var html = engine.parse(src || '');
    return purifier.sanitize(html, SANITIZE_PROFILE);
  };
}));
