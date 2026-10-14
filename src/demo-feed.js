// A scripted stand-in for collector.js's snapshot(), used only when SB_DEMO is
// set (see main.js's poll()). It exists because the office view's walking,
// clustering and table behaviour needs real sessions talking to each other in
// the right shapes to show up at all, and waiting for that to happen on its own
// is not a way to look at a UI.
//
// It sits here rather than under office/ because that directory is renderer
// files loaded as bare script tags, and this is a module the main process
// requires. It belongs with collector.js, whose place it takes.
//
// The property that matters most, more than the timeline: these sessions carry
// no pid. agents.js decides who is on the board from state alone, so a pid-less
// session walks and gathers normally, while every pid-driven action in main.js
// (end-session, focus-session, consult, tile-windows) is simply unreachable
// from a session that has none. A demo ball is inert by construction rather
// than by a guard somebody has to remember to keep in step with this file.
//
// The cost of that, and it is deliberate: the list view and the tray count
// "live" by pid, so under SB_DEMO they report nothing running and file the five
// demo sessions under recent. SB_DEMO replaces the whole board, not just the
// office; it is not a way to peek at one view.

// collector.js's PEER_WINDOW_MS is how long traffic counts as live, and is in
// minutes because real conversations are. This is how long a phase holds before
// the office moves on, and is in seconds because the point is to watch it. Long
// enough for the longest walk to finish before anything is asked to move again.
const PHASE_MS = 8000;

// Five, one per office, never more. This is a fixture for a board that caps at
// five, not a generator for an arbitrary N.
const SESSIONS = [1, 2, 3, 4, 5].map((n) => ({
  sessionId: 'demo-' + n,
  title: 'Demo ' + n,
  state: 'working',
  cwd: '~/demo',
  cwdShort: 'demo',
  // Static, and not an oversight: these are not real idle seconds and should
  // not be read as if they were.
  idleSec: 0,
}));

function link(a, b) {
  return { a: 'demo-' + a, b: 'demo-' + b, at: Date.now(), summary: 'demo' };
}

// How the office should look once each phase has been showing for a moment,
// not how it gets there: agents.js's own re-aiming is what makes the walk
// between two of these happen.
const PHASES = [
  () => [],                                                   // everyone alone at their desk
  () => [link(1, 2)],                                         // a pair: 1 gets up and visits 2
  () => [link(1, 2), link(2, 3)],                             // a chain of three: one group, the table
  () => [link(1, 2), link(2, 3), link(3, 4), link(4, 5)],     // all five, every seat taken
  () => [],                                                   // the links lapse, everyone walks home
];

// Driven off the wall clock rather than a counter, so the phase a poll lands in
// depends only on when it happened. A missed or late poll cannot put the
// timeline out of step with itself.
function snapshot() {
  const phase = Math.floor(Date.now() / PHASE_MS) % PHASES.length;
  return {
    at: Date.now(),
    links: PHASES[phase](),
    sessions: SESSIONS,
    // Nothing here has a pid, so nothing here is live by the definition every
    // other view already uses for that word. Zero is the honest answer.
    liveCount: 0,
    waitingCount: 0,
    source: 'demo',
    registryMissed: 0,
    headlessHidden: 0,
    unmatchedPids: 0,
  };
}

module.exports = { snapshot };

// `node src/demo-feed.js` prints the timeline, the same way collector.js prints
// a session summary, so the phases can be checked without starting the app.
if (require.main === module) {
  console.log('looping every ' + PHASE_MS * PHASES.length + 'ms, one phase per ' + PHASE_MS + 'ms');
  setInterval(() => {
    const s = snapshot();
    const clock = new Date(s.at).toISOString().slice(11, 19);
    console.log(clock + '  ' + (s.links.map((l) => l.a + '-' + l.b).join(', ') || '(desks)'));
  }, 1000);
}
