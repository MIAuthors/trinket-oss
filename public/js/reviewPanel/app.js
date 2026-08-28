// Host app for the LTI review panel: the instructor's feedback UI, rendered on its
// own so it can live inside an LMS grader iframe.
//
// Deliberately tiny. The panel itself is the existing `trinket-feedback` directive,
// unchanged — this only supplies its four inputs. The server has already resolved
// and authorized the submission and embeds both objects, so there is no fetching,
// no routing, and no course-app chrome.
(function (angular) {
  'use strict';

  // trinket-feedback injects trinketConfig (trinket.config) and markdownParser
  // (trinket.markdown) but does NOT declare them — it relies on the host app having
  // pulled them in, which the course app does. Listing only 'trinket.feedback' left
  // the provider unregistered and Angular threw
  //   [$injector:unpr] trinketConfigProvider <- trinketConfig <- trinketFeedbackDirective
  // which renders as a silently blank panel.
  angular.module('reviewPanel', ['trinket.feedback', 'trinket.config', 'trinket.markdown'])
    .controller('ReviewPanelCtrl', ['$scope', function ($scope) {
      var boot = window.TRINKET_REVIEW_PANEL || {};

      $scope.material   = boot.material;
      $scope.submission = boot.submission;

      // The route already required send-submission-feedback before rendering, so
      // reaching this page IS the permission check. Re-deriving it client-side would
      // only add a way for the two to disagree.
      $scope.canSendFeedback = function () { return true; };

      // In the dashboard, Cancel closes the inline panel and returns to the list.
      // Here the panel IS the page, so there is nowhere to return to.
      $scope.cancelFeedback = function () {};
    }]);
})(window.angular);
