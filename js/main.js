(function () {
  "use strict";

  /* ---- language toggle (EN ⇄ RU) — swaps .i18n-en/.i18n-ru text in place, or on a
     published one-language page opens its twin (?lang= carries the choice when storage is off) ---- */
  document.querySelectorAll(".nav-pill__lang").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var root = document.documentElement;
      var next = root.getAttribute("data-lang") === "ru" ? "en" : "ru";
      var stored = true;
      try { localStorage.setItem("hn-lang", next); } catch (e) { stored = false; /* private mode */ }
      var twin = root.hasAttribute("data-lang-fixed") && root.getAttribute("data-alt-" + next);
      if (twin) { location.href = twin + (stored ? "" : "?lang=" + next) + location.hash; return; }
      root.setAttribute("data-lang", next);
      root.lang = next;
    });
  });

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
