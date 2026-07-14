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

  /* ---- live ink: scribble on the hero (mouse and Apple Pencil; fingers scroll) ---- */
  var hero = document.getElementById("hero");
  var canvas = hero && hero.querySelector(".hero__ink");

  if (hero && canvas && canvas.getContext) {
    var ctx = canvas.getContext("2d");
    var strokes = [];          // each: { points: [{x, y, w}], bornAt }
    var current = null;
    var rafId = null;
    var DPR = Math.min(window.devicePixelRatio || 1, 2);
    var HOLD_MS = 5000;        // fully opaque for this long…
    var FADE_MS = 2500;        // …then fades out over this long
    var inkColor = "#CC8C85";

    var readInk = function () {
      inkColor = getComputedStyle(document.documentElement)
        .getPropertyValue("--color-accent").trim() || inkColor;
    };
    readInk();
    var scheme = window.matchMedia("(prefers-color-scheme: dark)");
    if (scheme.addEventListener) scheme.addEventListener("change", readInk);

    var resize = function () {
      var r = hero.getBoundingClientRect();
      canvas.width = Math.round(r.width * DPR);
      canvas.height = Math.round(r.height * DPR);
      canvas.style.width = r.width + "px";
      canvas.style.height = r.height + "px";
    };
    resize();
    window.addEventListener("resize", resize);

    var pos = function (e) {
      var r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) * DPR, y: (e.clientY - r.top) * DPR };
    };

    var drawStroke = function (s, alpha) {
      var pts = s.points;
      if (pts.length < 2) return;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = inkColor;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      // pass through midpoints with quadratic curves for a smooth, inky line
      for (var i = 1; i < pts.length - 1; i++) {
        ctx.beginPath();
        ctx.lineWidth = pts[i].w;
        ctx.moveTo((pts[i - 1].x + pts[i].x) / 2, (pts[i - 1].y + pts[i].y) / 2);
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
        ctx.stroke();
      }
    };

    var render = function (now) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      var alive = false;
      for (var i = strokes.length - 1; i >= 0; i--) {
        var s = strokes[i];
        var age = s === current ? 0 : now - s.bornAt;
        if (age > HOLD_MS + FADE_MS) { strokes.splice(i, 1); continue; }
        var alpha = age <= HOLD_MS ? 1 : 1 - (age - HOLD_MS) / FADE_MS;
        drawStroke(s, alpha);
        alive = true;
      }
      ctx.globalAlpha = 1;
      rafId = alive || current ? requestAnimationFrame(render) : null;
    };

    var kick = function () {
      if (rafId === null) rafId = requestAnimationFrame(render);
    };

    hero.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "touch") return;                     // fingers scroll
      if (e.button !== 0) return;
      if (e.target.closest("a, button")) return;                 // links stay links
      var p = pos(e);
      current = { points: [{ x: p.x, y: p.y, w: 3.5 * DPR }], bornAt: performance.now() };
      strokes.push(current);
      hero.classList.add("is-inking");
      var hint = hero.querySelector(".hero__hint");
      if (hint) hint.classList.add("is-done");
      kick();
    });

    window.addEventListener("pointermove", function (e) {
      if (!current) return;
      var p = pos(e);
      var pts = current.points;
      var last = pts[pts.length - 1];
      var dx = p.x - last.x, dy = p.y - last.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 2 * DPR) return;
      // faster strokes go thinner — reads as real ink
      var w = Math.max(1.75, 4.5 - dist * 0.04) * DPR;
      pts.push({ x: p.x, y: p.y, w: (last.w + w) / 2 });
    });

    var endStroke = function () {
      if (!current) return;
      current.bornAt = performance.now();
      current = null;
      hero.classList.remove("is-inking");
    };
    window.addEventListener("pointerup", endStroke);
    window.addEventListener("pointercancel", endStroke);
  }
})();
