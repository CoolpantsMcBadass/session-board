// Sessions the board runs itself, and the terminal the dock shows them in.
//
// A session in Terminal.app is another app's window, and nothing can put that
// inside this one: the old dock was a see-through hole with Terminal's window
// chased around underneath it, which broke on anything the board could not
// relay, a file dragged in from Finder first among them. So sessions the board
// starts run in tmux, on a tmux server of the board's own, and the dock is a
// real terminal (xterm.js in the page, node-pty here) attached to one of them.
//
// tmux rather than node-pty running claude directly: the session then belongs
// to the tmux server, not to the board, so quitting, crashing or reinstalling
// the board leaves every session working, mid-task included, and the next
// launch just attaches again. The board is rebuilt and reinstalled often from
// sessions running inside it, which would otherwise end themselves.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux'].find((p) => fs.existsSync(p)) || null;
// A server of its own (-L), so the board never sees or touches tmux sessions
// someone runs for themselves, and its settings never leak into theirs.
const SOCKET = 'session-board';
const NAME_RE = /^sb-[a-z0-9]+$/;

let confFile = null;

// tmux's own defaults are built for living in tmux; these make it disappear
// into the panel. No status bar and no prefix key, so nothing is drawn that is
// not the session and no keystroke is swallowed (Ctrl+B is a real key to
// claude). Mouse on is what makes the trackpad scroll the history rather than
// cycle claude's input history, and a drag copies straight to the clipboard.
const CONF = `
set -g status off
set -g prefix None
unbind C-b
set -g mouse on
set -s escape-time 0
set -g history-limit 50000
set -g default-terminal "xterm-256color"
set -as terminal-features ",xterm-256color:RGB"
set -g focus-events on
set -s extended-keys on
set -as terminal-features ",xterm*:extkeys"
set -g set-clipboard on
set -g window-size latest
set -g aggressive-resize on
bind -T copy-mode MouseDragEnd1Pane send -X copy-pipe-and-cancel "pbcopy"
bind -T copy-mode-vi MouseDragEnd1Pane send -X copy-pipe-and-cancel "pbcopy"
`;

function init(userDataDir) {
  confFile = path.join(userDataDir, 'tmux.conf');
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(confFile, CONF);
  } catch { confFile = null; }
}

// A Finder-launched app gets a bare environment: no LANG makes tmux draw every
// non-ASCII character as an underscore, which is most of claude's interface.
function env() {
  const e = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  if (!/UTF-8/i.test(e.LANG || '')) e.LANG = 'en_US.UTF-8';
  return e;
}

function base() {
  return ['-u', '-L', SOCKET, ...(confFile ? ['-f', confFile] : [])];
}

function tmux(args) {
  return new Promise((resolve) => {
    if (!TMUX) { resolve({ ok: false, error: 'tmux is not installed (brew install tmux)' }); return; }
    execFile(TMUX, [...base(), ...args], { env: env(), timeout: 5000 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: (stderr || err.message || '').trim() });
      else resolve({ ok: true, out: (stdout || '').trim() });
    });
  });
}

// Every live hosted session: its name, and the pid of the process in its pane.
// The pane runs a login shell that execs claude, so that pid is claude's own
// and matches what the collector already reports.
async function list() {
  const res = await tmux(['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}\t#{session_created}']);
  // No server running is the ordinary empty state, not an error.
  if (!res.ok) return [];
  return res.out.split('\n').filter(Boolean).map((line) => {
    const [name, pid, created] = line.split('\t');
    return { name, pid: Number(pid), created: Number(created) * 1000 };
  }).filter((x) => NAME_RE.test(x.name));
}

// Marks each live session the board hosts with the tmux name the dock attaches
// to, and lists every hosted name, including one claude has not yet registered.
async function annotate(data) {
  const hosted = await list();
  const byPid = new Map(hosted.map((h) => [h.pid, h.name]));
  for (const s of data.sessions || []) {
    if (s.pid && byPid.has(s.pid)) s.hosted = byPid.get(s.pid);
  }
  data.hosted = hosted.map((h) => ({ name: h.name, pid: h.pid, created: h.created }));
  return data;
}

// Starts `claude <args>` in a new hosted session and returns its name. Through a
// login shell, so claude and everything its tools run see the PATH a terminal
// would give them rather than the app's own.
async function start({ cwd, claudeArgs }) {
  const name = 'sb-' + Date.now().toString(36);
  const shell = process.env.SHELL || '/bin/zsh';
  const cmd = 'exec claude ' + claudeArgs;
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const res = await tmux(['new-session', '-d', '-s', name, '-c', dir, '-x', '120', '-y', '36',
    shell, '-l', '-c', cmd]);
  return res.ok ? { ok: true, name } : res;
}

// --- the dock's terminal ----------------------------------------------------
// One attached client at a time: the dock shows one session. Swapping is a new
// client on another session; closing a client only detaches it, so the session
// it showed carries on.

let pty = null;
try { pty = require('node-pty'); } catch { pty = null; }

let client = null;   // { name, proc }

function attach(name, cols, rows, { onData, onExit }) {
  detach();
  if (!TMUX) return { ok: false, error: 'tmux is not installed (brew install tmux)' };
  if (!pty) return { ok: false, error: 'the terminal module did not load' };
  if (!NAME_RE.test(name || '')) return { ok: false, error: 'not a session the board runs' };
  const proc = pty.spawn(TMUX, [...base(), 'attach-session', '-t', name], {
    name: 'xterm-256color',
    cols: Math.max(20, cols | 0),
    rows: Math.max(5, rows | 0),
    cwd: os.homedir(),
    env: env(),
  });
  const mine = { name, proc };
  client = mine;
  proc.onData((d) => { if (client === mine) onData(d); });
  proc.onExit(() => {
    if (client !== mine) return;   // replaced by a newer attach: not an ending
    client = null;
    onExit(name);
  });
  return { ok: true };
}

function detach() {
  const was = client;
  client = null;
  if (was) { try { was.proc.kill(); } catch { /* already gone */ } }
}

function write(data) { if (client) client.proc.write(data); }

function resize(cols, rows) {
  if (!client) return;
  try { client.proc.resize(Math.max(20, cols | 0), Math.max(5, rows | 0)); } catch { /* exited */ }
}

module.exports = { TMUX, init, list, annotate, start, attach, detach, write, resize };
