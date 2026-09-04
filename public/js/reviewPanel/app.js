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
  angular.module('reviewPanel', ['restangular', 'trinket.feedback', 'trinket.config', 'trinket.markdown', 'trinket.util'])
    .controller('ReviewPanelCtrl', ['$scope', 'Restangular', function ($scope, Restangular) {
      var boot = window.TRINKET_REVIEW_PANEL || {};

      // A REAL Restangular element, not a hand-made lookalike. The directive both
      // reads material.parentResource.parentResource (to fetch submissions) and calls
      // material.customPOST(..., 'feedback') to send feedback — and customPOST is a
      // Restangular method no plain object has. Faking the chain was enough to render
      // and not enough to submit: Send Feedback threw
      //   TypeError: material.customPOST is not a function
      // and the spinner spun forever, because the promise never settled.
      var course = Restangular.one('courses', boot.courseId);
      var lesson = course.one('lessons', boot.lessonId);
      $scope.material = Restangular.restangularizeElement(lesson, boot.material || {}, 'materials');
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
