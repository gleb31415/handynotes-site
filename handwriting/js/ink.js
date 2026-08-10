// Pointer capture and ink rendering.
//
// The contract with the dataset (schema noto-0.1) is that nothing here is
// resampled, smoothed or thinned: every coalesced pointer sample the browser
// hands us becomes a point, exactly as reported. Rendering is a separate
// concern that reads the same array — what is drawn never feeds back into what
// is stored.
//
// A point is [x, y, t, p, altitude, azimuth]:
//   x, y     — CSS pixels inside the sheet, Y down (units of canvas_w/canvas_h)
//   t        — ms since the first point of the sample, monotonic
//   p        — raw pressure 0..1 (0 when the device reports none)
//   altitude — pen altitude in radians (0 when unavailable)
//   azimuth  — pen azimuth in radians (0 when unavailable)

/// Where the ruled lines sit, as fractions of the sheet height. The baseline
/// is what `baseline_y` reports, so it is the one number that must stay put.
const GUIDES = { ascender: 0.20, xHeight: 0.46, baseline: 0.72, descender: 0.90 };

const TAU = Math.PI * 2;

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/// Pen angles, preferring the modern spherical fields and falling back to the
/// tilt pair. Non-pen pointers report nothing, which the schema stores as 0.
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
    this.width = 0;
    this.height = 0;
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

  get baselineY() { return this.height * GUIDES.baseline; }

  get isEmpty() { return this.strokes.length === 0; }

  get pointCount() { return this.strokes.reduce((n, s) => n + s.points.length, 0); }

  /// Matches the backing store to the element's CSS box. Ink already on the
  /// sheet is rescaled with it — a writer who rotates the tablet mid-word
  /// keeps their word instead of losing it.
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (width === this.width && height === this.height && dpr === this.dpr) return;

    if (this.width > 0 && this.height > 0 && !this.isEmpty) {
      const sx = width / this.width;
      const sy = height / this.height;
      for (const stroke of this.strokes) {
        for (const point of stroke.points) {
          point[0] = round(point[0] * sx, 2);
          point[1] = round(point[1] * sy, 2);
        }
      }
    }

    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.redraw();
  }

  // MARK: Content

  clear() {
    this.strokes = [];
    this.t0 = null;
    this.lastT = 0;
    this.pointerTypes.clear();
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
    this.redraw();
    this.onChange();
  }

  /// Reinstates a checkpointed draft. Times stay as recorded: the pause while
  /// the page was gone is not part of the writing, and a restored word simply
  /// continues from the last recorded offset.
  restore(draft) {
    if (!draft || !Array.isArray(draft.strokes)) return;
    this.strokes = draft.strokes.map((s) => ({ points: s.points.map((p) => p.slice()) }));
    this.pointerTypes = new Set(draft.pointer_types ?? []);
    this.penSeen = this.pointerTypes.has('pen');
    this.lastT = draft.last_t ?? 0;
    // A restored sample has no live clock yet; the next point re-anchors it
    // just after the last one, so `t` stays monotonic within the word.
    this.t0 = null;
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
      canvas_w: this.width,
      canvas_h: this.height,
      dpr: this.dpr,
      baseline_y: round(this.baselineY, 2),
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
      canvas_w: this.width,
      canvas_h: this.height,
    };
  }

  // MARK: Drawing

  redraw() {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    this._drawGuides();
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
  /// new segment instead of the whole path on every pointer event.
  _drawStroke(stroke, fromIndex) {
    const { ctx } = this;
    const points = stroke.points;
    if (points.length === 0) return;

    ctx.save();
    ctx.strokeStyle = '#12203a';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (points.length === 1) {
      const [x, y, , p] = points[0];
      ctx.fillStyle = '#12203a';
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
    return [
      round(event.clientX - rect.left, 2),
      round(event.clientY - rect.top, 2),
      offset,
      round(event.pressure ?? 0, 3),
      round(altitude, 4),
      round(azimuth, 4),
    ];
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

    const rect = this.canvas.getBoundingClientRect();
    this.pointerTypes.add(event.pointerType || 'mouse');
    const stroke = { points: [this._pointFrom(event, rect)] };
    this.strokes.push(stroke);
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

    // Coalesced events are the whole reason a 240 Hz pencil is worth capturing
    // in a browser: without them the trajectory is decimated to frame rate.
    const batch = typeof event.getCoalescedEvents === 'function'
      ? event.getCoalescedEvents()
      : [];
    const events = batch.length > 0 ? batch : [event];
    for (const sample of events) stroke.points.push(this._pointFrom(sample, rect));

    this._drawStroke(stroke, start);
  }

  _up(event) {
    if (event.pointerId !== this.activePointerID) return;
    if (event.cancelable) event.preventDefault();
    try { this.canvas.releasePointerCapture(event.pointerId); } catch { /* already gone */ }
    this.activePointerID = null;

    const stroke = this.strokes[this.strokes.length - 1];
    // A stray tap that produced a single point is still a dot the writer made
    // (the dot of an "й", a comma), so it is kept.
    if (stroke && stroke.points.length === 0) this.strokes.pop();
    this.onChange();
  }
}
