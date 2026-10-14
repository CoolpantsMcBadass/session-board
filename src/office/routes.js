// Where a ball may stand, and how it gets from one of those places to another.
//
// Every coordinate here is a fraction of the floorplan box, the same space
// geometry.js uses, so nothing in this file changes when the panel is
// resized. The view multiplies by the drawn width and height at paint time.
//
// There is no pathfinder. Four of the five doorways sit on one vertical line
// (the corridor at x = 0.6329), which makes the walkable topology a spine with
// a stub for each office, and office 1 the only one joining at a right angle.
// A* over a grid would compute, every time, the one route that was already
// obvious from the drawing. So the route is assembled from named points
// instead: desk, doorway, the corridor just outside it, then the spine.
(function () {
  // The corridor runs just inside the doorway line. Balls walk along SPINE_X
  // rather than along the doorways themselves, so a ball passing office 3 does
  // not clip the door frame it is walking past.
  const SPINE_X = 0.60;

  // Where a ball waits when its session is working alone. Roughly at the desk
  // in each room rather than dead centre, so a ball does not sit on a wall.
  const DESK = {
    1: { x: 0.280, y: 0.130 },
    2: { x: 0.800, y: 0.120 },
    3: { x: 0.820, y: 0.390 },
    4: { x: 0.820, y: 0.600 },
    5: { x: 0.820, y: 0.800 },
  };

  // The doorway each office opens through, read straight off the traced
  // geometry. Restating the coordinates here once meant two places to edit
  // when a door moved, and they had already drifted apart once.
  const DOOR = {};
  for (const d of window.OfficeGeometry.openings) {
    DOOR[d.office] = { x: d.x, y: d.y, axis: d.axis };
  }

  // The point on the spine a ball reaches once it is through its door. A
  // sideways door opens straight onto the spine, so the join is the door's own
  // height. Office 1 opens downward instead, so it needs a step clear of the
  // doorway and then a leg across to the spine.
  const DOORWAY_CLEARANCE = 0.043;
  const JOIN = {};
  for (const [office, d] of Object.entries(DOOR)) {
    JOIN[office] = d.axis === 'v'
      ? [{ x: SPINE_X, y: d.y }]
      : [{ x: d.x, y: d.y + DOORWAY_CLEARANCE }, { x: SPINE_X, y: d.y + DOORWAY_CLEARANCE }];
  }

  // Five places to stand around the table, so a group meeting does not stack
  // every ball on one pixel. Set just outside the edge of the table as drawn,
  // one at the head and two down each side. The offsets differ between x and y
  // because the plan is much taller than it is wide, and an equal fraction in
  // each direction would not be an equal distance.
  const TABLE_SLOTS = [
    { x: 0.3130, y: 0.4434 },
    { x: 0.1400, y: 0.5600 },
    { x: 0.4860, y: 0.5600 },
    { x: 0.1400, y: 0.6800 },
    { x: 0.4860, y: 0.6800 },
  ];

  // The one point that connects the spine to the open floor where the table is.
  const FLOOR_JOIN = { x: SPINE_X, y: 0.620 };

  // Where a visitor stands when it has walked into somebody else's office:
  // beside the desk on the door side, so the two balls read as two people in
  // one room rather than one ball sitting on top of another.
  const VISIT = {
    1: { x: 0.360, y: 0.175 },
    2: { x: 0.720, y: 0.165 },
    3: { x: 0.730, y: 0.420 },
    4: { x: 0.730, y: 0.630 },
    5: { x: 0.730, y: 0.825 },
  };

  // A place a ball can stand, named so a destination can be compared cheaply
  // and a route built between any two of them: 'desk:3', 'visit:3', 'slot:0'.
  //
  // Every place hangs off the spine, so a route is always the same three
  // pieces: out of wherever you are to the spine, along the spine, then in to
  // wherever you are going. Nothing searches, because on a line there is only
  // one way to go.
  function legsTo(place) {
    const [kind, idx] = place.split(':');
    if (kind === 'slot') {
      return { points: [tableSlot(Number(idx)), FLOOR_JOIN], y: FLOOR_JOIN.y };
    }
    const office = Number(idx);
    const anchor = kind === 'visit' ? VISIT[office] : DESK[office];
    const points = [anchor, DOOR[office], ...JOIN[office]];
    return { points, y: points[points.length - 1].y };
  }

  // Callers are expected to have already decided the ball is going somewhere
  // else; reaim() returns early when it is not. There is deliberately no
  // same-place branch here, because a silent one reads like a case that
  // happens.
  function route(from, to) {
    const a = legsTo(from);
    const b = legsTo(to);
    return dedupe([
      ...a.points,
      { x: SPINE_X, y: a.y },
      { x: SPINE_X, y: b.y },
      ...b.points.slice().reverse(),
    ]);
  }

  // Re-route a ball that is already walking, rather than one standing still.
  //
  // Replacing the first point of a fresh route is only honest while the ball is
  // still inside the sub-path that route begins with. Once it has walked past
  // that, the first leg became a straight line back to a door it had already
  // left, cutting across the floorplan through walls.
  //
  // Everything funnels through the spine, so getting back to it is the only
  // question, and the path the ball is on already answers it: the spine stretch
  // is exactly the run of points at x = SPINE_X, and the ball is short of it,
  // on it, or past it into a room. Each case walks real segments, never a
  // diagonal of its own invention. This also covers being sent back where it
  // came from, which is why that needs no case of its own.
  function rerouteFrom(path, leg, pos, toPlace) {
    const to = legsTo(toPlace);
    const tail = [{ x: SPINE_X, y: to.y }, ...to.points.slice().reverse()];
    const onSpine = path.map((p) => Math.abs(p.x - SPINE_X) < 1e-9);
    const first = onSpine.indexOf(true);
    const last = onSpine.lastIndexOf(true);

    // Cannot happen: every path is built by route() or by this function, and
    // both always contain at least one literal { x: SPINE_X }, through a
    // doorway's JOIN or through FLOOR_JOIN. Kept as an assertion rather than
    // deleted, because without it the slice arithmetic below would quietly
    // produce a wrong path instead of an obvious one. Loud, so that if the
    // routing graph ever stops being a spine we hear about it.
    if (first === -1) {
      console.error('office: re-routing a path with no point on the spine', path);
      return dedupe([{ ...pos }, ...tail]);
    }
    // Still on the way out: carry on to the spine, then turn.
    if (leg < first) return dedupe([{ ...pos }, ...path.slice(leg + 1, first + 1), ...tail]);
    // Already off the spine and into a room: retrace back out of it.
    if (leg > last) return dedupe([{ ...pos }, ...path.slice(last, leg + 1).reverse(), ...tail]);
    // On the spine, which is where a turn costs nothing.
    return dedupe([{ ...pos }, ...tail]);
  }

  function deskOf(office) { return DESK[office]; }
  function tableSlot(i) { return TABLE_SLOTS[i % TABLE_SLOTS.length]; }

  // Two consecutive points at the same spot make the walker stall for a frame
  // with a zero-length leg, so they are dropped as the path is assembled.
  function dedupe(points) {
    const out = [];
    for (const p of points) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue;
      out.push(p);
    }
    return out;
  }

  // Only what something outside this file actually calls. DESK, DOOR, VISIT,
  // legsTo and tableSlot are how the routes are built, not how they are used,
  // and exporting them invited a second caller to reach past route() and
  // assemble its own path.
  window.OfficeRoutes = {
    SPINE_X,
    TABLE_SLOTS,
    deskOf,
    route,
    rerouteFrom,
  };
})();
