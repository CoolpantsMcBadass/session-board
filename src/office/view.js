// The office view: the hand-drawn floorplan with a ball per live session.
//
// Exported the same way canvas.js exports window.Canvas, and plugged into the
// renderer's paint() dispatcher the same way, so the poll plumbing in main.js
// and index.html does not have to know this view exists beyond one branch.
//
// This is the first view in the board that needs a JS animation loop. The
// rail's breathing dot and the map's in-flight wire are both CSS, but
// interpolating along a path that turns a corner at a doorway is not something
// a CSS transition can express. The loop is therefore scoped to this file, and
// it stops itself the moment every ball has arrived: an always-on-top panel
// should not hold a 60fps timer open to render five stationary dots.
(function () {
  // The art's own proportions. The panel is rarely this exact shape, so the
  // plan is letterboxed inside whatever room there is rather than stretched,
  // which would bend the walls the geometry was traced from.
  const PLAN_W = 1035;
  const PLAN_H = 1791;

  // The chat shares the row with the plan, and a chat squeezed to nothing is
  // worse than a slightly smaller plan, so the plan yields first.
  const CHAT_MIN_W = 200;

  // The plan width the ball size is quoted at, which is roughly what the
  // default 1000x710 window gives it. A ball is a fixed size in the room, not
  // on the screen: at the window's minimum the plan is about a quarter of this,
  // and a 27px ball there would be the size of an office.
  const BALL_REFERENCE_W = 396;

  let host = null;        // the #office container
  let floor = null;       // the fitted box the plan is actually drawn in
  let onPick = null;      // told which session's ball was clicked
  let onBin = null;       // told which session's ball was dropped on the bin
  let bin = null;         // the drop target, only shown while something is moving
  // The ball being dragged, if any. render() runs every frame off the movement
  // layer, so it has to leave this one alone or the hand and the walk would
  // fight over the same two numbers.
  let drag = null;
  let overlay = null;     // SVG showing the traced geometry, for checking it
  let layer = null;       // the balls sit in here
  let geometry = null;

  let frame = 0;          // rAF handle, 0 when the loop is stopped
  let last = 0;           // timestamp of the previous frame
  let visible = false;

  // Diameter at BALL_REFERENCE_W, tuned live by the slider. 27 is where William
  // put it: big enough to read as somebody standing there rather than a status
  // dot. Keep this and the slider's value= in index.html in step.
  let ballPx = 27;

  const els = new Map();  // sessionId -> the ball's div, reused between frames

  function init(board, opts) {
    host = document.getElementById('office');
    floor = host.querySelector('.floor');
    bin = host.querySelector('.bin');
    onPick = opts && opts.onPick;
    onBin = opts && opts.onBin;
    layer = host.querySelector('.balls');
    overlay = host.querySelector('.geo');
    geometry = window.OfficeGeometry;
    drawOverlay();
    // The plan is letterboxed, so its drawn size depends on the panel's, and
    // the panel is resizable by the user at any time.
    new ResizeObserver(fit).observe(host);
    fit();
  }

  // Largest box with the plan's aspect that fits the space available.
  //
  // Worked out from the whole view rather than measured from the box the plan
  // sits in. That box now shrinks to fit the plan, so measuring it would be
  // circular: the plan would be sized from a width that was itself the plan's.
  // Everything the plan does not get is accounted for here instead, the strip,
  // the chat's minimum, the padding and both gaps.
  function fit() {
    if (!host) return;
    const cs = getComputedStyle(host);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const gap = parseFloat(cs.columnGap) || 0;
    const ctlW = host.querySelector('.ctl').offsetWidth;
    // Clamped at zero rather than bailing out. Bailing left the plan frozen at
    // whatever size it last had, which is worse than wrong: .stage does not
    // shrink, so the chat beside it absorbed the whole deficit, the opposite of
    // the plan yielding first. At zero the plan simply disappears, which is
    // what letterboxing into no space should look like. The window's own
    // minimum width is what stops it being reachable in normal use.
    const availW = Math.max(0, host.clientWidth - padX - (gap * 2) - ctlW - CHAT_MIN_W);
    const availH = host.clientHeight - padY;
    if (availH <= 0) return;
    const scale = Math.min(availW / PLAN_W, availH / PLAN_H);
    floor.style.width = Math.floor(PLAN_W * scale) + 'px';
    floor.style.height = Math.floor(PLAN_H * scale) + 'px';
    // Ball size is derived from that width, so they are stale until redrawn.
    render();
  }

  // The traced geometry over the ink, so the two can be compared by eye. Drawn
  // in fraction space with preserveAspectRatio off, which makes the SVG agree
  // with the plan's own box no matter what size it ends up.
  function drawOverlay() {
    if (!geometry || !overlay) return;
    const bits = [];
    for (const o of geometry.offices) {
      const [x0, y0, x1, y1] = o.rect;
      bits.push(`<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}"
                   class="geo-office"/>`);
      bits.push(`<text x="${x0 + 0.012}" y="${y0 + 0.028}" class="geo-label">${o.id}</text>`);
    }
    // preserveAspectRatio is off, so one user unit across is 1035px while one
    // unit down is 1791px. A corner radius that is equal in both would come out
    // as an ellipse; ry is scaled so the stadium's ends stay round.
    const t = geometry.table.rect;
    const rx = (t[2] - t[0]) / 2;
    bits.push(`<rect x="${t[0]}" y="${t[1]}" width="${t[2] - t[0]}" height="${t[3] - t[1]}"
                 rx="${rx}" ry="${rx * (PLAN_W / PLAN_H)}" class="geo-table"/>`);
    for (const d of geometry.openings) {
      const half = d.span / 2;
      const p = d.axis === 'v'
        ? `M ${d.x} ${d.y - half} L ${d.x} ${d.y + half}`
        : `M ${d.x - half} ${d.y} L ${d.x + half} ${d.y}`;
      bits.push(`<path d="${p}" class="geo-door"/>`);
    }
    // The spine and the table places are route data, not traced geometry, but
    // they are the thing most worth eyeballing against the drawing.
    const R = window.OfficeRoutes;
    bits.push(`<path d="M ${R.SPINE_X} 0.26 L ${R.SPINE_X} 0.81" class="geo-spine"/>`);
    for (const s of R.TABLE_SLOTS) {
      bits.push(`<circle cx="${s.x}" cy="${s.y}" r="0.012" class="geo-slot"/>`);
    }
    overlay.innerHTML = bits.join('');
  }

  // Polled truth. Hand it to the movement layer, then make sure a loop is
  // running if anything now has somewhere to be.
  function update(sessions, links) {
    window.OfficeAgents.update(sessions, links);
    render();
    ensureLoop();
  }

  function render() {
    const balls = window.OfficeAgents.positions();
    const seen = new Set();
    // Scaled to however big the plan is being drawn, so a ball keeps its size
    // relative to the furniture rather than to the screen. The floor is sized
    // in fit(), so this reads whatever that last decided.
    const drawn = floor.clientWidth || BALL_REFERENCE_W;
    const px = Math.max(4, Math.round(ballPx * (drawn / BALL_REFERENCE_W)));
    for (const b of balls) {
      seen.add(b.sessionId);
      let el = els.get(b.sessionId);
      if (!el) {
        el = document.createElement('div');
        el.className = 'ball';
        el.onpointerdown = (ev) => startDrag(ev, b.sessionId, el);
        layer.appendChild(el);
        els.set(b.sessionId, el);
      }
      el.className = 'ball is-' + (b.state || 'parked');
      el.style.width = px + 'px';
      el.style.height = px + 'px';
      // A ball under the hand is positioned by the hand. Everything else keeps
      // following the movement layer, so the other four carry on walking while
      // one is being carried.
      if (!drag || drag.id !== b.sessionId) {
        el.style.left = (b.x * 100) + '%';
        el.style.top = (b.y * 100) + '%';
      }
      const tokens = typeof tokenLine === 'function' ? tokenLine(b) : '';
      el.title = `${b.title || ''} · office ${b.office}${tokens ? ' · ' + tokens : ''}`;
    }
    for (const [id, el] of els) {
      if (seen.has(id)) continue;
      el.remove();
      els.delete(id);
    }
  }

  // Is the pointer over the bin? Decided from where the pointer is rather than
  // from whether the ball overlaps the bin, because a ball is wide enough to
  // cover a corner target long before the hand reaches it. The same reasoning
  // the map's own bin was built on.
  function overBin(ev) {
    if (!bin) return false;
    const r = bin.getBoundingClientRect();
    return ev.clientX >= r.left && ev.clientX <= r.right
      && ev.clientY >= r.top && ev.clientY <= r.bottom;
  }

  function startDrag(ev, sessionId, el) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const box = floor.getBoundingClientRect();
    drag = { id: sessionId, el, moved: false, startX: ev.clientX, startY: ev.clientY };
    el.setPointerCapture(ev.pointerId);
    host.classList.add('dragging');

    el.onpointermove = (m) => {
      if (!drag) return;
      // A few pixels of slop, so a click that wobbles is still a click. Until
      // that is passed nothing moves and nothing is shown.
      if (!drag.moved && Math.hypot(m.clientX - drag.startX, m.clientY - drag.startY) < 4) return;
      drag.moved = true;
      el.style.left = (((m.clientX - box.left) / box.width) * 100) + '%';
      el.style.top = (((m.clientY - box.top) / box.height) * 100) + '%';
      const hot = overBin(m);
      bin.classList.toggle('hot', hot);
      el.classList.toggle('doomed', hot);
    };

    // A drag can end without a pointerup: the browser can take the capture away
    // on its own, and then nothing clears the state. The ball stays stuck to a
    // pointer that is no longer there, the bin stays up, and only touching that
    // same ball again recovers it. Ending the drag the same way a release does,
    // minus the drop, costs nothing and removes the worst outcome this gesture
    // has.
    const giveUp = () => {
      if (!drag) return;
      drag = null;
      host.classList.remove('dragging');
      bin.classList.remove('hot');
      el.classList.remove('doomed');
      el.onpointermove = null;
      el.onpointerup = null;
      render();
    };
    el.onpointercancel = giveUp;
    el.onlostpointercapture = () => { if (drag) giveUp(); };

    el.onpointerup = (u) => {
      const was = drag;
      drag = null;
      host.classList.remove('dragging');
      bin.classList.remove('hot');
      el.classList.remove('doomed');
      el.onpointermove = null;
      el.onpointerup = null;
      el.onpointercancel = null;
      el.onlostpointercapture = null;
      try { el.releasePointerCapture(u.pointerId); } catch { /* already gone */ }
      if (!was) return;
      // Never moved: this was a click, and a click picks the session.
      if (!was.moved) { if (onPick) onPick(sessionId); return; }
      if (overBin(u) && onBin) onBin(sessionId);
      // Dropped anywhere else, the next frame puts it back where the movement
      // layer says it belongs, which is the honest answer: a ball's place is
      // decided by what its session is doing, not by where it was left.
      render();
    };
  }

  function ensureLoop() {
    if (frame || !visible) return;
    if (!window.OfficeAgents.walking()) return;
    last = performance.now();
    frame = requestAnimationFrame(step);
  }

  function step(now) {
    frame = 0;
    // A tab that was hidden, or a machine that slept, hands back a huge delta;
    // capping it stops every ball teleporting to its destination on wake.
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    window.OfficeAgents.tick(dt);
    render();
    if (visible && window.OfficeAgents.walking()) frame = requestAnimationFrame(step);
  }

  function stopLoop() {
    if (!frame) return;
    cancelAnimationFrame(frame);
    frame = 0;
  }

  // Called by the renderer when the office view is shown or hidden. Hidden
  // means no loop at all, not a loop painting into a display:none box.
  function setVisible(on) {
    visible = !!on;
    if (!visible) { stopLoop(); return; }
    fit();
    render();
    ensureLoop();
  }

  function setBallSize(size) { ballPx = size; render(); }

  // Toggled by class, not by an inline display. The stylesheet hides .geo by
  // default, so clearing an inline style here would just fall back to that and
  // the overlay would never appear.
  function setOverlay(on) {
    host.classList.toggle('show-geo', !!on);
  }

  function setGathering(on) {
    window.OfficeAgents.setGathering(on);
    ensureLoop();
  }

  window.Office = {
    init,
    dragging: () => !!drag,
    update,
    setVisible,
    setBallSize,
    setOverlay,
    setGathering,
    setSpeed: (v) => window.OfficeAgents.setSpeed(v),
    // The map pauses repainting while a drag is in flight; the office has no
    // equivalent gesture yet, so it never asks the poll to hold off.
    busy: () => false,
  };
})();
