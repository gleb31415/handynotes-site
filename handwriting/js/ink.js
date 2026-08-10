// Pointer capture and ink rendering.
//
// The contract with the dataset (schema noto-0.1) is that nothing here is
// resampled, smoothed or thinned: every coalesced pointer sample the browser
// hands us becomes a point, exactly as reported. Rendering is a separate
// concern that reads the same array — what is drawn never feeds back into what
// is stored.
//
// The semantics deliberately mirror HandwritingPromptCanvas.swift, so a word
// written in a browser and the same word written on the iPad differ only in
// what the two devices actually reported:
//
//   * a sample's coordinate space is frozen at its FIRST point (`captureSize`)
//     and is what canvas_w/h and baseline_y describe. A box that changes size
//     mid-word — a rotated tablet, an on-screen keyboard — moves the drawing
//     through a display-only similarity transform and never rewrites a
//     recorded coordinate;
//   * coalesced events are recorded on move AND on pen lift, so the end of a
//     fast stroke is not truncated;
//   * angles are recorded for a pen and left at 0 for anything else.
//
// A point is [x, y, t, p, altitude, azimuth]:
//   x, y     — CSS pixels in capture space, Y down (units of canvas_w/canvas_h)
//   t        — ms since the first point of the sample, monotonic
//   p        — raw pressure 0..1 (0 when the device reports none)
//   altitude — pen altitude in radians (0 when unavailable)
//   azimuth  — pen azimuth in radians (0 when unavailable)

/// Where the ruled lines sit, as fractions of the sheet height. The baseline
/// is what `baseline_y` reports, so it is the one number that must stay put.
const GUIDES = { ascender: 0.20, xHeight: 0.46, baseline: 0.72, descender: 0.90 };

/// Breathing room kept between shrunk-to-fit ink and the edge of the sheet.
const FIT_MARGIN = 8;

const TAU = Math.PI * 2;

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/// Pen angles, preferring the modern spherical fields and falling back to the
/// tilt pair. Non-pen pointers report nothing, which the schema stores as 0 —
/// the same rule as `touch.type == .pencil` on iOS.
function anglesFor(event) {
  if (event.pointerType !== 'pen') return [0, 0];
  if (typeof event.altitudeAngle === 'number' && typeof event.azimuthAngle === 'number') {
    return [event.altitudeAngle, event.azimuthAngle];
  }
  const tiltX = ((event.tiltX ?? 0) * Math.PI) / 180;
  const tiltY = ((event.tiltY ?? 0) * Math.PI) / 180;
  if (tiltX === 0 && tiltY === 0) return [Math.PI / 2, 0];
  const tanX = Math.tan(tiltX);
  const tanY = Math.tan(tiltY);
  let azimuth = Math.atan2(tanY, tanX);
  if (azimuth < 0) azimuth += TAU;
  const altitude = Math.atan(1 / Math.hypot(tanX, tanY));
  return [altitude, azimuth];
}

export class InkSheet {
  /// `canvas` is the sheet; `onChange` fires whenever the stroke list changes,
  /// which is what drives the draft checkpoint and the button states.
  constructor(canvas, { onChange = () => {}, onTouchRejected = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange;
    this.onTouchRejected = onTouchRejected;

    this.strokes = [];
    /// Current CSS size of the sheet.
    this.width = 0;
    this.height = 0;
    /// The size the current sample STARTED in — the space its points live in.
    this.captureWidth = 0;
    this.captureHeight = 0;
    /// Capture space → current bounds. Display only; never magnifies.
    this.display = { scale: 1, tx: 0, ty: 0 };
    this.dpr = 1;
    /// Set at the sample's first point and held until the sheet is cleared, so
    /// every point of one word shares a single time origin.
    this.t0 = null;
    this.lastT = 0;
    /// pen > touch > mouse, decided by what actually produced the ink.
    this.pointerTypes = new Set();
    this.activePointerID = null;
    /// Once a real pen has written on this sheet, touches are palm contact.
    this.penSeen = false;
    this.enabled = true;

    this._bind();
  }

  // MARK: Geometry

  /// Baseline in the given height — used both for the drawn guide (current
  /// bounds) and for the reported `baseline_y` (capture space).
  static baselineIn(height) { return height * GUIDES.baseline; }

  get isEmpty() { return this.strokes.length === 0; }

  get pointCount() { return this.strokes.reduce((n, s) => n + s.points.length, 0); }

  /// Points per second over the word so far — the honest, per-device answer to
  /// "how densely does this browser sample the pen".
  get sampleRate() {
    if (this.lastT <= 0) return 0;
    return Math.round((this.pointCount / this.lastT) * 1000);
  }

  /// Matches the backing store to the element's CSS box. Recorded points are
  /// never touched: only the display transform is recomputed.
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    // The backing store is capped — a 4× buffer costs memory and buys nothing
    // on a sheet this size — but `dpr` reports what the device actually is,
    // which is what the schema asks for.
    const dpr = window.devicePixelRatio || 1;
    const backing = Math.min(dpr, 3);
    if (width === this.width && height === this.height && dpr === this.dpr) return;

    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * backing);
    this.canvas.height = Math.round(height * backing);
    if (this.isEmpty) {
      this.captureWidth = width;
      this.captureHeight = height;
      this.display = { scale: 1, tx: 0, ty: 0 };
    } else {
      this._refreshDisplay();
    }
    this.redraw();
  }

  /// Display only. Never magnifies, so growing the sheet leaves existing ink at
  /// its physical size and continuing a word is seamless; a smaller sheet
  /// shrinks it just enough to keep every recorded point visible. One uniform
  /// scale plus a vertical shift that keeps the ink sitting on the guide — a
  /// similarity, so a resize can never change the shape of what was written.
  _refreshDisplay() {
    const box = this._inkBounds();
    if (!box || this.captureWidth <= 0 || this.captureHeight <= 0 || this.width <= 0) {
      this.display = { scale: 1, tx: 0, ty: 0 };
      return;
    }
    const from = InkSheet.baselineIn(this.captureHeight);
    const to = InkSheet.baselineIn(this.height);
    let scale = 1;
    if (box.minY < from) scale = Math.min(scale, Math.max(to - FIT_MARGIN, 1) / (from - box.minY));
    if (box.maxY > from) scale = Math.min(scale, Math.max(this.height - to - FIT_MARGIN, 1) / (box.maxY - from));
    if (box.maxX > 0) scale = Math.min(scale, Math.max(this.width - FIT_MARGIN, 1) / box.maxX);
    if (!Number.isFinite(scale) || scale <= 0) {
      this.display = { scale: 1, tx: 0, ty: 0 };
      return;
    }
    // Left-anchored in x (writing runs left to right), baseline-anchored in y.
    this.display = { scale, tx: 0, ty: to - from * scale };
  }

  _inkBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const stroke of this.strokes) {
      for (const p of stroke.points) {
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
      }
    }
    return minX <= maxX ? { minX, minY, maxX, maxY } : null;
  }

  // MARK: Content

  clear() {
    this.strokes = [];
    this.t0 = null;
    this.lastT = 0;
    this.pointerTypes.clear();
    this.captureWidth = this.width;
    this.captureHeight = this.height;
    this.display = { scale: 1, tx: 0, ty: 0 };
    this.redraw();
    this.onChange();
  }

  undo() {
    if (this.isEmpty) return;
    this.strokes.pop();
    if (this.isEmpty) {
      this.t0 = null;
      this.lastT = 0;
    }
    this._refreshDisplay();
    this.redraw();
    this.onChange();
  }

  /// Reinstates a checkpointed draft, including the space it was recorded in.
  /// Times stay as recorded: the pause while the page was gone is not part of
  /// the writing, and a restored word continues from the last offset.
  restore(draft) {
    if (!draft || !Array.isArray(draft.strokes)) return;
    this.strokes = draft.strokes.map((s) => ({ points: s.points.map((p) => p.slice()) }));
    this.pointerTypes = new Set(draft.pointer_types ?? []);
    this.penSeen = this.pointerTypes.has('pen');
    this.lastT = draft.last_t ?? 0;
    this.captureWidth = draft.canvas_w > 0 ? draft.canvas_w : this.width;
    this.captureHeight = draft.canvas_h > 0 ? draft.canvas_h : this.height;
    this.t0 = null;
    this._refreshDisplay();
    this.redraw();
    this.onChange();
  }

  /// Everything the sample needs from the sheet, ready to be merged with the
  /// task fields. Returns null when nothing was written.
  capture() {
    if (this.isEmpty) return null;
    const pointerType = this.pointerTypes.has('pen')
      ? 'pen'
      : this.pointerTypes.has('touch') ? 'touch' : 'mouse';
    return {
      strokes: this.strokes.map((s) => ({ points: s.points.map((p) => p.slice()) })),
      pointer_type: pointerType,
      canvas_w: this.captureWidth,
      canvas_h: this.captureHeight,
      dpr: this.dpr,
      baseline_y: round(InkSheet.baselineIn(this.captureHeight), 2),
      duration_ms: Math.round(this.lastT),
    };
  }

  /// The shape checkpointed between saves — the capture plus what it takes to
  /// resume writing the same word after a reload.
  draftState() {
    if (this.isEmpty) return null;
    return {
      strokes: this.strokes,
      pointer_types: [...this.pointerTypes],
      last_t: this.lastT,
      canvas_w: this.captureWidth,
      canvas_h: this.captureHeight,
    };
  }

  // MARK: Drawing

  /// Sets the canvas transform to capture space: device pixels ← CSS pixels ←
  /// the display similarity. Ink is drawn through it; guides are not.
  _inkTransform() {
    const backing = Math.min(this.dpr, 3);
    const { scale, tx, ty } = this.display;
    this.ctx.setTransform(backing * scale, 0, 0, backing * scale, backing * tx, backing * ty);
  }

  redraw() {
    const { ctx } = this;
    const backing = Math.min(this.dpr, 3);
    ctx.setTransform(backing, 0, 0, backing, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    this._drawGuides();
    this._inkTransform();
    for (const stroke of this.strokes) this._drawStroke(stroke, 0);
  }

  _drawGuides() {
    const { ctx, width, height } = this;
    const line = (y, color, dash, lineWidth) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(12, Math.round(y) + 0.5);
      ctx.lineTo(width - 12, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.restore();
    };
    line(height * GUIDES.ascender, 'rgba(20, 30, 60, 0.10)', [4, 6], 1);
    line(height * GUIDES.xHeight, 'rgba(20, 30, 60, 0.10)', [4, 6], 1);
    line(height * GUIDES.baseline, 'rgba(30, 60, 130, 0.34)', [], 1.4);
    line(height * GUIDES.descender, 'rgba(20, 30, 60, 0.08)', [4, 6], 1);
  }

  /// Draws a stroke from `fromIndex`, so a live stroke only ever paints its
  /// new segment instead of the whole path on every pointer event. The caller
  /// must have put the context in capture space.
  _drawStroke(stroke, fromIndex) {
    const { ctx } = this;
    const points = stroke.points;
    if (points.length === 0) return;

    ctx.save();
    ctx.strokeStyle = '#12203a';
    ctx.fillStyle = '#12203a';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (points.length === 1) {
      const [x, y, , p] = points[0];
      ctx.beginPath();
      ctx.arc(x, y, this._widthFor(p) / 2, 0, TAU);
      ctx.fill();
      ctx.restore();
      return;
    }

    for (let i = Math.max(1, fromIndex); i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      ctx.lineWidth = (this._widthFor(a[3]) + this._widthFor(b[3])) / 2;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    ctx.restore();
  }

  _widthFor(pressure) {
    const p = pressure > 0 ? pressure : 0.5;
    return 1.6 + 2.6 * Math.min(1, p);
  }

  // MARK: Pointer plumbing

  _bind() {
    const canvas = this.canvas;
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', (e) => this._up(e));
    // Safari still fires these on a canvas with touch-action: none when the
    // gesture starts near a screen edge; swallowing them keeps the page from
    // scrolling out from under the sheet.
    for (const name of ['touchstart', 'touchmove', 'touchend']) {
      canvas.addEventListener(name, (e) => {
        if (e.cancelable) e.preventDefault();
      }, { passive: false });
    }
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /// True when this pointer is palm contact next to a working pen.
  _isPalm(event) {
    return this.penSeen && event.pointerType === 'touch';
  }

  _timeFor(event) {
    // Event timestamps share the performance timeline in every current
    // browser, which is what makes coalesced timings meaningful. When they
    // don't (or when a restored draft re-anchors the clock), fall back to
    // reading the clock now.
    const now = performance.now();
    const stamp = typeof event.timeStamp === 'number' ? event.timeStamp : now;
    return Math.abs(stamp - now) < 5000 ? stamp : now;
  }

  /// Client coordinates → capture space, through the inverse of the display
  /// transform, so what is stored is always in the space the sample started in.
  _pointFrom(event, rect) {
    const t = this._timeFor(event);
    if (this.t0 === null) {
      // First point of the sample — or the first after a restore, which
      // continues just past the last recorded offset instead of at zero.
      this.t0 = t - (this.lastT > 0 ? this.lastT + 1 : 0);
    }
    const offset = Math.max(0, Math.round(t - this.t0));
    this.lastT = Math.max(this.lastT, offset);
    const [altitude, azimuth] = anglesFor(event);
    const { scale, tx, ty } = this.display;
    return [
      round((event.clientX - rect.left - tx) / scale, 2),
      round((event.clientY - rect.top - ty) / scale, 2),
      offset,
      round(event.pressure ?? 0, 3),
      round(altitude, 4),
      round(azimuth, 4),
    ];
  }

  /// Every coalesced sample of this event, or the event itself when the
  /// browser has nothing finer. Without this a 240 Hz pencil is decimated to
  /// the frame rate.
  _samplesOf(event) {
    const batch = typeof event.getCoalescedEvents === 'function'
      ? event.getCoalescedEvents()
      : [];
    return batch.length > 0 ? batch : [event];
  }

  _down(event) {
    if (!this.enabled) return;
    if (event.pointerType === 'pen') this.penSeen = true;
    if (this._isPalm(event)) {
      // Silently swallowing touches on a sheet a pen has written on looks
      // like a broken canvas, so say it out loud — once.
      this.onTouchRejected();
      return;
    }
    // One stroke at a time: a second finger is not a second pen.
    if (this.activePointerID !== null) return;
    if (event.button > 0) return;

    if (event.cancelable) event.preventDefault();
    this.activePointerID = event.pointerId;
    try { this.canvas.setPointerCapture(event.pointerId); } catch { /* not fatal */ }

    if (this.isEmpty) {
      // First point of a sample: it is recorded in THIS box, 1:1.
      this.captureWidth = this.width;
      this.captureHeight = this.height;
      this.display = { scale: 1, tx: 0, ty: 0 };
    }

    const rect = this.canvas.getBoundingClientRect();
    this.pointerTypes.add(event.pointerType || 'mouse');
    const stroke = { points: [this._pointFrom(event, rect)] };
    this.strokes.push(stroke);
    this._inkTransform();
    this._drawStroke(stroke, 0);
    this.onChange();
  }

  _move(event) {
    if (event.pointerId !== this.activePointerID) return;
    if (event.cancelable) event.preventDefault();

    const rect = this.canvas.getBoundingClientRect();
    const stroke = this.strokes[this.strokes.length - 1];
    if (!stroke) return;
    const start = stroke.points.length;

    for (const sample of this._samplesOf(event)) {
      stroke.points.push(this._pointFrom(event === sample ? event : sample, rect));
    }

    this._inkTransform();
    this._drawStroke(stroke, start);
  }

  _up(event) {
    if (event.pointerId !== this.activePointerID) return;
    if (event.cancelable) event.preventDefault();
    try { this.canvas.releasePointerCapture(event.pointerId); } catch { /* already gone */ }
    this.activePointerID = null;

    const stroke = this.strokes[this.strokes.length - 1];
    if (stroke && event.type === 'pointerup') {
      // The lift carries the last samples of the stroke; dropping them cuts
      // the tail off every fast movement. iOS records them the same way.
      const rect = this.canvas.getBoundingClientRect();
      const start = stroke.points.length;
      for (const sample of this._samplesOf(event)) {
        stroke.points.push(this._pointFrom(event === sample ? event : sample, rect));
      }
      this._inkTransform();
      this._drawStroke(stroke, start);
    }
    if (stroke && stroke.points.length === 0) this.strokes.pop();
    this.onChange();
  }
}
