# Session Board

An always-on-top strip that shows which Claude Code sessions are alive and, for each
one, whether it is working or sitting there blocked waiting on you.

It opens as a pill in the top right corner, under the menu bar. Expanding keeps that
top edge, so the panel grows downward rather than jumping.

Collapsed it is a small pill on the right edge: a count plus one dot per live session.
Click it, click the dots at the top, or press Cmd+Alt+S to open the full list.

Drag the window by the bar at the top or by the three dots themselves, and drag its
edges to resize it. On the bar, double-click anywhere to collapse or expand; on the
dots a single click is enough. Each is told apart from a drag by whether the pointer
travelled more than a few pixels.

None of the top bar is a native drag region. macOS hands a drag region's double-click
to the system title-bar action rather than to the page, so click, double-click and drag
are all driven from script to keep them ours. The size
is remembered separately for the rail, the list and the map, since those want very
different shapes, and the right edge stays put as it grows. The rail sizes itself to
the number of live sessions until you give it a size of its own.

## Getting it out of the way

Three controls sit at the right of the top bar once the panel is open.

The pin decides whether the board floats above every other window or sits in the
normal window order, where anything you click can cover it. Filled means it is on top.
The choice is remembered across restarts.

The minus hides the board to the menu bar. That is not a quit: the poll keeps running,
so the menu bar icon still carries the count of sessions waiting on you, and the panel
comes back the size and in the place it was. Cmd+Alt+B hides and shows it from
anywhere, and the menu bar icon does the same. Cmd+Alt+H would have been the obvious
key, but macOS owns it for Hide Others and a global shortcut would quietly shadow it
everywhere.

The × quits.

The rail is 58px wide and has no room for any of this, so a collapsed board is driven
from the menu bar: click the icon for the menu, which carries show/hide, expand, the
on-top toggle and quit. Bringing the window back never takes focus, since you asked to
see the board, not to leave the terminal you were reading.

## Running it

    npm install
    npm start

`SB_START_EXPANDED=1 npm start` opens straight into the list, which is handy while
working on the UI. `SB_TEST_ASK="<title substring>|<question>"` fires one real ask
through the UI path on launch, which is otherwise only reachable by clicking.
`SB_TEST_CHROME=1 npm start` drives the pin, hide and quit buttons in turn and reports
what the window actually did, and `SB_TEST_CLICK=<element id>` clicks any one control.
`SB_TEST_OFFICE=1 npm start` jumps straight into the office view, which is otherwise
three clicks deep (expand, then cycle the foot button twice). `SB_DEMO=1 npm start`
swaps the real collector for a scripted five-session feed so the office's walking,
clustering and table behaviour can be watched without waiting for real sessions to talk
in the right shapes; it replaces the whole board, not just the office, so the list and
the tray report nothing live while it's set.
`node tools/mktray.js src` redraws the menu bar images. `npm run collect` prints one snapshot to the terminal with no
Electron involved, which is the fastest way to check the detection logic.

## How detection works

Two sources, unioned, because neither alone is safe.

`claude agents --json` is a first-party registry of running sessions. It is exact
where guessing fails: it maps a pid straight to a session id, reports a `status`
(`busy` / `idle` / `blocked`), and names the peer other sessions message. Crucially it
is the only way to see a session halted on a permission or trust prompt, which from
the outside looks identical to a slow tool call.

The process scan is the backstop, for anything the registry omits. It reads `ps` for
session-shaped `claude` processes, gets each one's directory from
`lsof -a -p <pid> -d cwd`, and matches that against the `cwd` recorded in each
transcript under `~/.claude/projects`. Turn state comes from the transcript tail: a
finished turn ends with an assistant line whose last content block is `text`, while a
turn in flight ends on `tool_use`, `tool_result` or `thinking`.

Traps worth knowing, each one hit during the build:

- Trusting the registry alone is the dangerous option. If it ever omits a live
  session, that session reads as **closed**, which is the most misleading thing the
  board could say. The footer reports any disagreement between the two sources
  instead of hiding it.
- `claude daemon run`, `claude bg-pty-host` and `claude bg-spare` all start with the
  `claude` binary. They are background plumbing, not sessions. A session is bare
  `claude` or `claude -flags`; a bare word in first position is always a subcommand.
- The `cwd` on a transcript line follows the shell as it moves during the session, so
  matching uses the launch directory from the head of the file, not the latest one.
- The project folder name under `~/.claude/projects` is a lossy encoding of the path:
  a directory whose name contains spaces can come back with a path segment missing, so
  the folder name cannot be used to recover a real directory. Read the `cwd` the
  transcript records instead.

## Reaching the terminal a session is in

Click a running session in the list and its Terminal window comes to the front. The
handle is the session's controlling tty, from `ps -o tty=`, matched against the `tty` of
each Terminal tab over AppleScript. A tty is the one identifier that stays put: window
ids and titles both change underneath you.

On the map, double-click a node to do the same. A single tap does nothing and a drag
still just moves the node; the three are separated by how far the pointer travelled,
measured on the pointer rather than the node so a node pinned against an edge still
reads as a drag.

**tile** sizes every running session's window to 75x20 and lays them out in a grid,
cascading if there are more than fit. The board collapses to its pill first, since an
expanded panel is wide enough to swallow a whole column. Windows past a full screen
cascade from the top left rather than marching off the bottom edge.

**+ new** opens a fresh session in a new Terminal window, and clicking any session in
the **recent** list reopens it with `claude --resume`. Both land in the next free grid
slot, sized 75x20, using the same layout maths as tile, so a window added later sits
where tiling would have put it. The new window is found by the tty its own tab reports
rather than by window index, which is only accidentally the new one.

A resumed session may open on Claude Code's folder trust prompt before it starts, and
until it answers that, it is running but not yet in the session registry. The footer
counts it under the registry/scan mismatch, which is the process scan catching what the
registry cannot yet see.

Both drive Terminal.app specifically. A session running under iTerm, VS Code, or tmux
will not be found, and the first run may ask for permission to control Terminal.

## Talking to another session

Two different mechanisms, for two different things.

**Ask a session about its own history** is the `ask` button, which runs
`claude --resume <id> --fork-session -p "<question>"` in that session's directory.
Because it forks, the answer comes from a copy: the original transcript is never
appended to and a running session is not disturbed. This works on closed sessions too,
which is how you ask a three-week-old session what it concluded. It does not inject
anything into a live session's context; you are consulting a snapshot of its history.

**Live session-to-session messaging** is separate and already built into Claude Code.
Interactive sessions register as named peers (a handle like `yourname-6e`), and a
session can list them and send to them directly. That is the right channel for "go
review this and tell me what you find" between two sessions running side by side. The
board shows the peer name on interactive rows so you can copy it. Background sessions
(`claude --bg`) are registry-managed and do not register as messageable peers.

A gotcha when spawning helper sessions: a fresh process in a project with MCP servers
stops on a trust prompt before doing anything, and sits there `blocked`. Pass
`--strict-mcp-config --mcp-config '{"mcpServers":{}}'` for a helper that should just
read and answer.

## States

| state   | meaning                                                      |
|---------|--------------------------------------------------------------|
| working | live process, mid-turn, transcript written within 2 minutes   |
| waiting | live process, turn handed back to you less than 30 min ago    |
| parked  | live process, turn handed back more than 30 min ago           |
| blocked | live process halted on a permission or trust prompt            |
| stalled | live process, mid-turn, but nothing written for over 2 min    |
| closed  | transcript on disk with no live process                       |

Transcripts tagged `entrypoint: "sdk-cli"` are hidden, since every `claude -p` run,
including this app's own asks and relays, writes one that inherits its parent's title.
That marker means "headless", not "fork", so the filter never applies to a session the
registry reports as live: on its own it would hide a real session started by a script
or a hook.

Clicking a row copies a `cd <dir> && claude --resume <id>` command to the clipboard.

## The map

The `map` button in the footer swaps the list for a canvas. Collapsing the panel ends
the map, so reopening always comes back to the list, which is the view that answers
"what is running" at a glance. The remembered sizes are still kept per view, so the map
reopens at the size you gave it when you next switch to it. Live sessions appear as
nodes, plus anything you have already placed or linked so a session you were working
with does not vanish when it exits. Drag a node to move it; positions persist in
`board.json` under the app's data directory.

Drag the port on a node's right edge onto another node to link them. Right-click a wire
to unlink it, or select it and use **unlink** in the composer. A link means
"B should see what A is doing". Selecting it opens a composer: **send context** takes a
digest of A's recent conversation, hands it to B, and brings B's reply back onto the
link. The wire animates while a relay is in flight, which is the only honest way to see
which sessions are actually talking.

What a link cannot do is inject into a live session. There is no scriptable way to push
a prompt into a running session from outside, so the far end is always a fresh,
unresumed `claude -p` call: B's history is never appended to, and its conversation is
never actually resumed either, only a bounded digest of its recent turns (8000 chars /
20 turns) is handed in as context, which keeps a relay cheap even against a
multi-megabyte transcript. If you want a reply to land inside a running conversation,
that is the peer-messaging channel, which the app cannot drive yet.

The digest is other sessions' prose being handed to a model as input, so treat it as
untrusted: it is wrapped in explicit excerpt delimiters, and a session whose transcript
contains instruction-shaped text can still influence the session you relay it into.

## The office

The `office` view, one step past `map` on the same foot button, draws live sessions as
balls on a hand-drawn floorplan (`src/office/floorplan.png`) instead of free-floating
nodes. Each gets its own numbered office; a session that is actually talking to another
(a real peer message, not a hand-drawn map link) walks to visit it, and three or more
talking at once walk to the shared table instead. There's no pathfinder: the walkable
layout is a single corridor with a stub into each room, so a route is always desk, door,
corridor, repeat in reverse (`src/office/routes.js`). The movement itself is plain data
with no DOM in it (`src/office/agents.js`), which is what makes `SB_DEMO` able to drive
it without a window.

The side strip carries the same five board-wide actions as the footer, plus controls of
its own: **geometry** overlays the traced office rectangles on the drawing, for checking
new geometry against it by eye; **blueprint** inverts the ink so the plan reads on the
dark panel instead of needing a light ground under it; **meet at table** overrides
whoever is actually talking and sends every ball to the table anyway, for looking at the
layout. Ball size and walk speed live behind the **⋯** overflow.

**+ new** here opens a hiring form instead of a model picker: a name, a purpose (folded
into the new session's system prompt rather than sent as a first message, so it shapes
the whole session instead of scrolling away as one turn), and a permission mode. The
footer's own `+opus` / `+sonnet` / `+haiku` still pick a model the plain way and are
unaffected by any of this.

The chat panel on the right talks to a fork of whichever session is "lead" — click its
ball or its box in the strip to choose. Replies carry the fork's own session id back, so
a conversation continues across messages instead of restarting fresh each time; **fresh**
drops that and starts over from the lead's current state. Like the map's relay, this
never reaches the live session: the fork is a read-only copy, and nothing typed here can
make the person at that terminal do anything.

**put away** hides the Terminal window of every session but the lead's, so the office can
stand in for them without a wall of terminal windows behind it, and the same button
brings them back. A session blocked on a permission or trust prompt is never put away:
nothing outside that window can answer it, so hiding it would strand the session for
good.

## Next steps

- Serve snapshots over a localhost WebSocket so a Chrome extension can report open
  claude.ai tabs into the same board.
- Wire `ask` and the links to live peer messaging rather than a fork, so a reply can
  land in a running session instead of a copy of its history.
- Derived edges alongside hand-drawn ones: cluster by launch directory, and draw the
  resume and fork lineage the transcripts already record.
- The node canvas: cluster nodes by directory, draw edges for resumed and forked
  sessions. The schema has an `isSidechain` flag for subagents, but real transcripts
  here contain very few, so do not build the layout around subagent trees.
- Package with electron-builder.
