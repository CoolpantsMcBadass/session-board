// The moving part of the office view: who is in the building, which room is
// theirs, and where each ball is between one poll and the next.
//
// Nothing here touches the DOM. It takes sessions and links in and gives
// positions out, so the walking can be reasoned about (and tested) as plain
// data, the same way canvas.js keeps nodeSet() and binRect() apart from paint.
//
// The split that matters: update() is for polled truth and only ever runs when
// something actually changed, while tick() is the clock and runs every frame.
// The board sends a snapshot when the session list changes and a bare tick when
// only the clock moved; if a ball re-planned its route on every tick it would
// restart its walk twice a second and never arrive anywhere.
(function () {
  const R = () => window.OfficeRoutes;

  // The floorplan is taller than it is wide, so a step of 0.01 across is a much
  // shorter distance than a step of 0.01 down. Lengths are measured with x
  // scaled into the same units as y, otherwise a ball visibly speeds up when it
  // turns a corner.
  const ASPECT = 1035 / 1791;

  // Must stay equal to TABLE_SLOTS.length. That equality is what makes seat
  // collisions impossible: five rooms caps the board at five balls, and two
  // separate groups of three would need six, so two groups can never be at the
  // table at once. There is no slot registry doing that work. Change one of
  // these without the other and the guarantee goes away silently.
  const MAX_OFFICES = 5;

  // Three or more sessions talking in one group go to the table instead of
  // crowding into somebody's office. Two is a visit.
  const GROUP_SIZE = 3;

  // Fractions of the floorplan height per second: at 0.27 a ball crosses the
  // whole plan in under four seconds. 0.16 was the first guess and read as a
  // trudge. Keep this and the slider's value= in index.html in step.
  let speed = 0.27;

  // sessionId -> ball. Kept across polls: a ball that is mid-walk must not be
  // rebuilt from scratch just because another snapshot arrived.
  //
  // `place` is where the ball is going, and where it is once parked: a route
  // place name such as 'desk:3', 'visit:2' or 'slot:0'. A ball with
  // path === null has arrived and is standing there.
  const balls = new Map();
  // office number -> sessionId, so a room stays claimed until its session goes.
  const rooms = new Map();

  // Manual override from the panel's button: send everyone to the table
  // regardless of who is actually talking. Useful for looking at the layout.
  let gathering = false;

  function claimRoom(sessionId) {
    for (const [office, owner] of rooms) if (owner === sessionId) return office;
    for (let office = 1; office <= MAX_OFFICES; office++) {
      if (!rooms.has(office)) { rooms.set(office, sessionId); return office; }
    }
    return null;   // more sessions than offices; the extras are not drawn
  }

  function releaseRoom(sessionId) {
    for (const [office, owner] of rooms) if (owner === sessionId) rooms.delete(office);
  }

  // Group everyone who is talking, directly or through somebody else, into one
  // conversation. A relays to B and B to C makes one group of three, which is
  // the case that sends them to the table rather than into a room.
  function clustersOf(links) {
    const adj = new Map();
    const touch = (id) => { if (!adj.has(id)) adj.set(id, new Set()); return adj.get(id); };
    for (const l of links) {
      // A link to a session with no ball (closed, or beyond the fifth office)
      // is not something anyone can walk to. A session linked to itself would
      // be sent to visit its own office; the collector already drops those,
      // but this layer should not depend on that to stay coherent.
      if (l.a === l.b) continue;
      if (!balls.has(l.a) || !balls.has(l.b)) continue;
      touch(l.a).add(l.b);
      touch(l.b).add(l.a);
    }
    const seen = new Set();
    const out = [];
    for (const id of adj.keys()) {
      if (seen.has(id)) continue;
      const group = [];
      const stack = [id];
      seen.add(id);
      while (stack.length) {
        const cur = stack.pop();
        group.push(cur);
        for (const next of adj.get(cur)) {
          if (seen.has(next)) continue;
          seen.add(next);
          stack.push(next);
        }
      }
      out.push(group.sort());
    }
    return out;
  }

  // Where this session's ball belongs right now.
  function placeFor(sessionId, ball, clusters, links) {
    if (gathering) return 'slot:' + ((ball.office - 1) % R().TABLE_SLOTS.length);

    const group = clusters.find((g) => g.includes(sessionId));
    if (!group) return 'desk:' + ball.office;

    if (group.length >= GROUP_SIZE) {
      // Seats are handed out by sorted session id, so the same session keeps
      // the same chair for the life of a conversation instead of swapping
      // places every time somebody new joins.
      return 'slot:' + (group.indexOf(sessionId) % R().TABLE_SLOTS.length);
    }

    // A pair. The one who spoke most recently is the one who gets up and walks
    // over; the other stays at its desk and is visited.
    const newest = links
      .filter((l) => group.includes(l.a) && group.includes(l.b))
      .sort((p, q) => q.at - p.at)[0];
    if (!newest) return 'desk:' + ball.office;
    if (newest.a !== sessionId) return 'desk:' + ball.office;
    const host = balls.get(newest.b);
    return host ? 'visit:' + host.office : 'desk:' + ball.office;
  }

  // Send a ball somewhere new, from wherever it currently is. A ball standing
  // still gets a plain route; one already walking gets re-routed off the path
  // it is on, which is the only way to keep it on real corridors instead of
  // drawing a fresh diagonal from wherever it happens to be standing.
  function reaim(ball, place) {
    if (ball.place === place) return;
    ball.path = ball.path
      ? R().rerouteFrom(ball.path, ball.leg, ball.pos, place)
      : R().route(ball.place, place);
    // A parked ball's route starts at the place it is standing, so this is a
    // no-op for it, and for a walking one it is already the first point.
    ball.path[0] = { ...ball.pos };
    ball.place = place;
    ball.leg = 0;
    ball.legT = 0;
  }

  // Polled truth arrived. Drop departures, add arrivals, re-aim the rest.
  // Positions are left exactly where they are.
  function update(sessions, links) {
    const live = (sessions || []).filter((s) => s.state !== 'closed');
    const alive = new Set(live.map((s) => s.sessionId));

    // Departures are handled first on purpose. When one session closes and
    // another opens in the same poll, claiming before releasing would find
    // every room still taken and leave the newcomer without one until the
    // next poll two seconds later.
    for (const id of [...balls.keys()]) {
      if (alive.has(id)) continue;
      balls.delete(id);
      releaseRoom(id);
    }

    for (const s of live) {
      if (balls.has(s.sessionId)) continue;
      const office = claimRoom(s.sessionId);
      if (office === null) continue;
      // A ball appears at its own desk rather than walking in from the door,
      // because the session was already running before we looked.
      balls.set(s.sessionId, {
        office,
        pos: { ...R().deskOf(office) },
        path: null,
        leg: 0,
        legT: 0,
        place: 'desk:' + office,
      });
    }

    // Clusters are computed once per poll, after the ball set is settled, so
    // placeFor can trust that everyone it names has somewhere to stand.
    const active = (links || []).filter((l) => balls.has(l.a) && balls.has(l.b));
    const clusters = clustersOf(active);

    for (const s of live) {
      const ball = balls.get(s.sessionId);
      if (!ball) continue;
      ball.state = s.state;
      ball.title = s.title;
      reaim(ball, placeFor(s.sessionId, ball, clusters, active));
    }
  }

  function legLength(a, b) {
    return Math.hypot((b.x - a.x) * ASPECT, b.y - a.y);
  }

  // Advance every ball along its path by however long since the last frame.
  function tick(dt) {
    for (const ball of balls.values()) {
      if (!ball.path) continue;
      let remaining = speed * dt;
      while (remaining > 0 && ball.leg < ball.path.length - 1) {
        const from = ball.path[ball.leg];
        const to = ball.path[ball.leg + 1];
        const len = legLength(from, to);
        if (len < 1e-9) { ball.leg++; ball.legT = 0; continue; }
        const step = remaining / len;
        if (ball.legT + step >= 1) {
          remaining -= (1 - ball.legT) * len;
          ball.leg++;
          ball.legT = 0;
          ball.pos = { ...to };
        } else {
          ball.legT += step;
          remaining = 0;
          ball.pos = {
            x: from.x + (to.x - from.x) * ball.legT,
            y: from.y + (to.y - from.y) * ball.legT,
          };
        }
      }
      // Arrived. Parking it stops the loop walking a finished path for ever,
      // and tells reaim() to route from here rather than re-route.
      if (ball.leg >= ball.path.length - 1) ball.path = null;
    }
  }

  function walking() {
    for (const ball of balls.values()) if (ball.path) return true;
    return false;
  }

  function positions() {
    return [...balls.entries()].map(([sessionId, b]) => ({
      sessionId,
      office: b.office,
      state: b.state,
      title: b.title,
      place: b.place,
      x: b.pos.x,
      y: b.pos.y,
    }));
  }

  function setGathering(on) {
    if (gathering === !!on) return;
    gathering = !!on;
    // Destinations are recomputed on the next poll anyway, but the button
    // should do something the moment it is pressed rather than up to two
    // seconds later.
    for (const [id, ball] of balls) {
      reaim(ball, gathering
        ? 'slot:' + ((ball.office - 1) % R().TABLE_SLOTS.length)
        : 'desk:' + ball.office);
    }
  }

  window.OfficeAgents = {
    update,
    tick,
    positions,
    walking,
    setGathering,
    isGathering: () => gathering,
    setSpeed: (v) => { speed = v; },
    // count and reset are here for the test harnesses, which drive this module
    // in plain node with a stubbed window. Nothing in the app calls them, and
    // that is the point: the alternative is tests that can only run the whole
    // Electron app to ask how many balls there are.
    count: () => balls.size,
    reset: () => { balls.clear(); rooms.clear(); gathering = false; },
  };
})();
