(function(angular) {
  angular.module('trinket.markdown', ['trinket.config'])
    .factory('markdownParser', ['trinketConfig', function(trinketConfig) {
      return function(options) {
        options = angular.extend({}, options);

        var legacyParse = trinketMarkdown(options);
        // Modern engine (markdown-engine-bridge). `engine` may be a string or
        // a function evaluated per call — the course document arrives async,
        // after controllers build their parsers.
        var modernParse;
        function modern() {
          if (!modernParse) {
            if (typeof trinketMarkdownModern === 'undefined' || typeof markedModern === 'undefined'
                || typeof DOMPurify === 'undefined') {
              return legacyParse; // scripts absent on this page: safe fallback
            }
            var cfg = angular.extend({
              getKnownHosts: function() { return [trinketConfig.get('apphostname')]; }
            }, trinketConfig);
            // window.DOMPurify is a SINGLETON, and trinketMarkdownModern
            // addHook()s on whatever purifier it is given. Handing it the
            // global means every markdownParser built on a page (the course
            // editor builds several) stacks another copy of the same two hooks
            // onto the shared object — and they all run, cumulatively, on
            // every sanitize() call, for the life of the page. DOMPurify is
            // also a factory: calling it with a window mints a private
            // instance, so each parser owns its own hook list.
            var purifier = typeof DOMPurify === 'function' ? DOMPurify(window) : DOMPurify;
            modernParse = trinketMarkdownModern(markedModern, purifier, window.hljs, cfg);
          }
          return modernParse;
        }

        return function(md) {
          var engine = typeof options.engine === 'function' ? options.engine() : options.engine;
          return (engine === 'modern' ? modern() : legacyParse)(md);
        };
      }
    }]);
})(window.angular);
