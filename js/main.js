(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- scroll reveal (features, section heads, CTA) ---- */
  var reveals = document.querySelectorAll(".reveal");

  if (reveals.length) {
    if (reduceMotion || !("IntersectionObserver" in window)) {
      reveals.forEach(function (el) { el.classList.add("is-visible"); });
    } else {
      var observer = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              entry.target.classList.add("is-visible");
              observer.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.2, rootMargin: "0px 0px -10% 0px" }
      );

      reveals.forEach(function (el, i) {
        el.style.setProperty("--i", i % 4);
        observer.observe(el);
      });
    }
  }

  /* ---- nav scroll-compact (functional chrome, not decorative) ---- */
  var nav = document.querySelector(".nav-pill");
  if (nav) {
    var ticking = false;
    var setCompact = function () {
      nav.classList.toggle("is-compact", window.scrollY > 8);
      ticking = false;
    };
    window.addEventListener(
      "scroll",
      function () {
        if (!ticking) {
          window.requestAnimationFrame(setCompact);
          ticking = true;
        }
      },
      { passive: true }
    );
    setCompact();
  }

})();
