/* Pencora landing — interactions.
 * Plain ES5-ish browser script, no build step. The screens are real app screenshots
 * (images/shots/, recorded in the iPad simulator), played back object by object from the
 * timelines in js/scenes.js.
 */
(function () {
  "use strict";

  var root = document.documentElement;
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function cssVar(name) { return getComputedStyle(root).getPropertyValue(name).trim(); }

  /* ---------------------------------------------------------------- language + chrome */

  $$(".nav__lang").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var next = root.getAttribute("data-lang") === "ru" ? "en" : "ru";
      root.setAttribute("data-lang", next);
      root.lang = next;
      try { localStorage.setItem("hn-lang", next); } catch (e) { /* private mode */ }
    });
  });

  // light / dark: follows the system until the toggle is used, then remembers the choice
  var darkMQ = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  var isDark = function () {
    var t = root.getAttribute("data-theme");
    return t ? t === "dark" : !!(darkMQ && darkMQ.matches);
  };
  $$(".theme-toggle").forEach(function (btn) {
    var sync = function () { btn.setAttribute("aria-pressed", isDark() ? "true" : "false"); };
    sync();
    btn.addEventListener("click", function () {
      var next = isDark() ? "light" : "dark";
      root.classList.add("theme-anim");
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("hn-theme", next); } catch (e) { /* private mode */ }
      sync();
      clearTimeout(btn._t);
      btn._t = setTimeout(function () { root.classList.remove("theme-anim"); }, 650);
    });
    if (darkMQ && darkMQ.addEventListener) darkMQ.addEventListener("change", sync);
  });

  // visibility: reveal once; players loop only while on screen
  var visible = new WeakMap();
  var waiters = new WeakMap();
  function whenVisible(el) {
    if (visible.get(el)) return Promise.resolve();
    return new Promise(function (r) { var list = waiters.get(el) || []; list.push(r); waiters.set(el, list); });
  }
  var io = "IntersectionObserver" in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      visible.set(e.target, e.isIntersecting);
      if (e.isIntersecting) {
        e.target.classList.add("is-in");
        (waiters.get(e.target) || []).forEach(function (r) { r(); });
        waiters.delete(e.target);
      }
    });
  }, { threshold: 0.2 }) : null;
  $$(".reveal, [data-scene], [data-demo]").forEach(function (el) {
    if (io) io.observe(el); else { el.classList.add("is-in"); visible.set(el, true); }
  });

  // pointer-follow light on cards
  $$(".card").forEach(function (card) {
    card.addEventListener("pointermove", function (e) {
      var r = card.getBoundingClientRect();
      card.style.setProperty("--mx", (e.clientX - r.left) + "px");
      card.style.setProperty("--my", (e.clientY - r.top) + "px");
    });
  });

  // the hero iPad turns a little toward the pointer
  var stage = $(".hero__stage"), ipad = $(".ipad");
  if (stage && ipad && !reduced && window.matchMedia("(hover: hover)").matches) {
    var hero = $(".hero");
    hero.addEventListener("pointermove", function (e) {
      var r = stage.getBoundingClientRect();
      var nx = clamp((e.clientX - (r.left + r.width / 2)) / (r.width * 1.2), -1, 1);
      var ny = clamp((e.clientY - (r.top + r.height / 2)) / (r.height * 1.2), -1, 1);
      ipad.style.setProperty("--ry", (-4 + nx * 9).toFixed(2) + "deg");
      ipad.style.setProperty("--rx", (2 - ny * 6).toFixed(2) + "deg");
    });
    hero.addEventListener("pointerleave", function () {
      ipad.style.removeProperty("--ry");
      ipad.style.removeProperty("--rx");
    });
  }

  /* ---------------------------------------------------------------- scene player */

  // Every screen is two real screenshots: the empty page (base) and the finished one. The
  // timeline in js/scenes.js (window.PENCORA_SCENES) reveals the finished pixels object by
  // object — pen strokes along the very paths that were written in the simulator, curves
  // along their traced shape, words left to right, panels rising in. An SVG laid over the
  // screenshot does it: one masked <image> per source frame, the mask filled by those
  // objects as they play. A soft nib follows whatever stroke is being drawn.
  var SVGNS = "http://www.w3.org/2000/svg";
  var SHOT_DIR = "/images/shots/";
  function el(tag, attrs, parent) {
    var n = document.createElementNS(SVGNS, tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function easeOut(p) { return 1 - Math.pow(1 - p, 3); }
  function easeInOut(p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }
  function easeBack(p) { var c = 1.6; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); }

  var sceneUid = 0;
  function Scene(host, data) {
    var self = this;
    this.host = host; this.data = data; this.t = 0; this.phase = "wait"; this.phaseT = 0;
    var id = "sc" + (++sceneUid);
    var W = data.w, H = data.h, finalSrc = data.final;
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, preserveAspectRatio: "xMidYMid slice", "class": "scene", "aria-hidden": "true" });
    var defs = el("defs", {}, svg);
    el("image", { href: SHOT_DIR + data.base, width: W, height: H }, svg);
    var stage = el("g", {}, svg);
    this.stage = stage;

    // layers: rise/pop groups showing another frame sit lowest, then masked layers of other
    // frames, then the finished frame on top (its curves must draw over panels that rose in)
    var masks = {}, order = [];
    function maskFor(src) {
      if (masks[src]) return masks[src];
      var m = el("mask", { id: id + "m" + order.length, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: W, height: H }, defs);
      masks[src] = m; order.push(src);
      return m;
    }
    var lowGroups = el("g", {}, stage);
    var maskLayers = el("g", {}, stage);
    var topGroups = el("g", {}, stage);

    this.items = data.objs.map(function (o, i) {
      var it = { o: o, last: -1 };
      var src = o.src || finalSrc;
      if (o.k === "draw") {
        var p = el("path", { d: o.d, fill: "none", stroke: "#fff", "stroke-width": o.w, "stroke-linecap": "round", "stroke-linejoin": "round", visibility: "hidden" }, maskFor(src));
        it.node = p;
        it.len = p.getTotalLength ? p.getTotalLength() : 1000;
        p.setAttribute("stroke-dasharray", it.len + " " + (it.len + 10));
        p.setAttribute("stroke-dashoffset", it.len);
      } else if (o.k === "wipe" || o.k === "fade") {
        var r = o.r;
        it.node = el("rect", { x: r[0], y: r[1], width: o.k === "wipe" ? 0 : r[2], height: r[3], fill: "#fff", opacity: o.k === "fade" ? 0 : 1 }, maskFor(src));
      } else {
        var cp = el("clipPath", { id: id + "c" + i }, defs);
        el("rect", { x: o.r[0], y: o.r[1], width: o.r[2], height: o.r[3] }, cp);
        var g = el("g", { opacity: 0 }, o.src ? lowGroups : topGroups);
        el("image", { href: SHOT_DIR + src, width: W, height: H, "clip-path": "url(#" + id + "c" + i + ")" }, g);
        it.node = g;
        it.cx = o.r[0] + o.r[2] / 2; it.cy = o.r[1] + o.r[3] / 2;
      }
      return it;
    });
    order.sort(function (a, b) { return (a === finalSrc) - (b === finalSrc); });
    order.forEach(function (src) {
      el("image", { href: SHOT_DIR + src, width: W, height: H, mask: "url(#" + masks[src].id + ")" }, maskLayers);
    });

    // the nib: a soft dot riding the tip of the stroke being drawn
    var tip = el("g", { "class": "scene__tip", opacity: 0 }, svg);
    var tr = Math.max(W, H) / 150;
    el("circle", { r: tr * 2.2, "class": "scene__tip-halo" }, tip);
    el("circle", { r: tr * 0.85, "class": "scene__tip-core" }, tip);
    this.tip = tip;
    this.svg = svg;
    host.appendChild(svg);
    host.classList.add("is-live");
  }
  Scene.prototype.render = function (t) {
    var tipItem = null, tipP = 0;
    for (var i = 0; i < this.items.length; i++) {
      var it = this.items[i], o = it.o;
      var p = clamp((t - o.t) / o.dur, 0, 1);
      var q = o.out ? clamp((t - o.out) / o.outDur, 0, 1) : 0;
      var key = p * 1000 + q;
      if (key === it.last) continue;
      it.last = key;
      var n = it.node;
      if (o.k === "draw") {
        var e = o.dur >= 500 ? easeInOut(p) : p;
        n.setAttribute("visibility", p > 0 ? "visible" : "hidden");
        n.setAttribute("stroke-dashoffset", (it.len * (1 - e)).toFixed(1));
        if (o.out) n.setAttribute("opacity", (1 - q).toFixed(3));
        if (p > 0 && p < 1 && !o.out) { tipItem = it; tipP = e; }
      } else if (o.k === "wipe") {
        var pw = o.steps ? Math.ceil(p * o.steps) / o.steps : easeOut(p);
        n.setAttribute("width", (o.r[2] * pw).toFixed(1));
      } else if (o.k === "fade") {
        n.setAttribute("opacity", easeOut(p).toFixed(3));
      } else if (o.k === "rise") {
        var er = easeOut(p);
        n.setAttribute("opacity", er.toFixed(3));
        n.setAttribute("transform", "translate(0 " + ((o.dy || 16) * (1 - er)).toFixed(2) + ")");
      } else if (o.k === "pop") {
        var s = p > 0 ? 0.55 + 0.45 * easeBack(p) : 0.55;
        n.setAttribute("opacity", Math.min(1, p * 2).toFixed(3));
        n.setAttribute("transform", "translate(" + it.cx + " " + it.cy + ") scale(" + s.toFixed(3) + ") translate(" + -it.cx + " " + -it.cy + ")");
      }
    }
    if (tipItem && tipItem.node.getPointAtLength) {
      var pt = tipItem.node.getPointAtLength(tipItem.len * tipP);
      this.tip.setAttribute("transform", "translate(" + pt.x.toFixed(1) + " " + pt.y.toFixed(1) + ")");
      this.tip.setAttribute("opacity", "1");
      this.tipOn = true;
    } else if (this.tipOn) {
      this.tip.setAttribute("opacity", "0");
      this.tipOn = false;
    }
  };
  Scene.prototype.reset = function () {
    for (var i = 0; i < this.items.length; i++) this.items[i].last = -1;
    this.stage.setAttribute("opacity", "1");
    this.render(-1);
  };
  Scene.prototype.step = function (dt) {
    var d = this.data;
    if (this.phase === "wait") { this.phaseT += dt; if (this.phaseT > 250) { this.phase = "play"; this.t = 0; } return; }
    if (this.phase === "play") {
      this.t += dt;
      this.render(this.t);
      if (this.t >= d.total) { this.phase = "hold"; this.phaseT = 0; }
    } else if (this.phase === "hold") {
      this.phaseT += dt;
      if (this.phaseT >= d.hold) { this.phase = "clear"; this.phaseT = 0; }
    } else if (this.phase === "clear") {
      this.phaseT += dt;
      var p = clamp(this.phaseT / 700, 0, 1);
      this.stage.setAttribute("opacity", (1 - easeInOut(p)).toFixed(3));
      if (p >= 1) { this.reset(); this.phase = "wait"; this.phaseT = 0; }
    }
  };

  var scenes = [];
  var SCENES = window.PENCORA_SCENES || {};
  if (!reduced && document.createElementNS) {
    $$("[data-scene]").forEach(function (host) {
      var data = SCENES[host.getAttribute("data-scene")];
      if (!data) return;
      var start = function () {
        var sc = new Scene(host, data);
        sc.reset();
        scenes.push(sc);
        kickScenes();
      };
      // build once the screenshots are close: preload both frames, then go
      whenVisible(host).then(function () {
        var srcs = [data.base, data.final];
        data.objs.forEach(function (o) { if (o.src && srcs.indexOf(o.src) < 0) srcs.push(o.src); });
        return Promise.all(srcs.map(function (s) {
          return new Promise(function (r) { var im = new Image(); im.onload = im.onerror = r; im.src = SHOT_DIR + s; });
        }));
      }).then(start);
    });
  }
  var scenesRunning = false, lastTs = 0;
  function kickScenes() {
    if (scenesRunning) return;
    scenesRunning = true;
    lastTs = performance.now();
    requestAnimationFrame(function loop(ts) {
      var dt = Math.min(50, ts - lastTs);
      lastTs = ts;
      var any = false;
      for (var i = 0; i < scenes.length; i++) {
        if (!visible.get(scenes[i].host)) continue;
        any = true;
        scenes[i].step(dt);
      }
      if (any) requestAnimationFrame(loop);
      else { scenesRunning = false; }
    });
  }
  if (io) {
    // resume the loop when a scene scrolls back into view
    var sceneIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) kickScenes(); });
    }, { threshold: 0.2 });
    $$("[data-scene]").forEach(function (h) { sceneIo.observe(h); });
  }

  /* ---------------------------------------------------------------- the pen: ink and nib in one frame */

  // A broad-nib flourish (a coil of growing loops, a big swoop, a curled swash). The ink and
  // the nib are drawn from the same point in the same frame, so the stroke never trails the
  // pen. The pen slows in tight turns and runs on the straights, the width follows the nib
  // angle, and the ink turns from ink colour into the accent along the way.
  var penArt = $(".engine-art");
  if (penArt) {
    var inkCv = $(".engine-art__ink", penArt), nibCv = $(".engine-art__nib", penArt);
    var inkCx = inkCv.getContext("2d"), nibCx = nibCv.getContext("2d");
    var VW = 520, VH = 125;
    var flourish = (function () {
      var raw = [], i, u;
      for (i = 0; i <= 520; i++) {
        u = i / 520;
        var phi = Math.PI + u * 10 * Math.PI, r = 8 + 20 * Math.pow(u, 0.8);
        raw.push([34 + 230 * u + r * Math.sin(phi) * 1.05, 84 - r * Math.cos(phi) * 0.95 - 10 * u]);
      }
      var tail = [raw[raw.length - 1], [292, 44], [330, 18], [372, 26], [384, 62], [356, 98], [318, 104], [300, 80],
        [332, 58], [392, 66], [446, 92], [488, 108], [508, 96], [504, 78], [488, 76], [482, 88]];
      var P = [tail[0]].concat(tail, [tail[tail.length - 1]]);
      raw.pop();
      for (i = 1; i < P.length - 2; i++) {
        for (var k = 0; k < 22; k++) {
          var t = k / 22, t2 = t * t, t3 = t2 * t, pt = [];
          for (var j = 0; j < 2; j++) {
            pt.push(0.5 * (2 * P[i][j] + (-P[i - 1][j] + P[i + 1][j]) * t + (2 * P[i - 1][j] - 5 * P[i][j] + 4 * P[i + 1][j] - P[i + 2][j]) * t2 +
              (-P[i - 1][j] + 3 * P[i][j] - 3 * P[i + 1][j] + P[i + 2][j]) * t3));
          }
          raw.push(pt);
        }
      }
      raw.push(tail[tail.length - 1]);
      // even steps along the curve
      var pts = [raw[0]], acc = 0, step = 1.2;
      for (i = 1; i < raw.length; i++) {
        var a = raw[i - 1], b = raw[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (!d) continue;
        var s = step - acc;
        while (s <= d) { pts.push([a[0] + (b[0] - a[0]) * s / d, a[1] + (b[1] - a[1]) * s / d]); s += step; }
        acc = d - (s - step);
      }
      pts.push(raw[raw.length - 1]);
      var n = pts.length, NIB = 38 * Math.PI / 180, w = [], ang = [], time = [0];
      for (i = 0; i < n; i++) {
        var p0 = pts[Math.max(0, i - 2)], p1 = pts[Math.min(n - 1, i + 2)];
        ang.push(Math.atan2(p1[1] - p0[1], p1[0] - p0[0]));
        var taper = Math.min(1, i / 40, (n - 1 - i) / 60);
        w.push((1.6 + 6.4 * Math.abs(Math.sin(ang[i] - NIB))) * (0.35 + 0.65 * taper));
      }
      // time per step: longer where the direction turns fast
      for (i = 1; i < n; i++) {
        var turn = Math.abs(Math.atan2(Math.sin(ang[i] - ang[i - 1]), Math.cos(ang[i] - ang[i - 1])));
        time.push(time[i - 1] + 1 + 9 * turn);
      }
      for (i = 0; i < n; i++) time[i] /= time[n - 1];
      return { pts: pts, w: w, time: time, n: n };
    })();
    var DRAW = 2600, HOLD = 1300, FADE = 500, CYCLE = DRAW + HOLD + FADE;
    var penScale = 1, drawnTo = 0, penT = 0, penLast = 0, penRunning = false, fading = false;
    var inkRGB = [28, 26, 30], accRGB = [176, 100, 91];
    var readColours = function () {
      var probe = document.createElement("span");
      probe.style.display = "none"; document.body.appendChild(probe);
      var rgb = function (v) {
        probe.style.color = ""; probe.style.color = v;
        var m = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g);
        return m ? [+m[0], +m[1], +m[2]] : null;
      };
      var cs = getComputedStyle(document.documentElement);
      inkRGB = rgb(cs.getPropertyValue("--text").trim()) || inkRGB;
      accRGB = rgb(cs.getPropertyValue("--accent-strong").trim()) || accRGB;
      probe.remove();
    };
    var sizePen = function () {
      var r = penArt.getBoundingClientRect(), dpr = Math.min(3, window.devicePixelRatio || 1);
      if (!r.width) return false;
      [inkCv, nibCv].forEach(function (c) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); });
      penScale = (r.width * dpr) / VW;
      inkCx.setTransform(penScale, 0, 0, penScale, 0, 0);
      nibCx.setTransform(penScale, 0, 0, penScale, 0, 0);
      return true;
    };
    var colourAt = function (f) {
      var e = f * f;
      return "rgb(" + Math.round(inkRGB[0] + (accRGB[0] - inkRGB[0]) * e) + "," + Math.round(inkRGB[1] + (accRGB[1] - inkRGB[1]) * e) + "," +
        Math.round(inkRGB[2] + (accRGB[2] - inkRGB[2]) * e) + ")";
    };
    // lay ink from segment `from` up to the point at fraction `frac` of segment `to`
    var tipAt = function (i, frac) {
      var F = flourish, a = F.pts[i], b = F.pts[Math.min(F.n - 1, i + 1)];
      return [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac, F.w[i] + (F.w[Math.min(F.n - 1, i + 1)] - F.w[i]) * frac];
    };
    var layInk = function (from, upto) {
      var F = flourish;
      for (var i = Math.max(1, from); i <= upto; i++) {
        var a = F.pts[i - 1], b = F.pts[i], wa = F.w[i - 1] / 2, wb = F.w[i] / 2;
        var th = Math.atan2(b[1] - a[1], b[0] - a[0]), nx = -Math.sin(th), ny = Math.cos(th);
        inkCx.fillStyle = colourAt(i / F.n);
        inkCx.beginPath();
        inkCx.moveTo(a[0] + nx * wa, a[1] + ny * wa); inkCx.lineTo(b[0] + nx * wb, b[1] + ny * wb);
        inkCx.lineTo(b[0] - nx * wb, b[1] - ny * wb); inkCx.lineTo(a[0] - nx * wa, a[1] - ny * wa);
        inkCx.closePath(); inkCx.fill();
        inkCx.beginPath(); inkCx.arc(b[0], b[1], wb, 0, 6.2832); inkCx.fill();
      }
    };
    var drawNib = function (tip) {
      nibCx.clearRect(0, 0, VW, VH);
      if (!tip) return;
      nibCx.fillStyle = "rgba(" + accRGB.join(",") + ",0.22)";
      nibCx.beginPath(); nibCx.arc(tip[0], tip[1], 12, 0, 6.2832); nibCx.fill();
      nibCx.fillStyle = "rgb(" + accRGB.join(",") + ")";
      nibCx.beginPath(); nibCx.arc(tip[0], tip[1], 4.6, 0, 6.2832); nibCx.fill();
    };
    // the index the pen has reached at time fraction p (time[] is increasing)
    var indexAt = function (p) {
      var T = flourish.time, lo = 0, hi = flourish.n - 1;
      if (p >= 1) return [hi, 0];
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (T[mid] <= p) lo = mid; else hi = mid; }
      return [lo, (p - T[lo]) / Math.max(1e-9, T[hi] - T[lo])];
    };
    var renderPen = function () {
      var t = penT % CYCLE;
      if (t < DRAW) {
        if (fading) { fading = false; inkCv.classList.remove("is-fading"); inkCx.clearRect(0, 0, VW, VH); drawnTo = 0; readColours(); }
        var at = indexAt(easeInOut(t / DRAW) * 0.25 + (t / DRAW) * 0.75), idx = at[0];
        if (idx > drawnTo) { layInk(drawnTo + 1, idx); drawnTo = idx; }
        var tip = tipAt(idx, at[1]);
        // the last partial step, drawn every frame so ink reaches exactly under the nib
        var a = flourish.pts[idx];
        inkCx.fillStyle = colourAt(idx / flourish.n);
        inkCx.beginPath(); inkCx.arc(tip[0], tip[1], tip[2] / 2, 0, 6.2832); inkCx.fill();
        inkCx.lineWidth = tip[2]; inkCx.strokeStyle = inkCx.fillStyle;
        inkCx.beginPath(); inkCx.moveTo(a[0], a[1]); inkCx.lineTo(tip[0], tip[1]); inkCx.stroke();
        drawNib(tip);
      } else {
        if (drawnTo < flourish.n - 1) { layInk(drawnTo + 1, flourish.n - 1); drawnTo = flourish.n - 1; }
        drawNib(null);
        if (t >= DRAW + HOLD && !fading) { fading = true; inkCv.classList.add("is-fading"); }
      }
    };
    var penLoop = function (ts) {
      if (!visible.get(penArt)) { penRunning = false; return; }
      penT += Math.min(50, ts - penLast); penLast = ts;
      renderPen();
      requestAnimationFrame(penLoop);
    };
    var kickPen = function () {
      if (penRunning) return;
      penRunning = true; penLast = performance.now();
      requestAnimationFrame(penLoop);
    };
    var redrawPen = function () {
      if (!sizePen()) return;
      readColours();
      inkCx.clearRect(0, 0, VW, VH);
      var keep = drawnTo; drawnTo = 0;
      if (reduced) { layInk(1, flourish.n - 1); drawnTo = flourish.n - 1; return; }
      if (keep) { layInk(1, keep); drawnTo = keep; }
    };
    redrawPen();
    window.addEventListener("resize", redrawPen);
    new MutationObserver(redrawPen).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    if (!reduced && io) {
      io.observe(penArt);
      new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) kickPen(); });
      }, { threshold: 0.2 }).observe(penArt);
    }
  }

  /* ---------------------------------------------------------------- the infinite board camera */

  // The board is real: same-zoom simulator pans stitched into one layer of ink (paper keyed
  // out, graph planes kept whole), the app's chrome from the same screenshots on top, and
  // the grid paper drawn here so it runs on forever. A camera zooms out over the whole
  // board, dives into one cluster, pans to the next and zooms out again.
  var boardHost = $("[data-board-cam]");
  if (boardHost && !reduced) {
    var cam = JSON.parse(boardHost.getAttribute("data-board-cam"));
    var zFit = function (v, cap) {
      return Math.min(cap, cam.screen[0] * 0.9 / v.size[0], cam.screen[1] * 0.9 / v.size[1]);
    };
    var V = cam.views, P = function (name, z) { return { x: V[name].c[0], y: V[name].c[1], z: z || zFit(V[name], 1.12) }; };
    // the overview pulls back well past the ink, so the clusters sit on a board with no edges
    var ALL = P("all", zFit(V.all, 1) * 0.6);
    // key poses and how long each move / hold takes (ms)
    var poses = [P("A"), ALL, P("B"), P("C"), ALL, P("A")];
    var moves = [1500, 1500, 1800, 1400, 1500];
    var holds = [1500, 700, 1300, 1300, 600];
    var bCycle = 0; for (var bi = 0; bi < moves.length; bi++) bCycle += holds[bi] + moves[bi];
    var bWrap = document.createElement("div"); bWrap.className = "bcam";
    var bGrid = document.createElement("div"); bGrid.className = "bcam__grid";
    var bInk = new Image(); bInk.className = "bcam__ink"; bInk.alt = ""; bInk.decoding = "async";
    bInk.width = cam.img[0]; bInk.height = cam.img[1];
    var bChrome = new Image(); bChrome.className = "bcam__chrome"; bChrome.alt = "";
    bWrap.appendChild(bGrid); bWrap.appendChild(bInk); bWrap.appendChild(bChrome);
    var bT = 0, bLast = 0, bRunning = false, bReady = false;
    var poseAt = function (t) {
      t = t % bCycle;
      for (var i = 0; i < moves.length; i++) {
        if (t < holds[i]) return poses[i];
        t -= holds[i];
        if (t < moves[i]) {
          var a = poses[i], b = poses[i + 1], e = easeInOut(t / moves[i]);
          // zoom on a log scale; while zooming, keep the point being zoomed into steady
          var z = Math.exp(Math.log(a.z) + (Math.log(b.z) - Math.log(a.z)) * e);
          var w = a.z === b.z ? e : (1 / z - 1 / a.z) / (1 / b.z - 1 / a.z);
          return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w, z: z };
        }
        t -= moves[i];
      }
      return poses[poses.length - 1];
    };
    var drawBoard = function () {
      var W = boardHost.clientWidth, H = boardHost.clientHeight;
      if (!W || !H) return;
      var p = poseAt(bT), k = (W / cam.screen[0]) * p.z;
      var tx = W / 2 - p.x * k, ty = H / 2 - p.y * k;
      bInk.style.transform = "translate(" + tx.toFixed(2) + "px," + ty.toFixed(2) + "px) scale(" + k.toFixed(5) + ")";
      var gx = cam.grid.period[0] * k, gy = cam.grid.period[1] * k;
      bGrid.style.backgroundSize = gx.toFixed(3) + "px " + gy.toFixed(3) + "px";
      bGrid.style.backgroundPosition = (tx + cam.grid.phase[0] * k).toFixed(2) + "px " + (ty + cam.grid.phase[1] * k).toFixed(2) + "px";
    };
    var boardLoop = function (ts) {
      if (!visible.get(boardHost)) { bRunning = false; return; }
      bT += Math.min(50, ts - bLast); bLast = ts;
      drawBoard();
      requestAnimationFrame(boardLoop);
    };
    var kickBoard = function () {
      if (bRunning || !bReady) return;
      bRunning = true; bLast = performance.now();
      requestAnimationFrame(boardLoop);
    };
    if (io) io.observe(boardHost);
    whenVisible(boardHost).then(function () {
      var loaded = 0, done = function () {
        if (++loaded < 2) return;
        boardHost.appendChild(bWrap);
        drawBoard();
        boardHost.classList.add("is-live");
        bReady = true;
        kickBoard();
      };
      bInk.onload = bChrome.onload = done;
      bInk.onerror = bChrome.onerror = function () {};
      bInk.src = SHOT_DIR + cam.ink;
      bChrome.src = SHOT_DIR + cam.chrome;
    });
    if (io) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) kickBoard(); });
      }, { threshold: 0.2 }).observe(boardHost);
    }
    window.addEventListener("resize", drawBoard);
  }

  /* ---------------------------------------------------------------- the model's own handwriting */

  // js/model-sample.js holds real output of the Pencora handwriting model (strokes + the
  // model's own timings). It is written out here stroke by stroke, four times faster than the
  // model's pace, on ruled paper; then it holds, fades and writes again.
  var modelSvg = $(".model__ink"), MODEL = window.PENCORA_MODEL;
  if (modelSvg && MODEL) {
    var MNS = "http://www.w3.org/2000/svg", mk = function (tag, attrs, parent) {
      var n = document.createElementNS(MNS, tag);
      for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
      if (parent) parent.appendChild(n);
      return n;
    };
    modelSvg.setAttribute("viewBox", "-2 0 " + (MODEL.w + 4) + " " + MODEL.h);
    for (var mr = 0; mr < MODEL.rows; mr++) {
      var ry = MODEL.first + mr * MODEL.pitch + 2.2;
      mk("line", { x1: -2, x2: MODEL.w + 2, y1: ry, y2: ry, "class": "rule" }, modelSvg);
    }
    var inkG = mk("g", {}, modelSvg);
    var mStrokes = MODEL.strokes.map(function (st) {
      var p = mk("path", { d: st.d, "class": "stroke" }, inkG);
      var len = p.getTotalLength ? p.getTotalLength() : 50;
      p.style.strokeDasharray = len + " " + (len + 4);
      p.style.strokeDashoffset = reduced ? 0 : len;
      if (!reduced) p.style.visibility = "hidden";
      return { p: p, len: len, t0: st.t0, t1: Math.max(st.t1, st.t0 + 30), last: -1 };
    });
    if (!reduced) {
      var MSPEED = 4, mt = 0, mphase = "wait", mHold = 0, mPrev = 0, mRunning = false;
      var mEnd = (MODEL.dur) / MSPEED;
      var renderModel = function () {
        var t = mt * MSPEED;
        for (var i = 0; i < mStrokes.length; i++) {
          var st = mStrokes[i], f = clamp((t - st.t0) / (st.t1 - st.t0), 0, 1);
          if (f === st.last) continue;
          st.last = f;
          // a zero-length dash still paints its round cap: keep unwritten strokes hidden
          st.p.style.visibility = f > 0 ? "visible" : "hidden";
          st.p.style.strokeDashoffset = (st.len * (1 - f)).toFixed(2);
        }
      };
      var modelLoop = function (ts) {
        var dt = Math.min(50, ts - mPrev); mPrev = ts;
        if (!visible.get(modelSvg.closest(".model"))) { mRunning = false; return; }
        if (mphase === "wait") { mHold += dt; if (mHold > 300) { mphase = "play"; mHold = 0; } }
        else if (mphase === "play") { mt += dt; renderModel(); if (mt >= mEnd) { mphase = "hold"; mHold = 0; } }
        else if (mphase === "hold") { mHold += dt; if (mHold > 5000) { mphase = "fade"; mHold = 0; } }
        else if (mphase === "fade") {
          mHold += dt;
          inkG.style.opacity = (1 - clamp(mHold / 700, 0, 1)).toFixed(3);
          if (mHold >= 700) { mt = 0; mStrokes.forEach(function (st) { st.last = -1; }); renderModel(); inkG.style.opacity = "1"; mphase = "wait"; mHold = 0; }
        }
        requestAnimationFrame(modelLoop);
      };
      var kickModel = function () { if (!mRunning) { mRunning = true; mPrev = performance.now(); requestAnimationFrame(modelLoop); } };
      if (io) {
        new IntersectionObserver(function (entries) {
          entries.forEach(function (e) { if (e.isIntersecting) kickModel(); });
        }, { threshold: 0.25 }).observe(modelSvg.closest(".model"));
      } else kickModel();
    }
  }

  /* ---------------------------------------------------------------- ribbons (page background) */

  // A braid of long soft ribbons runs down the whole page behind the content. Each one is
  // drawn by the scroll: its pen tip rides just below the fold, so scrolling down lays the
  // ribbon ahead of you and scrolling up takes it back. Where two ribbons cross they weave —
  // over, then under, then over again — by laying a short piece of the lower ribbon back on
  // top, rimmed with the page colour. Every ribbon also curls into a loop now and then.
  var ribbonHost = $(".ribbons");
  if (ribbonHost) {
    var NS = "http://www.w3.org/2000/svg";
    var R = [];                      // ribbons: {pts, cum, maxY, base:[halo,stroke], pieces:[], shown, g}
    var mouse = { x: 0, y: 0 }, cur2 = { x: 0, y: 0 };
    var loopOn = false, svgRoot = null, lastTr = "";

    // deterministic noise so the braid looks the same on every visit
    var seed = function (n) { var x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

    var SPECS = [
      { tone: 1, w: 1.0, amp: 0.36, per: 1750, ph: 0.2, amp2: 0.08, per2: 690, ph2: 1.3, depth: 1.0, loops: [0.16, 0.47, 0.8], dir: 1 },
      { tone: 2, w: 0.72, amp: 0.4, per: 2150, ph: 2.4, amp2: 0.06, per2: 820, ph2: 0.4, depth: 0.7, loops: [0.3, 0.63, 0.93], dir: -1 },
      { tone: 3, w: 0.56, amp: 0.3, per: 1400, ph: 4.1, amp2: 0.1, per2: 560, ph2: 2.2, depth: 0.5, loops: [0.08, 0.55], dir: 1 },
      { tone: 1, w: 0.42, amp: 0.44, per: 2600, ph: 5.3, amp2: 0.05, per2: 990, ph2: 3.1, depth: 0.85, loops: [0.38, 0.72], dir: -1 }
    ];

    var buildPath = function (sp, W, H, sw) {
      // parametric: t runs down the page; x swings on two sines; loops are prolate-cycloid
      // curls (the tip travels forward while circling, so it crosses itself once)
      var pts = [], step = 6, t;
      var loops = sp.loops.map(function (f) {
        var r = sw * (1.5 + seed(f * 97) * 0.9), omega = 1.9 / r;
        return { t0: f * H, len: (2 * Math.PI) / omega, r: r, omega: omega };
      });
      for (t = -sw * 3; t <= H + sw * 3; t += step) {
        var x = W * (0.5 + sp.amp * Math.sin((2 * Math.PI * t) / sp.per + sp.ph) + sp.amp2 * Math.sin((2 * Math.PI * t) / sp.per2 + sp.ph2));
        var y = t;
        for (var i = 0; i < loops.length; i++) {
          var L = loops[i];
          if (t >= L.t0 && t <= L.t0 + L.len) {
            var th = L.omega * (t - L.t0);
            y += L.r * Math.sin(th) * 1.0;
            x += L.r * (1 - Math.cos(th)) * sp.dir * -1;
          }
        }
        pts.push([x, y]);
      }
      var cum = [0], maxY = [pts[0][1]];
      for (var j = 1; j < pts.length; j++) {
        cum.push(cum[j - 1] + Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]));
        maxY.push(Math.max(maxY[j - 1], pts[j][1]));
      }
      return { pts: pts, cum: cum, maxY: maxY };
    };
    var dOf = function (pts, a, b) {
      var s = "M" + pts[a][0].toFixed(1) + " " + pts[a][1].toFixed(1);
      for (var i = a + 1; i <= b; i++) s += "L" + pts[i][0].toFixed(1) + " " + pts[i][1].toFixed(1);
      return s;
    };
    var pair = function (g, cls, d, w, extra, piece) {
      var halo = document.createElementNS(NS, "path");
      halo.setAttribute("class", "ribbon ribbon--halo" + (piece ? " ribbon--piece" : ""));
      halo.setAttribute("d", d);
      halo.setAttribute("stroke-width", (w + extra).toFixed(1));
      var stroke = document.createElementNS(NS, "path");
      stroke.setAttribute("class", "ribbon " + cls + (piece ? " ribbon--piece" : ""));
      stroke.setAttribute("d", d);
      stroke.setAttribute("stroke-width", w.toFixed(1));
      g.appendChild(halo); g.appendChild(stroke);
      return [halo, stroke];
    };
    var segHit = function (p1, p2, p3, p4) {
      var d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
      if (Math.abs(d) < 1e-9) return null;
      var u = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
      var v = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
      if (u < 0 || u > 1 || v < 0 || v > 1) return null;
      return [u, v];
    };

    var buildRibbons = function () {
      ribbonHost.style.height = "0px";
      var W = document.documentElement.clientWidth;
      var H = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      ribbonHost.style.height = H + "px";
      var sw = clamp(W * 0.05, 30, 80);
      var specs = W < 700 ? SPECS.slice(0, 3) : SPECS;
      var svgEl = document.createElementNS(NS, "svg");
      svgEl.setAttribute("viewBox", "0 0 " + W + " " + H);
      svgEl.setAttribute("preserveAspectRatio", "none");
      svgRoot = document.createElementNS(NS, "g");
      svgEl.appendChild(svgRoot);
      lastTr = "";
      var baseLayer = document.createElementNS(NS, "g");
      var topLayer = document.createElementNS(NS, "g");
      svgRoot.appendChild(baseLayer); svgRoot.appendChild(topLayer);
      var old = R;
      R = specs.map(function (sp, k) {
        var geo = buildPath(sp, W, H, sw);
        var g = document.createElementNS(NS, "g");
        baseLayer.appendChild(g);
        var w = sw * sp.w;
        var rb = { sp: sp, w: w, pts: geo.pts, cum: geo.cum, maxY: geo.maxY, g: g, pieces: [], tops: [],
                   len: geo.cum[geo.cum.length - 1], shown: old[k] ? old[k].shown : 0 };
        rb.base = pair(g, "ribbon--" + sp.tone, dOf(geo.pts, 0, geo.pts.length - 1), w, 7);
        return rb;
      });
      // weave. Every crossing in the braid — between two ribbons, and a loop over itself — is
      // found first. Then, along each pair, every other crossing flips which ribbon is on
      // top by laying a short, square-ended piece of the lower ribbon back over the upper
      // one, rimmed with the paper colour. A flip is only made where it can be clean: not at
      // a shallow angle (the piece would run long) and not where another crossing is close
      // by (the piece and its rim would cut a third ribbon). Elsewhere the plain stacking
      // order stands, which is already a tidy "over".
      var BS = 140, crossings = [];
      var bucketOf = function (P) {
        var bucket = {};
        for (var j = 0; j < P.pts.length - 1; j++) {
          var y0 = Math.min(P.pts[j][1], P.pts[j + 1][1]), y1 = Math.max(P.pts[j][1], P.pts[j + 1][1]);
          for (var q = Math.floor(y0 / BS); q <= Math.floor(y1 / BS); q++) (bucket[q] = bucket[q] || []).push(j);
        }
        return bucket;
      };
      var buckets = R.map(bucketOf);
      for (var a = 0; a < R.length; a++) {
        for (var b = a; b < R.length; b++) {
          var A = R[a], B = R[b], bk = buckets[b], seen = {};
          for (var i = 0; i < A.pts.length - 1; i++) {
            var q0 = Math.floor(Math.min(A.pts[i][1], A.pts[i + 1][1]) / BS), q1 = Math.floor(Math.max(A.pts[i][1], A.pts[i + 1][1]) / BS);
            for (var q = q0; q <= q1; q++) {
              var cand = bk[q] || [];
              for (var c = 0; c < cand.length; c++) {
                var jj = cand[c];
                if (a === b && jj <= i + 3) continue;           // a ribbon's own neighbouring segments
                var key = i + ":" + jj;
                if (seen[key]) continue;
                seen[key] = 1;
                var hit = segHit(A.pts[i], A.pts[i + 1], B.pts[jj], B.pts[jj + 1]);
                if (!hit) continue;
                var ax = A.pts[i + 1][0] - A.pts[i][0], ay = A.pts[i + 1][1] - A.pts[i][1];
                var bx = B.pts[jj + 1][0] - B.pts[jj][0], by = B.pts[jj + 1][1] - B.pts[jj][1];
                crossings.push({
                  a: a, b: b,
                  sA: A.cum[i] + hit[0] * (A.cum[i + 1] - A.cum[i]),
                  sB: B.cum[jj] + hit[1] * (B.cum[jj + 1] - B.cum[jj]),
                  x: A.pts[i][0] + ax * hit[0], y: A.pts[i][1] + ay * hit[0],
                  sin: Math.abs(ax * by - ay * bx) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1)
                });
              }
            }
          }
        }
      }
      // collapse duplicates (a crossing found twice at a segment joint)
      crossings = crossings.filter(function (c, k) {
        for (var m = 0; m < k; m++) {
          var d = crossings[m];
          if (d.a === c.a && d.b === c.b && Math.hypot(d.x - c.x, d.y - c.y) < 8) return false;
        }
        return true;
      });
      var clean = function (c, under, s, ext) {
        if (c.sin < 0.34) return false;
        for (var m = 0; m < crossings.length; m++) {
          var d = crossings[m];
          if (d === c) continue;
          if (Math.hypot(d.x - c.x, d.y - c.y) < ext + R[d.b].w + R[d.a].w * 0.5) return false;
          // another crossing along the piece's own ribbon
          if ((d.a === under && Math.abs(d.sA - s) < ext + R[under].w) || (d.b === under && Math.abs(d.sB - s) < ext + R[under].w)) return false;
        }
        return true;
      };
      var addPiece = function (under, s, ext) {
        var U = R[under], i0 = 0, i1 = U.cum.length - 1;
        while (i0 < U.cum.length - 1 && U.cum[i0] < s - ext) i0++;
        while (i1 > 0 && U.cum[i1] > s + ext) i1--;
        if (i1 <= i0) return;
        var pg = document.createElementNS(NS, "g");
        topLayer.appendChild(pg);
        var els = pair(pg, "ribbon--" + U.sp.tone, dOf(U.pts, i0, i1), U.w, 7, true);
        U.pieces.push({ g: pg, els: els, s0: U.cum[i0], len: U.cum[i1] - U.cum[i0] });
      };
      // how far a square-ended piece of U must run so that its whole width (and rim) has
      // left O before it ends: O's half-width across, plus U's half-width slanted by the angle
      var reach = function (U, O, sin) {
        var sn = Math.max(sin, 0.34), cs = Math.sqrt(1 - sn * sn);
        return Math.min(320, (O.w / 2 + 8) / sn + (U.w / 2 + 6) * cs / sn + 6);
      };
      var byPair = {};
      crossings.forEach(function (c) { (byPair[c.a + "-" + c.b] = byPair[c.a + "-" + c.b] || []).push(c); });
      Object.keys(byPair).forEach(function (key) {
        var list = byPair[key].sort(function (u, v) { return u.sA - v.sA; });
        list.forEach(function (c, n) {
          if (c.a === c.b) {
            // a loop crossing itself: the later pass goes over the earlier one
            var s2 = Math.max(c.sA, c.sB), extS = reach(R[c.a], R[c.a], c.sin);
            if (clean(c, c.a, s2, extS)) addPiece(c.a, s2, extS);
            return;
          }
          if (n % 2) return;                              // odd crossings keep the natural order
          var ext = reach(R[c.a], R[c.b], c.sin);
          if (clean(c, c.a, c.sA, ext)) addPiece(c.a, c.sA, ext);
        });
      });
      R.forEach(function (rb) {
        rb.base.forEach(function (p) { p.style.strokeDasharray = rb.len + " " + (rb.len + 20); });
        rb.pieces.forEach(function (pc) { pc.els.forEach(function (p) { p.style.strokeDasharray = pc.len + " " + (pc.len + 20); }); });
      });
      ribbonHost.innerHTML = "";
      ribbonHost.appendChild(svgEl);
      if (reduced) R.forEach(function (rb) { rb.shown = rb.len; });
      paint();
      kick();
    };

    // how much of a ribbon should be drawn: up to where it first reaches the pen line
    var targetFor = function (rb, penY) {
      var m = rb.maxY, lo = 0, hi = m.length - 1;
      if (penY >= m[hi]) return rb.len;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (m[mid] < penY) lo = mid + 1; else hi = mid; }
      return rb.cum[lo];
    };
    var paint = function () {
      for (var k = 0; k < R.length; k++) {
        var rb = R[k], s = rb.shown;
        var off = (rb.len - s).toFixed(1);
        if (off !== rb.lastOff) {
          rb.lastOff = off;
          rb.base[0].style.strokeDashoffset = off;
          rb.base[1].style.strokeDashoffset = off;
          for (var i = 0; i < rb.pieces.length; i++) {
            var pc = rb.pieces[i], o = (pc.len - clamp(s - pc.s0, 0, pc.len)).toFixed(1);
            if (o === pc.lastOff) continue;          // untouched pieces stay as they are
            pc.lastOff = o;
            pc.els[0].style.strokeDashoffset = o;
            pc.els[1].style.strokeDashoffset = o;
          }
        }
      }
    };
    var paintParallax = function () {
      if (!svgRoot) return;
      var tr = "translate(" + (cur2.x * 14).toFixed(1) + " " + (cur2.y * 10).toFixed(1) + ")";
      if (tr !== lastTr) { lastTr = tr; svgRoot.setAttribute("transform", tr); }
    };
    var tick = function () {
      var penY = window.scrollY + window.innerHeight * 0.92;
      var moving = false;
      for (var k = 0; k < R.length; k++) {
        var rb = R[k], goal = reduced ? rb.len : targetFor(rb, penY);
        var d = goal - rb.shown;
        if (Math.abs(d) > 0.5) { rb.shown += d * 0.09 + Math.sign(d) * Math.min(Math.abs(d), 1.5); moving = true; }
        else rb.shown = goal;
      }
      cur2.x += (mouse.x - cur2.x) * 0.06;
      cur2.y += (mouse.y - cur2.y) * 0.06;
      if (Math.abs(mouse.x - cur2.x) + Math.abs(mouse.y - cur2.y) > 0.002) moving = true;
      paint();
      paintParallax();
      if (moving) requestAnimationFrame(tick); else loopOn = false;
    };
    var kick = function () { if (!loopOn) { loopOn = true; requestAnimationFrame(tick); } };
    window.addEventListener("scroll", kick, { passive: true });
    if (!reduced) {
      window.addEventListener("pointermove", function (e) {
        if (e.pointerType === "touch") return;
        mouse.x = e.clientX / window.innerWidth - 0.5;
        mouse.y = e.clientY / window.innerHeight - 0.5;
        kick();
      }, { passive: true });
    }
    var rebuildT;
    var rebuildSoon = function () { clearTimeout(rebuildT); rebuildT = setTimeout(buildRibbons, 180); };
    window.addEventListener("resize", rebuildSoon);
    window.addEventListener("load", rebuildSoon);
    if ("ResizeObserver" in window) {
      var lastH = 0;
      new ResizeObserver(function () {
        var h = document.querySelector("main").offsetHeight;
        if (Math.abs(h - lastH) > 40) { lastH = h; rebuildSoon(); }
      }).observe(document.querySelector("main"));
    }
    buildRibbons();
  }

})();
