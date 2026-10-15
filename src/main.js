const { app, BrowserWindow, ipcMain, screen, clipboard, globalShortcut, shell, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

function fsExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
const { execFile } = require('child_process');
const { snapshot, digest } = require('./collector');
const demoFeed = require('./demo-feed');

// A dev run is `electron .`, named after the package; the installed app is
// named after productName. Left alone the two keep separate userData
// directories, so a board arranged under one is invisible to the other, and the
// single-instance lock lives in that directory too and would not see across
// them. Pin both to the path the board has always used. Must happen before
// anything reads a path, and before the lock is asked for.
// SB_USERDATA moves both, which is what lets a test copy run beside the
// installed board instead of standing down to it.
app.setPath('userData', process.env.SB_USERDATA || path.join(app.getPath('appData'), 'session-board'));

const CLAUDE_BIN = process.env.SB_CLAUDE_BIN || '/opt/homebrew/bin/claude';
const CONSULT_TIMEOUT_MS = 180000;
// A consult/relay fork used to --resume the real session, which replays its
// entire transcript as input tokens before answering one question. Sessions
// on this machine run tens of MB, so that was costing real money per click.
// A bounded digest() excerpt keeps the question cheap; the fork still runs
// with the right cwd, so it can read live files if the excerpt isn't enough.
const BRIEF_MAX_CHARS = 8000;
const BRIEF_MAX_TURNS = 20;

// Which model runs each kind of call the board makes on its own. Without a
// --model these inherited whatever the user's default was, so making Opus the
// default quietly made every ask cost ~36x what Haiku charges for the same
// answer (measured 2026-10-15: $0.066 vs $0.0018). Ask and relay read an
// excerpt and summarise it, which is Haiku's job; chat is a conversation
// someone is actually steering, so it gets Sonnet unless the panel says otherwise.
//
// The tool list matters as much as the model: each tool's definition rides in
// the prompt, and narrowing to the three read-only ones took the fixed cost of
// a call from ~17K tokens to ~6K. These calls run under -p with no permission
// mode, so anything that writes was being refused anyway.
const JOBS = {
  consult: { model: 'haiku', effort: 'low' },
  relay:   { model: 'haiku', effort: 'low' },
  chat:    { model: 'sonnet' },
};
const JOB_TOOLS = 'Read,Grep,Glob';

const COLLAPSED_W = 58;
const EXPANDED_W = 390;
const MAP_W = 820;
// The office opens wide rather than cropped to the plan's own portrait shape.
// The floorplan sits against the left edge and the space to its right is
// deliberate: it is where the room to grow is, and a window sized tight to the
// drawing would have to be resized before anything could go beside it.
const OFFICE_W = 1000;
const OFFICE_H = 710;
const MIN_W = 52;
// The office cannot use the rail's minimum. Its row is a fixed 96px strip, a
// chat that will not go below 200px, 28px of padding and two 12px gaps, which
// is 348px before the plan gets anything at all. A window narrower than that
// leaves the plan with negative room and the strip's buttons off the edge with
// nothing to scroll to reach them.
//
// 440 rather than the 364 where the arithmetic merely stops being negative,
// because a plan 16px wide is not a plan. This leaves it about 90px, which is
// small but still a floorplan.
const OFFICE_MIN_W = 440;
const MIN_H = 70;   // low enough that a one-dot rail keeps its natural height
const MARGIN = 14;
const POLL_MS = 2000;

let win = null;
let expanded = false;
// Which of the three expanded views is showing. The rail is not one of them:
// that is the collapsed state, and reopening always comes back to the office.
let view = 'office';
let timer = null;
let lastPayload = '';
let lastSnapshot = null;
let liveRows = 1;
let tray = null;
let traySig = '';
let stowed = false;   // hidden to the menu bar rather than quit
let onTop = true;

// The rail shrinks to the dots it actually has; only the open list wants height.
function railHeight(count) {
  return Math.min(420, 64 + Math.max(1, count) * 19);
}

// A size the user dragged to is remembered per view, since a rail, a list and a
// map want very different shapes. Nothing is stored until they resize one.
const WIN_FILE = () => path.join(app.getPath('userData'), 'window.json');
let sizes = {};
let sizeTimer = null;
let applying = false;

function loadSizes() {
  try { sizes = JSON.parse(fs.readFileSync(WIN_FILE(), 'utf8')) || {}; } catch { sizes = {}; }
}

function saveSizes() {
  try {
    fs.mkdirSync(path.dirname(WIN_FILE()), { recursive: true });
    fs.writeFileSync(WIN_FILE(), JSON.stringify(sizes, null, 2));
  } catch { /* a lost window size is not worth surfacing */ }
}

function modeKey() {
  if (!expanded) return 'rail';
  return view;
}

function defaultSize(key) {
  const dh = screen.getPrimaryDisplay().workArea.height;
  if (key === 'rail') return { width: COLLAPSED_W, height: railHeight(liveRows) };
  if (key === 'map') return { width: MAP_W, height: Math.min(860, dh - 60) };
  if (key === 'office') return { width: OFFICE_W, height: Math.min(OFFICE_H, dh - 60) };
  return { width: EXPANDED_W, height: Math.min(780, dh - 60) };
}

// Resizes keep the right edge and the top where they are, so the panel grows
// leftwards into the screen and never jumps away from where it was put.
// What the window may not be dragged narrower than, which depends on what it
// is showing: a rail is a column of dots, the office has a fixed-width strip
// inside it that has to stay reachable.
function minWidthFor(key) {
  return key === 'office' ? OFFICE_MIN_W : MIN_W;
}

function applyBounds() {
  if (!win || win.isDestroyed()) return;
  const key = modeKey();
  const want = sizes[key] || defaultSize(key);
  const wa = screen.getPrimaryDisplay().workArea;
  const cur = win.getBounds();
  const minW = minWidthFor(key);
  // Set before the bounds, so a window already narrower than the new minimum
  // is pulled up to it rather than left where the previous view allowed.
  win.setMinimumSize(minW, MIN_H);
  const width = Math.max(minW, Math.min(Math.round(want.width), wa.width));
  const height = Math.max(MIN_H, Math.min(Math.round(want.height), wa.height));
  const right = cur.x + cur.width;
  const x = Math.max(wa.x, Math.min(right - width, wa.x + wa.width - width));
  const y = Math.max(wa.y, Math.min(cur.y, wa.y + wa.height - height));
  applying = true;
  win.setBounds({ x, y, width, height }, false);
  setTimeout(() => { applying = false; }, 150);
}

function createWindow() {
  const startExpanded = process.env.SB_START_EXPANDED === '1';
  expanded = startExpanded;
  loadSizes();
  if (typeof sizes.onTop === 'boolean') onTop = sizes.onTop;
  const first = sizes[modeKey()] || defaultSize(modeKey());
  const wa = screen.getPrimaryDisplay().workArea;
  const fw = Math.max(MIN_W, Math.min(Math.round(first.width), wa.width));
  const fh = Math.max(MIN_H, Math.min(Math.round(first.height), wa.height));
  win = new BrowserWindow({
    // Top right, tucked under the menu bar. workArea already starts below it,
    // so the margin is measured from there rather than from the screen edge.
    x: Math.round(wa.x + wa.width - fw - MARGIN),
    y: Math.round(wa.y + MARGIN),
    width: fw,
    height: fh,
    frame: false,
    transparent: true,
    resizable: true,
    minWidth: MIN_W,
    minHeight: MIN_H,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 'floating' keeps it above ordinary windows without fighting menus or alerts.
  // Anything the user drags to becomes the remembered size for that view.
  win.on('resize', () => {
    if (applying || !win || win.isDestroyed()) return;
    const b = win.getBounds();
    if (process.env.SB_DEBUG_RESIZE) {
      console.log(`RESIZE ${b.width}x${b.height} mode=${modeKey()} applying=${applying}`);
      console.log(new Error('resize trace').stack.split('\n').slice(1, 5).join(' | '));
    }
    sizes[modeKey()] = { width: b.width, height: b.height };
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(saveSizes, 400);
  });

  win.setAlwaysOnTop(onTop, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Renderer logs are invisible otherwise, which makes a UI mismatch hard to chase.
  // Electron 36+ passes one details object here; older builds pass positional args.
  win.webContents.on('console-message', (...args) => {
    const first = args[0];
    const msg = first && typeof first === 'object' && typeof first.message === 'string'
      ? first.message
      : args[2];
    if (msg) console.log('[renderer]', msg);
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('expanded', expanded, view);
    sendChrome();
    // The first poll usually resolves before this point, so replay it rather
    // than leaving the panel blank until something changes.
    if (lastSnapshot) win.webContents.send('snapshot', lastSnapshot);
    // Dev aid: SB_TEST_ASK="<title substring>|<question>" fires one real ask
    // through the UI path, which is otherwise only reachable by clicking.
    if (process.env.SB_TEST_WIN) runWindowSelfTest();
    if (process.env.SB_TEST_NODE) setTimeout(() => win.webContents.send('testnode', process.env.SB_TEST_NODE), 1500);
    if (process.env.SB_TEST_REOPEN) setTimeout(() => win.webContents.send('testreopen', process.env.SB_TEST_REOPEN), 1800);
    if (process.env.SB_TEST_MAPRESET) runMapResetTest();
    if (process.env.SB_TEST_CLICK) setTimeout(() => win.webContents.send('testclick', process.env.SB_TEST_CLICK), 1500);
    // Dev aid: the office view is three clicks deep from a collapsed board
    // (expand, then cycle the foot button twice), which makes it tedious to
    // reach from a script. This drops straight into it.
    if (process.env.SB_TEST_OFFICE) setTimeout(() => {
      setExpanded(true);
      view = 'office';
      applyBounds();
      win.webContents.send('expanded', true, view);
    }, 1200);
    if (process.env.SB_TEST_CHROME) runChromeTest();
    if (process.env.SB_TEST_NEW) setTimeout(() => win.webContents.send('testclick', 'new-sonnet'), 1500);
    if (process.env.SB_TEST_TILE) setTimeout(() => win.webContents.send('testclick', 'tile'), 1500);
    if (process.env.SB_TEST_FOCUS) setTimeout(() => win.webContents.send('testfocus', process.env.SB_TEST_FOCUS), 1500);
    if (process.env.SB_TEST_MAP) win.webContents.send('testmap', process.env.SB_TEST_MAP);
    if (process.env.SB_TEST_TRASH) setTimeout(() => win.webContents.send('testtrash', process.env.SB_TEST_TRASH), 1500);
    if (process.env.SB_TEST_ASK) {
      const [match, ...rest] = process.env.SB_TEST_ASK.split('|');
      win.webContents.send('autoask', { match, question: rest.join('|') });
    }
  });
}

// Hiding is not quitting: the poll keeps running, so the menu bar still shows
// what is waiting on you, and the panel comes back the size it was.
function setStowed(next) {
  if (!win || win.isDestroyed() || next === stowed) return;
  stowed = next;
  // showInactive, since bringing the board back should not take focus off the
  // terminal you were reading when you asked for it.
  if (stowed) win.hide();
  else win.showInactive();
  refreshTray();
}

function setOnTop(next) {
  onTop = !!next;
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(onTop, 'floating');
  sizes.onTop = onTop;
  saveSizes();
  refreshTray();
  sendChrome();
}

function sendChrome() {
  if (win && !win.isDestroyed()) win.webContents.send('chrome', { onTop });
}

// The menu bar is the only handle left once the panel is hidden, so it carries
// every window action as well as the waiting count.
function refreshTray() {
  if (!tray) return;
  const live = lastSnapshot ? lastSnapshot.liveCount : 0;
  const waiting = lastSnapshot ? lastSnapshot.waitingCount : 0;
  tray.setToolTip(`Session Board — ${live} running${waiting ? `, ${waiting} waiting on you` : ''}`);
  // A count beside the icon is the whole point of hiding the panel rather than
  // quitting it; an idle board stays a bare glyph.
  tray.setTitle(waiting ? String(waiting) : '');
  // The poll calls this every couple of seconds for the count, so the menu is
  // only rebuilt when something in it actually reads differently. Rebuilding it
  // under an open menu would otherwise drop it out from under the pointer.
  const sig = `${stowed}|${expanded}|${onTop}`;
  if (sig === traySig) return;
  traySig = sig;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: stowed ? 'Show board' : 'Hide board', accelerator: 'Command+Alt+B', click: () => setStowed(!stowed) },
    {
      label: expanded ? 'Collapse to rail' : 'Expand',
      accelerator: 'Command+Alt+S',
      enabled: !stowed,
      click: () => setExpanded(!expanded),
    },
    { type: 'separator' },
    { label: 'Keep on top of other windows', type: 'checkbox', checked: onTop, click: () => setOnTop(!onTop) },
    { type: 'separator' },
    { label: 'Quit Session Board', accelerator: 'Command+Q', click: () => app.quit() },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  refreshTray();
}

function setExpanded(next) {
  if (!win || next === expanded) return;
  // Expanding something that is hidden has to bring it back first, or the
  // shortcut would silently do nothing.
  if (stowed) setStowed(false);
  expanded = next;
  // Collapsing ends whichever view was open: reopening the panel always comes
  // back to the office, which answers "what is running" at a glance the same
  // way the list did, with who's blocked or idle readable from the floor.
  if (!expanded) view = 'office';
  // Keep the right edge pinned so the strip grows leftwards into the screen.
  applyBounds();
  win.webContents.send('expanded', expanded, view);
  refreshTray();
}

// A session can only ask for a permission prompt after it has been put away,
// and nobody can answer one they cannot see. The window comes back on its own
// rather than merely warning, because a warning does not get them back to it.
// Deliberately no `activate`: that would pull the user out of whatever app they
// are in. The tray count and the panel already say somebody is waiting; this
// just makes the window there when they look.
async function revealBlocked(data) {
  const blocked = (data.sessions || []).filter((s) => s.state === 'blocked' && TTY_RE.test(s.tty || ''));
  if (!blocked.length) return;
  const away = new Set(await ttysAway());
  const stuck = blocked.filter((s) => away.has(s.tty));
  if (!stuck.length) return;
  await osa(ttyMatchScript(stuck.map((s) => s.tty), 'true'));
}

async function poll() {
  if (!win || win.isDestroyed()) return;
  try {
    // SB_DEMO swaps the real collector for a scripted feed, so the walking,
    // clustering and table behaviour can be watched without waiting for five
    // sessions to talk in the right shapes. Launch-time only and never a
    // button: nothing that replaces the board's view of what is running should
    // be one stray click away on the board you actually use.
    const data = await (process.env.SB_DEMO ? demoFeed.snapshot() : snapshot({ ignorePids: ownPids }));
    lastSnapshot = data;
    refreshTray();
    revealBlocked(data);
    // Links matter to the office view the way state matters to the list, so a
    // conversation starting or going quiet has to count as a change in its own
    // right. idleSec moves most polls anyway, but relying on that to carry the
    // links through would be luck rather than design.
    const payload = JSON.stringify([
      data.sessions.map((s) => [s.sessionId, s.state, s.idleSec, s.title]),
      (data.links || []).map((l) => [l.a, l.b]),
    ]);
    // Resize the rail when the number of live sessions changes under it.
    const rows = Math.max(1, data.liveCount);
    // Only auto-size the rail while the user has not given it a size of its own.
    if (rows !== liveRows) {
      liveRows = rows;
      if (!expanded && !sizes.rail) applyBounds();
    }
    // Only repaint when something actually moved; idleSec ticking is enough.
    if (payload !== lastPayload || win.webContents.isLoading()) {
      lastPayload = payload;
      win.webContents.send('snapshot', data);
    } else {
      win.webContents.send('tick', data.at);
    }
  } catch (err) {
    win.webContents.send('error', String(err && err.message ? err.message : err));
  }
}

// Dev aid: drives the grip button and a user-style resize, then reports what the
// window actually did, since neither is reachable without a mouse.
function runMapResetTest() {
  const log = (label) => {
    const b = win.getBounds();
    console.log(`TESTRESET ${label}: ${b.width}x${b.height} mode=${modeKey()}`);
  };
  const grip = () => win.webContents.send('testgrip', { target: 'dots', taps: 1 });
  setTimeout(() => { win.webContents.send('testclick', 'view'); }, 1200);   // open the map
  setTimeout(() => { log('map open'); grip(); }, 2600);                     // collapse
  setTimeout(() => { log('collapsed'); grip(); }, 3800);                    // reopen
  setTimeout(() => { log('reopened'); }, 5000);
}

// Dev aid: drives the three window controls and reports what the window did,
// since pin, hide and quit are only reachable with a mouse otherwise.
function runChromeTest() {
  const click = (id) => win.webContents.send('testclick', id);
  const log = (label) => console.log(`TESTCHROME ${label}: onTop=${win.isAlwaysOnTop()} visible=${win.isVisible()} stowed=${stowed}`);
  setTimeout(() => { log('start'); click('pin'); }, 1200);
  setTimeout(() => { log('after pin off'); click('pin'); }, 2200);
  setTimeout(() => { log('after pin on'); click('stow'); }, 3200);
  setTimeout(() => { log('after hide'); setStowed(false); }, 4200);
  setTimeout(() => { log('after show from the menu bar'); }, 5200);
  setTimeout(() => { console.log('TESTCHROME done'); app.quit(); }, 6000);
}

function runWindowSelfTest() {
  const log = (label) => {
    const b = win.getBounds();
    console.log(`TESTWIN ${label}: ${b.width}x${b.height} at ${b.x},${b.y} mode=${modeKey()}`);
  };
  const grip = (spec) => win.webContents.send('testgrip', spec);

  setTimeout(() => { log('start'); grip({ target: 'bar', taps: 1 }); }, 1200);
  setTimeout(() => { log('after single tap on bar (expect no change)'); grip({ target: 'bar', taps: 2 }); }, 2400);
  setTimeout(() => { log('after double tap on bar'); grip({ target: 'dots', taps: 1 }); }, 3600);
  setTimeout(() => { log('after single click on dots'); grip({ target: 'bar', move: -120 }); }, 4800);
  setTimeout(() => { log('after drag on bar'); }, 6000);
}

// One board at a time. Two copies means two sets of `claude agents` polls, two
// trays and two windows fighting for the same screen edge, and the usual way to
// get there is launching the installed app while an `npm start` copy is still
// running. The second one stands down and reveals the first instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => {
    // Same gesture as a dock click, so it reads the same way.
    setStowed(!stowed);
    if (win && !stowed) win.focus();
  });
}

app.whenReady().then(() => {
  if (!gotLock) return;
  readyAt = Date.now();
  createWindow();
  createTray();
  poll();
  timer = setInterval(poll, POLL_MS);
  globalShortcut.register('Command+Alt+S', () => setExpanded(!expanded));
  // Not Command+Alt+H: macOS owns that one for Hide Others, and a global
  // shortcut would quietly shadow it everywhere.
  globalShortcut.register('Command+Alt+B', () => setStowed(!stowed));
});

// The dock icon is a switch: click it to put the board away, click it again to
// get it back. This is not what a dock icon normally does on macOS, where a
// click only ever shows, but the icon is the handle most people reach for and
// a show-only one is half a control.
//
// 'activate' is applicationShouldHandleReopen, so Cmd+Tab and ordinary window
// focus do not reach here: a dock click, a relaunch and the first launch do.
// Only the launch needs guarding, or the board would hide itself the moment it
// opened.
let readyAt = 0;
const LAUNCH_GRACE_MS = 1500;

app.on('activate', () => {
  if (Date.now() - readyAt < LAUNCH_GRACE_MS) { setStowed(false); return; }
  setStowed(!stowed);
});

ipcMain.handle('toggle', (_e, next) => {
  setExpanded(typeof next === 'boolean' ? next : !expanded);
  return expanded;
});

ipcMain.handle('refresh', async () => { lastPayload = ''; await poll(); });

ipcMain.handle('copy-resume', (_e, session) => {
  // A closed session needs its directory back before --resume means anything.
  const cmd = session.cwd
    ? `cd ${JSON.stringify(session.cwd)} && claude --resume ${session.sessionId}`
    : `claude --resume ${session.sessionId}`;
  clipboard.writeText(cmd);
  return cmd;
});

ipcMain.handle('reveal', (_e, session) => {
  if (session.cwd) shell.openPath(session.cwd);
});

// Sessions this app started itself. A consult, a relay or a chat message runs
// claude --fork-session, and the registry reports that fork as an ordinary
// interactive session, indistinguishable from one William opened in a terminal.
// Left alone it turns up on the board as an extra ball and takes an office for
// the few seconds it lives, which is confusing in the office view and wrong in
// every view. The child's pid is exact and known the moment it is spawned,
// which the fork's own session id is not: that only comes back at the end.
const ownPids = new Set();

function runClaude(args, options, done) {
  const child = execFile(CLAUDE_BIN, args, options, (err, stdout, stderr) => {
    ownPids.delete(child.pid);
    done(err, stdout, stderr);
  });
  ownPids.add(child.pid);
  // execFile leaves the child a stdin pipe nobody ever writes to, and claude
  // waits three seconds for input on it before giving up and warning about it
  // on stderr. Closing it immediately is what says "there is no input coming":
  // every ask and every chat message was paying that three seconds, and the
  // warning was the only thing in stderr when a call failed for some other
  // reason, which made every failure look like a stdin problem.
  if (child.stdin) child.stdin.end();
  return child;
}

// Every call the board makes goes through here, so model choice, the tool list
// and the cost record live in one place. json output is what carries back the
// session id (chat needs it) and the usage block (the log needs it).
const USAGE_FILE = () => path.join(app.getPath('userData'), 'usage.jsonl');
// total_cost_usd on a resumed session is the running total for that whole
// conversation, not this call's share, so the second chat message would report
// the first one's cost again on top of its own. Remember each conversation's
// last total and charge each call only the difference.
const lastTotalUsd = new Map();

function runJob(job, { prompt, resumeId, cwd, model }, done) {
  const spec = JOBS[job];
  const useModel = model && MODEL_ALIASES.has(model) ? model : spec.model;
  const args = [];
  if (resumeId) args.push('--resume', resumeId);
  args.push(
    '--model', useModel,
    '--tools', JOB_TOOLS,
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--output-format', 'json',
  );
  if (spec.effort) args.push('--effort', spec.effort);
  args.push('-p', prompt);
  const started = Date.now();
  runClaude(args, {
    cwd: cwd && fsExists(cwd) ? cwd : undefined,
    timeout: CONSULT_TIMEOUT_MS,
    maxBuffer: 16 << 20,
  }, (err, stdout, stderr) => {
    let parsed = null;
    try { parsed = JSON.parse((stdout || '').trim()); } catch { /* not json */ }
    const answer = parsed && typeof parsed.result === 'string' ? parsed.result.trim() : '';
    if (!parsed || parsed.is_error || !answer) {
      done({ ok: false, error: (parsed && parsed.is_error && answer) || whyItFailed(err, stderr) });
      return;
    }
    const u = parsed.usage || {};
    const cost = {
      model: useModel,
      tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)
        + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0),
      usd: 0,
    };
    const total = parsed.total_cost_usd || 0;
    const sid = parsed.session_id;
    cost.usd = Math.max(0, total - ((resumeId && lastTotalUsd.get(resumeId)) || 0));
    if (sid) lastTotalUsd.set(sid, total);
    // A log line is a convenience, never a reason to lose an answer.
    try {
      fs.mkdirSync(path.dirname(USAGE_FILE()), { recursive: true });
      fs.appendFileSync(USAGE_FILE(), JSON.stringify({
        at: new Date(started).toISOString(), job, ...cost,
        input: u.input_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        output: u.output_tokens || 0,
        ms: Date.now() - started,
        promptChars: prompt.length,
        resumed: !!resumeId,
      }) + '\n');
    } catch { /* unwritable log: carry on */ }
    done({ ok: true, answer, sessionId: parsed.session_id || null, cost });
  });
}

// A brief is prefixed to the first message so the fresh process knows whose
// work it is looking at, and that the excerpt is not its own memory.
function withBrief(brief, rest) {
  return [
    'Here is a recent excerpt of a Claude Code conversation that ran in this',
    'directory. You are a fresh process, not that session; the excerpt is',
    'context, not your own memory. Read live files yourself if you need more',
    'than the excerpt gives you.',
    '',
    '--- begin excerpt ---',
    brief,
    '--- end excerpt ---',
    '',
    rest,
  ].join('\n');
}

// Ask another session a question against a recent excerpt of its own history,
// not a full --resume fork: that replayed the whole transcript as input tokens
// for every click. The fork still runs in the session's own cwd, so it can read
// live files itself if the excerpt doesn't cover what's being asked. The empty
// --mcp-config avoids the trust prompt a fresh process otherwise hits in a
// project with MCP servers.
ipcMain.handle('consult', (_e, { sessionId, cwd, question }) => {
  return new Promise((resolve) => {
    if (!sessionId || !question || !question.trim()) {
      resolve({ ok: false, error: 'nothing to ask' });
      return;
    }
    const brief = digest(sessionId, BRIEF_MAX_CHARS, BRIEF_MAX_TURNS);
    if (!brief) {
      resolve({ ok: false, error: 'nothing readable in that session yet' });
      return;
    }
    runJob('consult', { prompt: withBrief(brief, question.trim()), cwd }, resolve);
  });
});

// Chat is consult with a memory. The first message starts a fresh process
// seeded with the same bounded excerpt consult uses; every reply carries that
// conversation's own id back, and later messages resume it, so the panel holds
// a conversation rather than a series of unrelated questions.
//
// It used to --resume --fork-session the real session, which replayed the whole
// transcript (often 100K+ tokens) on the first message and resent it with every
// follow-up. Resuming the small seeded conversation instead means a follow-up
// costs what the chat itself has grown to, not what the lead's history has.
//
// What this is not: it never reaches the live session. The person at that
// terminal sees nothing, and nothing typed here can make them act. The chat is
// a separate process that read their recent history, and it stops learning at
// the moment it started, which is why the panel can start a fresh one.
ipcMain.handle('chat', (_e, { sessionId, forkId, cwd, message, model }) => {
  return new Promise((resolve) => {
    if (!message || !message.trim()) { resolve({ ok: false, error: 'nothing to say' }); return; }
    if (!forkId && !sessionId) { resolve({ ok: false, error: 'no session to talk to' }); return; }
    let prompt = message.trim();
    if (!forkId) {
      const brief = digest(sessionId, BRIEF_MAX_CHARS, BRIEF_MAX_TURNS);
      if (!brief) { resolve({ ok: false, error: 'nothing readable in that session yet' }); return; }
      prompt = withBrief(brief, prompt);
    }
    runJob('chat', { prompt, resumeId: forkId, cwd, model }, (res) => {
      if (res.ok) res.forkId = res.sessionId || forkId;
      resolve(res);
    });
  });
});

// Hand-placed node positions and the links between sessions outlive the app, so
// they live next to the app's own state rather than in the project.
const BOARD_FILE = () => path.join(app.getPath('userData'), 'board.json');

ipcMain.handle('load-board', () => {
  try {
    return JSON.parse(fs.readFileSync(BOARD_FILE(), 'utf8'));
  } catch {
    return { positions: {}, links: [], pinned: [] };
  }
});

ipcMain.handle('save-board', (_e, board) => {
  try {
    fs.mkdirSync(path.dirname(BOARD_FILE()), { recursive: true });
    fs.writeFileSync(BOARD_FILE(), JSON.stringify(board, null, 2));
    return true;
  } catch (err) {
    return false;
  }
});

ipcMain.handle('set-view', (_e, name) => {
  // Anything unrecognised falls back to the list rather than leaving the panel
  // showing a view the main process does not believe is open.
  view = (name === 'map' || name === 'office') ? name : 'list';
  if (expanded) applyBounds();
  return view;
});

// A link carries one session's recent work into another and brings back the
// reply. There is no way to push into a running session from outside, so the
// far end is a fork: the receiving conversation is read, never appended to.
// Both sides are bounded excerpts, not a --resume of the real transcripts:
// that replayed each full history as input tokens on every relay.
ipcMain.handle('relay', (_e, { fromId, fromTitle, toId, toCwd, question }) => {
  return new Promise((resolve) => {
    const brief = digest(fromId, BRIEF_MAX_CHARS, BRIEF_MAX_TURNS);
    if (!brief) {
      resolve({ ok: false, error: 'nothing readable in the source session yet' });
      return;
    }
    const ownBrief = digest(toId, BRIEF_MAX_CHARS, BRIEF_MAX_TURNS);
    const prompt = [
      'You are a fresh process, not a resumed session; the excerpts below are',
      'context handed to you, not your own memory. Read live files yourself in',
      'this directory if you need more than they give you.',
      '',
      ...(ownBrief ? [
        '--- your own recent work in this directory ---',
        ownBrief,
        '--- end ---',
        '',
      ] : []),
      `Another Claude Code session, "${fromTitle || fromId}", has been working on something`,
      'and wants your read on it. Here is the tail of that conversation.',
      '',
      '--- begin excerpt ---',
      brief,
      '--- end excerpt ---',
      '',
      question || 'What stands out to you here? Be specific and brief.',
    ].join('\n');

    runJob('relay', { prompt, cwd: toCwd }, resolve);
  });
});

// Moving by deltas keeps the renderer side synchronous: it never has to wait on
// the window's position before it can start dragging.
ipcMain.on('win-move-by', (_e, { dx, dy }) => {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const wa = screen.getPrimaryDisplay().workArea;
  const x = Math.max(wa.x - b.width + 40, Math.min(b.x + dx, wa.x + wa.width - 40));
  const y = Math.max(wa.y, Math.min(b.y + dy, wa.y + wa.height - 40));
  win.setPosition(Math.round(x), Math.round(y));
});

// --- driving Terminal.app -------------------------------------------------
// A session's tty names the exact window running it, which is the only durable
// handle: window ids and titles both change underneath you.

const TTY_RE = /^\/dev\/tty[a-z0-9]+$/;

function osa(script) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: (stderr || err.message || '').trim() });
      else resolve({ ok: true, out: (stdout || '').trim() });
    });
  });
}

ipcMain.handle('focus-session', async (_e, tty) => {
  if (!TTY_RE.test(tty || '')) return { ok: false, error: 'no terminal for that session' };
  const res = await osa(`tell application "Terminal"
  repeat with w from 1 to count of windows
    repeat with t from 1 to count of tabs of window w
      if (tty of tab t of window w) is "${tty}" then
        set selected of tab t of window w to true
        set index of window w to 1
        activate
        return "ok"
      end if
    end repeat
  end repeat
  return "notfound"
end tell`);
  if (res.ok && res.out === 'notfound') return { ok: false, error: 'that window is not open in Terminal' };
  return res;
});

// Sizes every session's window to 75x20, measures what that came out as, then
// lays them out left to right. The right gutter keeps this panel uncovered.
ipcMain.handle('tile-windows', async (_e, ttys) => {
  const list = (ttys || []).filter((t) => TTY_RE.test(t));
  if (!list.length) return { ok: false, error: 'no terminal sessions to tile' };

  const asList = list.map((t) => `"${t}"`).join(', ');
  const sized = await osa(`tell application "Terminal"
  set wanted to {${asList}}
  set measured to ""
  repeat with w from 1 to count of windows
    if (count of tabs of window w) > 0 then
    set theTty to tty of tab 1 of window w
    repeat with q in wanted
      if theTty is (q as text) then
        set number of columns of window w to 75
        set number of rows of window w to 20
        delay 0.15
        set b to bounds of window w
        set measured to (((item 3 of b) - (item 1 of b)) as text) & "," & (((item 4 of b) - (item 2 of b)) as text)
      end if
    end repeat
    end if
  end repeat
  return measured
end tell`);
  if (!sized.ok) return sized;

  const [cw, ch] = (sized.out || '').split(',').map(Number);
  if (!cw || !ch) return { ok: false, error: 'none of those windows are open in Terminal' };

  // An expanded panel is wide enough to swallow a whole column, and tiling is a
  // request to look at the sessions rather than at this. So it gets out of the way.
  if (expanded) setExpanded(false);
  const moves = list.map((tty, i) => ({ tty, ...gridSlot(i, cw, ch) }));

  const placeLines = moves.map((m) => `  if theTty is "${m.tty}" then set position of window w to {${m.x}, ${m.y}}`).join('\n');
  const placed = await osa(`tell application "Terminal"
  repeat with w from 1 to count of windows
    if (count of tabs of window w) > 0 then
    set theTty to tty of tab 1 of window w
${placeLines}
    end if
  end repeat
  activate
end tell`);
  if (!placed.ok) return placed;
  const shape = moves.length ? `${moves[0].cols}x${moves[0].rows}` : '0x0';
  return { ok: true, out: `${moves.length} window(s), ${shape} grid at ${cw}x${ch}` };
});

// Putting the sessions away so the office can stand in for them.
//
// `visible` is the lever, not miniaturise and not moving the window off-screen.
// Miniaturised is in Terminal's dictionary but is not honoured: set it true and
// it reads back false immediately. Off-screen positions get clamped by macOS,
// so a sliver can stay on the display. `visible` is built for exactly this and
// round-trips exactly.
//
// It lives on the window, not the tab, so a window holding one session and one
// ordinary shell cannot be half-hidden. Such a window is left alone rather than
// taking somebody's unrelated work off screen with it, and the count comes back
// so the panel can say why one stayed up.
//
// Which session windows are away is read back from Terminal rather than
// remembered here. Remembering it was a trap: the set lives as long as the
// process, so restarting the board while the terminals were away left them
// hidden with nothing able to bring them back, which is exactly the dead end
// this feature was supposed to avoid. Terminal already knows, so ask it.
function hiddenScript(ttys) {
  const wanted = ttys.map((t) => `"${t}"`).join(', ');
  return `tell application "Terminal"
  set wanted to {${wanted}}
  set away to {}
  repeat with w in windows
    if (count of tabs of w) > 0 then
      if not (visible of w) then
        repeat with t from 1 to count of tabs of w
          set theTty to tty of tab t of w
          repeat with q in wanted
            if theTty is (q as text) then set end of away to theTty
          end repeat
        end repeat
      end if
    end if
  end repeat
  set AppleScript's text item delimiters to ","
  return away as text
end tell`;
}

function sessionTtys() {
  const sessions = (lastSnapshot && lastSnapshot.sessions) || [];
  return sessions.filter((s) => s.pid && TTY_RE.test(s.tty || '')).map((s) => s.tty);
}

async function ttysAway() {
  const ttys = sessionTtys();
  if (!ttys.length) return [];
  const res = await osa(hiddenScript(ttys));
  if (!res.ok) return [];
  return (res.out || '').split(',').map((t) => t.trim()).filter(Boolean);
}

ipcMain.handle('sessions-away', async () => (await ttysAway()).length);

function ttyMatchScript(ttys, visible) {
  const wanted = ttys.map((t) => `"${t}"`).join(', ');
  // Two passes on purpose. Changing a window's visibility reorders Terminal's
  // own `windows` collection, so deciding and acting in one loop walks a list
  // that is moving underneath it and quietly skips windows. The first pass only
  // reads, collecting ids, which stay valid across the reorder; the second only
  // writes, addressed by id rather than by position.
  return `tell application "Terminal"
  set wanted to {${wanted}}
  set targets to {}
  set mixed to 0
  repeat with w in windows
    set tabCount to count of tabs of w
    -- A window with no tabs is a stale entry Terminal has not finished letting
    -- go of, and asking it for tab 1 throws and aborts the whole loop.
    if tabCount > 0 then
      set allMine to true
      repeat with t from 1 to tabCount
        set theTty to tty of tab t of w
        set found to false
        repeat with q in wanted
          if theTty is (q as text) then set found to true
        end repeat
        if not found then set allMine to false
      end repeat
      if allMine then
        set end of targets to id of w
      else
        set mixed to mixed + 1
      end if
    end if
  end repeat
  repeat with theId in targets
    set visible of (first window whose id is theId) to ${visible}
  end repeat
  return ((count of targets) as text) & "," & (mixed as text)
end tell`;
}

ipcMain.handle('hide-sessions', async (_e, keepSessionId) => {
  const sessions = (lastSnapshot && lastSnapshot.sessions) || [];
  const live = sessions.filter((s) => s.pid && TTY_RE.test(s.tty || ''));
  // A session halted on a prompt must stay reachable. Hiding it would leave it
  // blocked for ever behind a window nobody can find.
  const blocked = live.filter((s) => s.state === 'blocked');
  // The lead's window stays up. The chat talks to a fork of that session, not
  // to the session itself, so hiding its terminal would take away the only
  // place the lead can actually be told to do something.
  const kept = live.find((s) => s.sessionId === keepSessionId);
  const hideable = live.filter((s) => s.state !== 'blocked' && s.sessionId !== keepSessionId);
  if (!hideable.length) return { ok: false, error: 'no terminal sessions to put away' };

  // A self-test drives the same gesture but must never take a window away, the
  // way SB_TEST_TRASH stops short of actually signalling a process.
  if (process.env.SB_TEST_HIDE) {
    const line = 'TESTHIDE lead=' + (keepSessionId || '(none given)')
      + ' keeping=' + (kept ? kept.tty : 'NOTHING')
      + ' would hide=' + (hideable.map((x) => x.tty).join(',') || 'nothing')
      + ' blocked=' + blocked.length;
    console.log(line);
    return { ok: false, error: 'test run, nothing hidden' };
  }
  const res = await osa(ttyMatchScript(hideable.map((s) => s.tty), 'false'));
  if (!res.ok) return res;

  const [changed, mixed] = (res.out || '0,0').split(',').map(Number);
  const notes = [];
  if (kept) notes.push('lead left up');
  if (mixed) notes.push(mixed + ' left up (shares a window with something else)');
  if (blocked.length) notes.push(blocked.length + ' left up (waiting on you)');
  return { ok: true, out: changed + ' window(s) put away' + (notes.length ? ', ' + notes.join(', ') : '') };
});

ipcMain.handle('show-sessions', async () => {
  const ttys = await ttysAway();
  if (!ttys.length) return { ok: false, error: 'nothing is put away' };
  const res = await osa(ttyMatchScript(ttys, 'true'));
  if (!res.ok) return res;
  const [changed] = (res.out || '0,0').split(',').map(Number);
  return { ok: true, out: changed + ' window(s) back' };
});

// What to show when a chat turn fails. Node's own message is the entire command
// line, which here is a resume flag, an inline mcp config and the whole prompt:
// pages of noise with the reason buried at the end, if it is there at all. The
// last line of stderr is almost always the real reason.
function whyItFailed(err, stderr) {
  const lines = (stderr || '').split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('Warning:'));
  if (lines.length) return lines[lines.length - 1];
  if (err && /timed out|ETIMEDOUT/i.test(err.message)) return 'no reply within three minutes';
  return (err && err.code ? 'claude exited with code ' + err.code : 'no answer');
}

// Escape for embedding inside an AppleScript double-quoted string.
function asStr(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Escape for embedding inside a single-quoted shell word.
function shQuote(v) {
  return "'" + String(v).replace(/'/g, "'\\''") + "'";
}

const UUID_RE = /^[0-9a-fA-F-]{36}$/;

// Where the nth window belongs in the grid. Shared by tile and by opening a new
// session, so a window added later lands where tiling would have put it.
function gridSlot(index, cw, ch) {
  const wa = screen.getPrimaryDisplay().workArea;
  const GAP = 12;
  const gutter = COLLAPSED_W + MARGIN * 2;
  const cols = Math.max(1, Math.floor((wa.width - gutter + GAP) / (cw + GAP)));
  const rows = Math.max(1, Math.floor((wa.height - GAP) / (ch + GAP)));
  const perScreen = cols * rows;
  const slot = index % perScreen;
  const wave = Math.floor(index / perScreen);
  return {
    x: Math.round(wa.x + GAP + (slot % cols) * (cw + GAP) + wave * 26),
    y: Math.round(wa.y + GAP + Math.floor(slot / cols) * (ch + GAP) + wave * 26),
    cols,
    rows,
  };
}

// Opens a Terminal window running a session, sized and placed like a tiled one.
// The new window is found by the tty its own tab reports, never by window index,
// which is only accidentally the new one.
// Permission modes offered when hiring. Deliberately not the full set the CLI
// accepts: bypassPermissions turns off every check on a machine used for real
// work, and no panel should carry a button that does that quietly. Someone who
// wants it can still type it, which is the right amount of friction.
const HIRE_MODES = new Set(['manual', 'acceptEdits', 'plan']);
const MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);

ipcMain.handle('open-session-window', async (_e, { cwd, resumeId, model, slot, name, purpose, mode }) => {
  if (resumeId && !UUID_RE.test(resumeId)) return { ok: false, error: 'bad session id' };
  if (model && !MODEL_ALIASES.has(model)) return { ok: false, error: 'bad model' };
  const dir = cwd && fsExists(cwd) ? cwd : app.getPath('home');
  const flags = [];
  if (resumeId) flags.push(`--resume ${resumeId}`);
  if (model) flags.push(`--model ${model}`);
  // A name has to survive being pasted into a shell command, so it is kept to
  // the characters that need no thought rather than quoted and hoped for.
  const clean = String(name || '').trim().replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 40);
  if (clean) flags.push(`-n ${shQuote(clean)}`);
  // The purpose is appended to the system prompt rather than sent as a first
  // message, so it shapes the whole session instead of being one turn that
  // scrolls away.
  // Whitespace is collapsed because the command is handed to Terminal inside an
  // AppleScript string literal, and a literal newline there ends the string and
  // breaks the script. A system prompt reads the same either way, so flattening
  // it costs nothing and removes a whole class of failure.
  const why = String(purpose || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (why) flags.push(`--append-system-prompt ${shQuote(why)}`);
  if (mode && HIRE_MODES.has(mode)) flags.push(`--permission-mode ${mode}`);
  const cmd = `cd ${shQuote(dir)} && claude${flags.length ? ' ' + flags.join(' ') : ''}`;

  const made = await osa(`tell application "Terminal"
  set t to do script "${asStr(cmd)}"
  delay 0.4
  set theTty to tty of t
  repeat with w from 1 to count of windows
    if (tty of tab 1 of window w) is theTty then
      set number of columns of window w to 75
      set number of rows of window w to 20
      delay 0.2
      set b to bounds of window w
      return theTty & "|" & (((item 3 of b) - (item 1 of b)) as text) & "|" & (((item 4 of b) - (item 2 of b)) as text)
    end if
  end repeat
  return "nowindow"
end tell`);
  if (!made.ok) return made;
  const [tty, cwStr, chStr] = (made.out || '').split('|');
  const cw = Number(cwStr);
  const ch = Number(chStr);
  if (!TTY_RE.test(tty || '') || !cw || !ch) return { ok: false, error: 'could not size the new window' };

  const pos = gridSlot(Number(slot) || 0, cw, ch);
  const placed = await osa(`tell application "Terminal"
  repeat with w from 1 to count of windows
    if (tty of tab 1 of window w) is "${tty}" then set position of window w to {${pos.x}, ${pos.y}}
  end repeat
  activate
end tell`);
  if (!placed.ok) return placed;
  const who = (clean ? `${clean} started` : 'opened') + (model ? ` on ${model}` : '');
  return { ok: true, out: `${who} in ${dir.replace(app.getPath('home'), '~')}` };
});

// Ending a session from the map. Two things make this safe enough to do by
// dropping a box on a bin: the pid is re-checked against the process table
// right before the signal, and the user has to say yes in a native dialog.
//
// A pid is only a number, and the one the last poll saw can belong to something
// else entirely two seconds later. So the command line is read back and has to
// look like a session the collector itself would have counted, or nothing is
// signalled. SIGTERM, never SIGKILL: claude gets to write its transcript out.
function pidLooksLikeSession(pid) {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-o', 'command=', '-p', String(pid)], (err, stdout) => {
      const command = (stdout || '').trim();
      if (err || !command) { resolve(null); return; }
      const parts = command.split(/\s+/);
      if (!/(^|\/)claude$/.test(parts[0])) { resolve(null); return; }
      if (/Chrome|Helper|Electron/i.test(command)) { resolve(null); return; }
      if (parts[1] && !parts[1].startsWith('-')) { resolve(null); return; }
      resolve(command);
    });
  });
}

function gone(pid) {
  try { process.kill(pid, 0); return false; } catch { return true; }
}

ipcMain.handle('end-session', async (_e, { pid, title }) => {
  if (!pid) return { ok: true, killed: false, reason: 'already closed' };

  const command = await pidLooksLikeSession(pid);
  if (!command) return { ok: false, killed: false, reason: 'pid ' + pid + ' is no longer that session' };

  // A self-test drives the same gesture but must never end a real session, so
  // it stops here and reports what it would have signalled.
  if (process.env.SB_TEST_TRASH) {
    console.log('TESTTRASH would SIGTERM pid ' + pid + ' (' + command.slice(0, 60) + ')');
    return { ok: true, killed: false, reason: 'test run, nothing signalled' };
  }

  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['End session', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'End "' + (title || 'this session') + '"?',
    detail: 'Quits the claude process (pid ' + pid + '). Anything it is part way through is lost. '
      + 'The transcript is kept, so it can still be resumed later.',
  });
  if (response !== 0) return { ok: true, killed: false, reason: 'cancelled' };

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    return { ok: false, killed: false, reason: (err && err.message) || 'could not signal it' };
  }

  // Report what actually happened rather than what was asked for: a session
  // wedged in a syscall can sit on a SIGTERM, and the map should not claim it
  // is gone while the process is still there.
  await new Promise((r) => setTimeout(r, 600));
  lastPayload = '';
  poll();
  if (!gone(pid)) return { ok: true, killed: true, slow: true, reason: 'asked it to quit; still shutting down' };
  return { ok: true, killed: true };
});

ipcMain.handle('copy-peer', (_e, name) => {
  clipboard.writeText(name);
  return name;
});

ipcMain.handle('quit', () => app.quit());

ipcMain.handle('stow', () => { setStowed(true); return true; });

ipcMain.handle('set-on-top', (_e, next) => {
  setOnTop(typeof next === 'boolean' ? next : !onTop);
  return onTop;
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  if (timer) clearInterval(timer);
  globalShortcut.unregisterAll();
  if (tray) { tray.destroy(); tray = null; }
});
