(function(angular) {
  'use strict';

  angular.module('trinket.feedback', [
    'ngAria',
    'trinket.submissions',
    'ui.ace'
  ]).directive('trinketFeedback', ['$compile', '$templateRequest', '$timeout', '$filter', '$sce', 'trinketSubmissions', 'trinketConfig', 'markdownParser', function($compile, $templateRequest, $timeout, $filter, $sce, trinketSubmissions, trinketConfig, markdownParser) {
    function link(scope, element, attrs) {
      scope.canSubmit  = false;
      scope.canUpdate  = false;
      scope.canAccept  = false;
      scope.api        = null;
      scope.state      = null;

      scope.sendingFeedback = false;
      scope.revisionMade    = false;
      scope.acceptingSubmission = false;

      scope.feedbackForm = {
          includeRevision : false
        , allowResubmit   : false
        , comments        : ""
      };

      scope.previousSubmissions = [];
      scope.showSubmission      = {};
      scope.submissionSrc       = {};

      var url, iframe, win, feedbackComments;
      var parser = markdownParser({
          $scope  : scope
        , preview : true
      });

      $templateRequest('/partials/directives/trinket-feedback.html').then(function(html) {
        element.html(html);
        $compile(element.contents())(scope);

        iframe = element.find('iframe');
        iframe.on('load', function() {
          win = this.contentWindow || this.contentDocument;
          scope.api = win.TrinketApp;

          win.TrinketApp.on('trinket.code.change',   scope.setRevisionMade.bind(null, true));
          win.TrinketApp.on('trinket.draft.discard', scope.setRevisionMade.bind(null, false));

          if (win.TrinketApp.viewingDraft()) {
            scope.revisionMade = true;
          }

          scope.canSubmit = scope.canAccept = true;
          scope.$apply();
        });
      });

      scope.$watch("submission", function(newValue, oldValue) {
        scope.canSubmit      = false;
        scope.canUpdate      = false;
        scope.canAccept      = false;
        scope.revisionIframe = null;

        if (scope.submission && scope.submission.lang && scope.submission.shortCode) {
          url         = scope.submission.lang + "/" + scope.submission.shortCode;
          scope.state = scope.submission.state;

          if (scope.state === "submitted") {
            scope.submissionIframe = $sce.trustAsResourceUrl(trinketConfig.getUrl("/assignment-embed-feedback/" + url));

            angular.forEach(scope.submission.submissionOpts, function(val, key) {
              scope.feedbackForm[key] = val;
            });

            if (scope.submission.comments.length) {
              angular.forEach(scope.submission.comments, function(comment) {
                if (comment.commentType === 'feedback-draft') {
                  scope.feedbackForm.comments = comment.commentText;
                }
              });
            }
          }
          else if (scope.state === "submittedLate") {
            scope.submissionIframe = $sce.trustAsResourceUrl(trinketConfig.getUrl("/assignment-embed-viewonly/" + url));
          }
          else if (scope.state === "completed") {
            feedbackComments = $filter('filter')(scope.submission.comments, { commentType : 'feedback' }, true);
            scope.submissionIframe = $sce.trustAsResourceUrl(trinketConfig.getUrl("/assignment-embed-viewonly/" + url));

            if (feedbackComments.length) {
              scope.revisionIframe = $sce.trustAsResourceUrl(
                trinketConfig.getUrl("/assignment-embed-viewonly/" + feedbackComments[0].trinketLang + "/" + feedbackComments[0].trinketShortCode)
              );
            }
          }

          // check for previous submissions / feedback
          trinketSubmissions.getUserSubmissionsForMaterial(scope.submission, scope.material)
            .then(function(submissions) {
              submissions.reverse();
              angular.forEach(submissions, function(submission) {
                if (submission.shortCode !== scope.submission.shortCode && submission.submissionState === "completed") {
                  // find teacher feedback
                  angular.forEach(submission.comments, function(comment) {
                    if (comment.commentType === "feedback") {
                      submission.feedback = comment;
                    }
                  });

                  if (submission.includeRevision) {
                    submission.revisionIframe = $sce.trustAsResourceUrl(
                      trinketConfig.getUrl("/assignment-embed-viewonly/" + submission.feedback.trinketLang + "/" + submission.feedback.trinketShortCode)
                    );
                  }

                  scope.previousSubmissions.push(submission);
                }
              });
            });
        }
      });

      scope.sendFeedback = function() {
        // ng-class="{disabled:!canSubmit}" is cosmetic — ng-click still fires on the
        // greyed-out control. Both canSubmit and api are set by the embedded trinket's
        // iframe load handler, so an early (or double) click reached scope.api.serialize()
        // with api still null: it threw, the promise never settled, and the button spun
        // forever. Refuse the click while the editor is not ready.
        if (!scope.canSubmit || !scope.api) { return; }

        scope.canSubmit       = false;
        scope.canUpdate       = false;
        scope.canAccept       = false;
        scope.sendingFeedback = true;

        trinketSubmissions.sendFeedback(scope.material, scope.submission.id, scope.api.serialize(), scope.feedbackForm)
          .then(function(result) {
            $timeout(function() {
              scope.submission.state       = scope.state = result.submissionState;
              scope.submission.lastUpdated = result.lastUpdated;
              scope.submission.comments    = result.comments;

              scope.submission.submissionOpts = {
                  allowResubmit   : result.allowResubmit
                , includeRevision : result.includeRevision
              };

              feedbackComments = $filter('filter')(scope.submission.comments, { commentType : 'feedback' }, true);

              if (feedbackComments.length) {
                scope.revisionIframe = $sce.trustAsResourceUrl(trinketConfig.getUrl("/assignment-embed-viewonly/" + feedbackComments[0].trinketLang + "/" + feedbackComments[0].trinketShortCode));
              }

              scope.sendingFeedback  = false;
            }, 500);
          });
      }

      scope.acceptSubmission = function() {
        scope.canSubmit           = false;
        scope.canUpdate           = false;
        scope.canAccept           = false;
        scope.acceptingSubmission = true;

        trinketSubmissions.acceptSubmission(scope.material, scope.submission.id)
          .then(function(result) {
            $timeout(function() {
              scope.submission.state = scope.state = result.submissionState;
              scope.acceptingSubmission = false;

              if (scope.state === "submitted") {
                scope.canSubmit = true;
              }
            }, 500);
          });
      }

      scope.cancelFeedback = function() {
        // call parent scope cancel to close feedback row
        scope.cancel();
      }

      scope.setRevisionMade = function(val) {
        // enable/disable checkbox to include modified trinket in feedback...
        scope.revisionMade = val;

        scope.$apply();
      }

      scope.submissionOptChange = function(field) {
        trinketSubmissions.autosaveSubmissionOpt(scope.submission.id, field, scope.feedbackForm[field]);
      }

      scope.autosaveComments = _.debounce(function(e) {
        trinketSubmissions.autosaveFeedbackComments(scope.submission.id, scope.feedbackForm.comments);
      }, 500);

      scope.displayFeedback = function(commentText) {
        return $sce.trustAsHtml( parser( commentText ) );
      }

      scope.editCompleted = function() {
        scope.state = "editing";

        scope.feedbackForm.includeRevision = scope.submission.submissionOpts.includeRevision;
        scope.feedbackForm.allowResubmit   = scope.submission.submissionOpts.allowResubmit;

        var comment = $filter('filter')(scope.submission.comments, { "commentType" : "feedback" }, true);
        var revisionUrl;

        scope.revisionIframe = null;

        if (comment && comment[0]) {
          scope.revisionMade          = true;
          scope.feedbackForm.comments = comment[0].commentText;
          revisionUrl                 = comment[0].trinketLang + "/" + comment[0].trinketShortCode;
          scope.revisionId            = comment[0].trinketId;
        }
        else {
          scope.revisionMade          = false;
          scope.feedbackForm.comments = "";
          revisionUrl                 = scope.submission.lang + "/" + scope.submission.shortCode;
          scope.revisionId            = scope.submission.trinketId;
        }

        scope.revisionIframe = $sce.trustAsResourceUrl(trinketConfig.getUrl("/assignment-embed-feedback/" + revisionUrl));

        $timeout(function() {
          var iframe = angular.element(document.querySelector('#rev-' + scope.revisionId));
          iframe.on('load', function() {
            win = this.contentWindow || this.contentDocument;
            scope.api = win.TrinketApp;

            win.TrinketApp.on('trinket.code.change',   scope.setRevisionMade.bind(null, true));
            win.TrinketApp.on('trinket.draft.discard', scope.setRevisionMade.bind(null, false));

            if (win.TrinketApp.viewingDraft()) {
              scope.revisionMade = true;
            }

            scope.canUpdate = true;
            scope.$apply();
          });
        });
      }

      scope.cancelEdit = function() {
        scope.state = "completed";
      }

      scope.toggleSubmission = function(submission) {
        if (scope.showSubmission[submission.id]) {
          scope.showSubmission[submission.id] = false;
        }
        else {
          scope.showSubmission[submission.id] = true;

          if (!scope.submissionSrc[submission.id]) {
            scope.submissionSrc[submission.id]  = $sce.trustAsResourceUrl(trinketConfig.getUrl("/assignment-embed-viewonly/" + submission.lang + "/" + submission.shortCode));
          }
        }
      }
    }

    return {
        restrict : 'E'
      , link     : link
      , scope    : {
            submission      : '='
          , material        : '='
          , cancel          : '='
          , canSendFeedback : '='
        }
    };
  }]);
})(window.angular);
