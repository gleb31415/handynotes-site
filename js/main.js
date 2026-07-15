(function () {
  "use strict";

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
