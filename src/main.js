const { app, BrowserWindow, ipcMain, screen, clipboard, globalShortcut, shell } = require('electron');
const path = require('path');
const fs = require('fs');

function fsExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
const { execFile } = require('child_process');
const { snapshot, digest } = require('./collector');

const CLAUDE_BIN = process.env.SB_CLAUDE_BIN || '/opt/homebrew/bin/claude';
const CONSULT_TIMEOUT_MS = 180000;

const COLLAPSED_W = 58;
const EXPANDED_W = 390;
const MAP_W = 820;
const MIN_W = 52;
const MIN_H = 70;   // low enough that a one-dot rail keeps its natural height
const MARGIN = 14;
const POLL_MS = 2000;

let win = null;
let expanded = false;
let mapMode = false;
let timer = null;
let lastPayload = '';
let lastSnapshot = null;
let liveRows = 1;

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
  return mapMode ? 'map' : 'list';
}

function defaultSize(key) {
  const dh = screen.getPrimaryDisplay().workArea.height;
  if (key === 'rail') return { width: COLLAPSED_W, height: railHeight(liveRows) };
  if (key === 'map') return { width: MAP_W, height: Math.min(860, dh - 60) };
  return { width: EXPANDED_W, height: Math.min(780, dh - 60) };
}

// Resizes keep the right edge and the top where they are, so the panel grows
// leftwards into the screen and never jumps away from where it was put.
function applyBounds() {
  if (!win || win.isDestroyed()) return;
  const key = modeKey();
  const want = sizes[key] || defaultSize(key);
  const wa = screen.getPrimaryDisplay().workArea;
  const cur = win.getBounds();
  const width = Math.max(MIN_W, Math.min(Math.round(want.width), wa.width));
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

  win.setAlwaysOnTop(true, 'floating');
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
    win.webContents.send('expanded', expanded, mapMode);
    // The first poll usually resolves before this point, so replay it rather
    // than leaving the panel blank until something changes.
    if (lastSnapshot) win.webContents.send('snapshot', lastSnapshot);
    // Dev aid: SB_TEST_ASK="<title substring>|<question>" fires one real ask
    // through the UI path, which is otherwise only reachable by clicking.
    if (process.env.SB_TEST_WIN) runWindowSelfTest();
    if (process.env.SB_TEST_NODE) setTimeout(() => win.webContents.send('testnode', process.env.SB_TEST_NODE), 1500);
    if (process.env.SB_TEST_REOPEN) setTimeout(() => win.webContents.send('testreopen', process.env.SB_TEST_REOPEN), 1800);
    if (process.env.SB_TEST_MAPRESET) runMapResetTest();
    if (process.env.SB_TEST_NEW) setTimeout(() => win.webContents.send('testclick', 'new'), 1500);
    if (process.env.SB_TEST_TILE) setTimeout(() => win.webContents.send('testclick', 'tile'), 1500);
    if (process.env.SB_TEST_FOCUS) setTimeout(() => win.webContents.send('testfocus', process.env.SB_TEST_FOCUS), 1500);
    if (process.env.SB_TEST_MAP) win.webContents.send('testmap', process.env.SB_TEST_MAP);
    if (process.env.SB_TEST_ASK) {
      const [match, ...rest] = process.env.SB_TEST_ASK.split('|');
      win.webContents.send('autoask', { match, question: rest.join('|') });
    }
  });
}

function setExpanded(next) {
  if (!win || next === expanded) return;
  expanded = next;
  // Collapsing ends the map: reopening the panel always comes back to the list,
  // which is the view that answers "what is running" at a glance.
  if (!expanded) mapMode = false;
  // Keep the right edge pinned so the strip grows leftwards into the screen.
  applyBounds();
  win.webContents.send('expanded', expanded, mapMode);
}

async function poll() {
  if (!win || win.isDestroyed()) return;
  try {
    const data = await snapshot();
    lastSnapshot = data;
    const payload = JSON.stringify(data.sessions.map((s) => [s.sessionId, s.state, s.idleSec, s.title]));
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

app.whenReady().then(() => {
  createWindow();
  poll();
  timer = setInterval(poll, POLL_MS);
  globalShortcut.register('Command+Alt+S', () => setExpanded(!expanded));
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

// Ask another session a question against its own history. --fork-session means
// the answer comes from a copy, so the original transcript is never appended to
// and a live session is not disturbed. The empty --mcp-config avoids the trust
// prompt a fresh process otherwise hits in a project with MCP servers.
ipcMain.handle('consult', (_e, { sessionId, cwd, question }) => {
  return new Promise((resolve) => {
    if (!sessionId || !question || !question.trim()) {
      resolve({ ok: false, error: 'nothing to ask' });
      return;
    }
    const args = [
      '--resume', sessionId,
      '--fork-session',
      '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}',
      '-p', question.trim(),
    ];
    execFile(CLAUDE_BIN, args, {
      cwd: cwd && fsExists(cwd) ? cwd : undefined,
      timeout: CONSULT_TIMEOUT_MS,
      maxBuffer: 16 << 20,
    }, (err, stdout, stderr) => {
      const answer = (stdout || '').trim();
      if (answer) resolve({ ok: true, answer });
      else resolve({ ok: false, error: (err && err.message) || (stderr || '').trim() || 'no answer' });
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

ipcMain.handle('set-map', (_e, on) => {
  mapMode = !!on;
  if (expanded) applyBounds();
  return mapMode;
});

// A link carries one session's recent work into another and brings back the
// reply. There is no way to push into a running session from outside, so the
// far end is a fork: the receiving conversation is read, never appended to.
ipcMain.handle('relay', (_e, { fromId, fromTitle, toId, toCwd, question }) => {
  return new Promise((resolve) => {
    const brief = digest(fromId);
    if (!brief) {
      resolve({ ok: false, error: 'nothing readable in the source session yet' });
      return;
    }
    const prompt = [
      `Another Claude Code session, "${fromTitle || fromId}", has been working on something`,
      'and wants your read on it. Here is the tail of that conversation.',
      '',
      '--- begin excerpt ---',
      brief,
      '--- end excerpt ---',
      '',
      question || 'What stands out to you here? Be specific and brief.',
    ].join('\n');

    execFile(CLAUDE_BIN, [
      '--resume', toId,
      '--fork-session',
      '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}',
      '-p', prompt,
    ], {
      cwd: toCwd && fsExists(toCwd) ? toCwd : undefined,
      timeout: CONSULT_TIMEOUT_MS,
      maxBuffer: 16 << 20,
    }, (err, stdout, stderr) => {
      const answer = (stdout || '').trim();
      if (answer) resolve({ ok: true, answer });
      else resolve({ ok: false, error: (err && err.message) || (stderr || '').trim() || 'no answer' });
    });
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
    set theTty to tty of tab 1 of window w
${placeLines}
  end repeat
  activate
end tell`);
  if (!placed.ok) return placed;
  const shape = moves.length ? `${moves[0].cols}x${moves[0].rows}` : '0x0';
  return { ok: true, out: `${moves.length} window(s), ${shape} grid at ${cw}x${ch}` };
});

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
ipcMain.handle('open-session-window', async (_e, { cwd, resumeId, slot }) => {
  if (resumeId && !UUID_RE.test(resumeId)) return { ok: false, error: 'bad session id' };
  const dir = cwd && fsExists(cwd) ? cwd : app.getPath('home');
  const cmd = `cd ${shQuote(dir)} && claude${resumeId ? ` --resume ${resumeId}` : ''}`;

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
  return { ok: true, out: `opened in ${dir.replace(app.getPath('home'), '~')}` };
});

ipcMain.handle('copy-peer', (_e, name) => {
  clipboard.writeText(name);
  return name;
});

ipcMain.handle('quit', () => app.quit());

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  if (timer) clearInterval(timer);
  globalShortcut.unregisterAll();
});
