angular
  .module('trinket.classPage', [
    'ngAria',
    'trinket.markdown',
    'trinket.lang',
    'ui.scrollfix',
    'restangular',
    'trinket.roles',
    'trinket.util',
    'trinket.assignment',
    'angularMoment',
    'slugifier'
  ])
  .config(['RestangularProvider', function(RestangularProvider) {
    RestangularProvider.setBaseUrl('/api');
    RestangularProvider.addResponseInterceptor(function(response) {
      return response.data ? response.data : response;
    });
  }])
  .controller('pageControl', ['$scope', '$window', '$location', '$compile', '$sce', '$timeout', '$anchorScroll', 'markdownParser', 'Restangular', 'trinketRoles', 'trinketUtil', 'moment', 'Slug', function($scope, $window, $location, $compile, $sce, $timeout, $anchorScroll, markdownParser, Restangular, roles, trinketUtil, moment, Slug) {
    var slides            = [];
    var currentSlideIndex = 0;
    var lastRenderedMaterial = null;
    var currentPath       = null;
    var parser            = markdownParser({
      $scope:  $scope,
      preview: false
    });

    $anchorScroll.yOffset = 75;
    var NAV_HEIGHT = 45;
    var CLASSPAGE_OFFSET = 125;

    $scope.menuOpen = trinketUtil.isLarge() ? true : false;
    $scope.slides = slides;

    $scope.courseCopyName = '';

    var menu = $('#outline,#outline-expander');
    $(window).scroll(function(evt) {
      var top = window.pageYOffset || document.body.scrollTop
      if (top <= NAV_HEIGHT && top >= 0) {
        menu.css('top', (CLASSPAGE_OFFSET - top) + 'px');
      }
      else {
        menu.css('top', '');
      }
    });

    $scope.$watch('courseId', function(newValue, oldValue) {
      if (!newValue) return;

      $scope.submissionsAllowed = roles.hasAnyRole("course", { id : $scope.courseId });

      Restangular
        .one('courses', $scope.courseId)
        .get({outline:true,with:['_owner']})
        .then(function(course) {
          $scope.course = course;
          course.lessons = Restangular.restangularizeCollection(course,course.lessons,'lessons');
          angular.forEach(course.lessons, function(lesson) {
            lesson.materials = Restangular.restangularizeCollection(lesson,lesson.materials,'materials');
            angular.forEach(lesson.materials, function(material) {
              slides.push({
                lesson: lesson,
                material: material
              });
            })
          });

          $scope.$on('$locationChangeSuccess', onLocationChange);
          onLocationChange();
        });
    });

    function onLocationChange() {
      var newPath = $location.path();
      if (currentPath === newPath) return;
      currentPath = newPath;

      var index = 0;
      if (newPath) {
        var pathString = newPath.substring(1);
        var materialPath = pathString.split('/');
        if (materialPath.length == 2) {
          for (var i = 0; i < slides.length; i++) {
            if (slides[i].lesson.slug === materialPath[0] && slides[i].material.slug === materialPath[1]) {
              index = i;
              break;
            }
          }
        }
      }
      setSlideIndex(index);
    }

    function setSlideState(index) {
      var setState = function(slide, state) {
        angular.forEach(['isCurrent', 'isPast', 'isFuture'], function(property) {
          slide.material[property] = (property === state);
          slide.lesson[property]  = false;
        });
        if (state === 'isPast' && slide.lesson.materials[slide.lesson.materials.length-1].id === slide.material.id) {
          slide.lesson.isPast = true;
        }
        else if (state === 'isFuture' && slide.lesson.materials[0].id === slide.material.id) {
          slide.lesson.isFuture = true;
        }
        else {
          slide.lesson.isCurrent = true;
        }
      }

      for(var i = 0; i < slides.length; i++) {
        if (i === index) {
          setState(slides[i], 'isCurrent');
        }
        else if (i <= index) {
          setState(slides[i], 'isPast');
        }
        else {
          setState(slides[i], 'isFuture');
        }
      }
    }

    function setSlideIndex(index) {
      currentSlideIndex = index;

      if (slides.length) {
        $scope.lesson   = slides[currentSlideIndex].lesson;
        $scope.material = slides[currentSlideIndex].material;
      } else {
        $scope.material = {
          noContent : true
        };
        return;
      }

      setSlideState(currentSlideIndex);

      $scope.progress = (index+1)/slides.length;

      var updateLocation = function() {
        if (!$location.path() || $location.path() === '/') {
          $location.replace();
        }
        currentPath = '/' + $scope.lesson.slug + '/' + $scope.material.slug;
        $location.path(currentPath);

        if ($location.hash()) {
          $anchorScroll();
          $timeout(function() {
            adjustPaddingForAnchor($location.hash());
          });
        }
      }

      var elem = $($window);
      var top = Math.min(elem.scrollTop(), NAV_HEIGHT);

      function setScroll() {
        var $outlineId = $('#' + $scope.lesson.slug + '-' + $scope.material.slug),
            $outline   = $('#outline'),
            scrollTop;

        if (!trinketUtil.isElementVisible($outlineId, $outline)) {

          if ($outlineId.offset().top > $outline.offset().top) {
            scrollTop = $outline.scrollTop() + $outlineId.offset().top + $outlineId.height() - $outline.height();
          }
          else {
            scrollTop = $outline.scrollTop() + $outlineId.position().top - 20;
          }

          $outline.animate({
            scrollTop: scrollTop
          }, 500);
        }

        $timeout(function() {
          elem.scrollTop(top);
        })
      }

      if ($scope.material.markup) {
        setScroll();
        return updateLocation();
      }

      $scope.material.get()
        .then(function(material) {
          if (material.id !== $scope.material.id) return;
          if (typeof(material.content) !== 'undefined' && material.content.length) {
            $scope.material.markup = parser(material.content);
          }
          else {
            $scope.material.noContent = true;
          }
          setScroll();
          return updateLocation();
        });
    }

    function adjustPaddingForAnchor(anchorId) {
      var elem = document.getElementById(anchorId);

      if (elem) {
        var rect = elem.getBoundingClientRect();
        if (rect && rect.top > $anchorScroll.yOffset) {
          // add padding to #material-content
          var currentPadding = angular.element('#material-content').css('padding-bottom');
          currentPadding = parseFloat( currentPadding.replace('px', '') );
          currentPadding = currentPadding + ( $('#outline').height() - currentPadding );
          angular.element('#material-content').css('padding-bottom', currentPadding + 'px');
        }
      }
    }

    $scope.progress = 0;

    $scope.content = function materialContent() {
      if ($scope.material && $scope.material.markup && lastRenderedMaterial !== $scope.material.id) {
        lastRenderedMaterial = $scope.material.id;
        $timeout(function() {
          MathJax.Hub.Queue(["Typeset",MathJax.Hub,"material"]);
        });
      }

      if ($scope.material && $scope.material.markup) {
        angular.forEach(document.querySelectorAll('h1, h2, h3'), function(elem) {
          // skip app added subheader h1
          if (!angular.element(elem).hasClass('subheader')) {
            var id = angular.element(elem).attr('id');
            if (!id) {
              id = Slug.slugify( angular.element(elem).text() );
              angular.element(elem).attr('id', id);
            }

            if (!angular.element(elem).hasClass('class-anchor')) {
              angular.element(elem).addClass('class-anchor');
              var anchorLink = angular.element('<a><i class="fa fa-link fa-rotate-90"></i></a>');

              anchorLink.on('click', function(event) {
                $location.hash(this.toString());
                $scope.$apply();
                $anchorScroll();
                adjustPaddingForAnchor(this.toString());
              }.bind(id));

              angular.element(elem).append(anchorLink);
            }
          }
        });
      }

      return $sce.trustAsHtml($scope.material && $scope.material.markup || 'loading...');
    }

    $scope.goToMaterial = function goToMaterial(material) {
      for(var i = 0; i < slides.length; i++) {
        if (slides[i].material.id === material.id) {
          $location.hash('');
          setSlideIndex(i);
          break;
        }
      }
    };

    $scope.haveNextMaterial = function haveNextMaterial() {
      return currentSlideIndex === slides.length - 1 ? false : true;
    };

    $scope.nextMaterial = function nextMaterial() {
      if (currentSlideIndex === slides.length-1) return;
      $location.hash('');
      setSlideIndex(currentSlideIndex + 1);
    };

    $scope.havePreviousMaterial = function havePreviousMaterial() {
      return currentSlideIndex === 0 ? false : true;
    }

    $scope.previousMaterial = function previousMaterial() {
      if (currentSlideIndex === 0) return;
      $location.hash('');
      setSlideIndex(currentSlideIndex - 1);
    }

    $scope.editMaterial = function editMaterial() {
      var editLocation = $scope.course._owner.username + '/courses/' + $scope.course.slug + '#' + currentPath;
      $window.location = trinketConfig.getUrl(editLocation);
    }

    $scope.viewDashboard = function viewDashboard() {
      var dashboardLocation = $scope.course._owner.username + '/courses/' + $scope.course.slug + '#/_dashboard';
      $window.location = trinketConfig.getUrl(dashboardLocation);
    }

    $scope.copyCourse = function() {
      var name = $scope.courseCopyName || "Copy of " + $scope.course.name;

      return $scope.course.customPOST({ name : name }, 'copy')
        .then(function(result) {
          if (result.success) {
            $window.location = result.url;
          }
          else {
            $scope.courseCopyName = name;
            $('#copyCourseNameDialog').foundation('reveal', 'open');
          }
        });
    }

    // true for students only if using a due date
    $scope.usingDates = function(material) {
      return material && material.trinket &&
        ( (material.trinket.submissionsDue && material.trinket.submissionsDue.enabled) );
    }
  }])
