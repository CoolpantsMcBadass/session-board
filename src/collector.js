// Scans ~/.claude/projects and the process table to work out which Claude Code
// sessions exist, which are alive, and whether each live one is working or
// blocked waiting on a human.
//
// Two facts make this possible without any cooperation from the CLI:
//   1. every transcript line carries its own literal `cwd`, so a live process
//      can be matched to a transcript by working directory (the project folder
//      name is a lossy encoding of the path and must not be trusted)
//   2. a finished turn ends with an assistant line whose last content block is
//      `text`; a turn still in flight ends on tool_use / tool_result / thinking

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const CLAUDE_BIN = process.env.SB_CLAUDE_BIN || '/opt/homebrew/bin/claude';

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 96 * 1024;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const STALL_MS = 120 * 1000;
const PARK_MS = 30 * 60 * 1000;
const MAX_ROWS = 40;

// The head of a transcript is immutable, so its launch cwd is cached for good.
const headCache = new Map();

function sh(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000, maxBuffer: 8 << 20 }, (err, stdout) => {
      resolve(stdout || '');
    });
  });
}

// The CLI keeps its own registry of running sessions. It is exact where the
// process-table scan below can only guess: it maps a pid straight to a session
// id, names the peer for messaging, and knows when a session is blocked on a
// prompt, which looks identical to a long tool call from the outside.
async function liveAgents() {
  const out = await sh(CLAUDE_BIN, ['agents', '--json']);
  if (!out.trim()) return null;
  try {
    const rows = JSON.parse(out);
    if (!Array.isArray(rows)) return null;
    return rows.map((a) => ({
      sessionId: a.sessionId,
      shortId: a.id || null,
      pid: a.pid || null,
      cwd: a.cwd || null,
      kind: a.kind || null,
      peerName: a.name || null,
      status: a.status || a.state || null,
    }));
  } catch {
    return null;
  }
}

// Live `claude` processes, newest first. etime is wall-clock age, not CPU time.
async function livePids() {
  const out = await sh('/bin/ps', ['-axo', 'pid=,etime=,command=']);
  const pids = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, etime, command] = m;
    const parts = command.split(/\s+/);
    const bin = parts[0];
    if (!/(^|\/)claude$/.test(bin)) continue;
    if (/Chrome|Helper|Electron/i.test(command)) continue;
    // `claude daemon run`, `claude bg-pty-host`, `claude bg-spare` are the
    // background plumbing, not sessions. A session is bare `claude` or
    // `claude -flags`; a bare word in first position is always a subcommand.
    if (parts[1] && !parts[1].startsWith('-')) continue;
    pids.push({ pid: Number(pid), etime, uptimeSec: parseEtime(etime) });
  }
  return pids;
}

function parseEtime(etime) {
  // [[dd-]hh:]mm:ss
  const daySplit = etime.split('-');
  const clock = daySplit.pop().split(':').map(Number);
  const days = daySplit.length ? Number(daySplit[0]) : 0;
  while (clock.length < 3) clock.unshift(0);
  const [h, m, s] = clock;
  return days * 86400 + h * 3600 + m * 60 + s;
}

// The controlling terminal is what makes a session reachable: a tty identifies
// the exact Terminal window running it.
async function ttysFor(pids) {
  if (!pids.length) return {};
  const out = await sh('/bin/ps', ['-o', 'pid=,tty=', '-p', pids.join(',')]);
  const map = {};
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\S+)$/);
    if (!m) continue;
    if (m[2] === '??') continue;          // no controlling terminal
    map[Number(m[1])] = '/dev/' + m[2];
  }
  return map;
}

// One lsof call for every pid at once; -Fpn emits p<pid> then n<path>.
async function cwdsFor(pids) {
  if (!pids.length) return {};
  const out = await sh('/usr/sbin/lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn'])
    || await sh('/usr/bin/lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn']);
  const map = {};
  let current = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) current = Number(line.slice(1));
    else if (line.startsWith('n') && current != null) map[current] = line.slice(1);
  }
  return map;
}

function readChunk(file, bytes, fromEnd) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const start = fromEnd ? size - len : 0;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return { text: buf.toString('utf8'), partialFirstLine: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(chunk) {
  const lines = chunk.text.split('\n');
  if (chunk.partialFirstLine) lines.shift();
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* truncated tail line */ }
  }
  return out;
}

function lastBlockKind(entry) {
  const content = (entry.message || {}).content;
  if (typeof content === 'string') return 'str';
  if (!Array.isArray(content) || !content.length) return null;
  const last = content[content.length - 1];
  return last && last.type ? last.type : null;
}

// Walk a transcript's tail backwards for the newest title, cwd and turn state.
function describe(file) {
  const st = fs.statSync(file);
  const entries = parseLines(readChunk(file, TAIL_BYTES, true));
  let title = null;
  let cwd = null;
  let turn = null;

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!title && e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
    if (!cwd && e.cwd) cwd = e.cwd;
    if (!turn && (e.type === 'user' || e.type === 'assistant')) {
      const kind = lastBlockKind(e);
      turn = {
        role: e.type,
        kind,
        at: e.timestamp || null,
        // an assistant turn that ends in prose has handed control back
        done: e.type === 'assistant' && kind === 'text',
      };
    }
    if (title && cwd && turn) break;
  }

  // The cwd on a transcript line follows the shell as it moves, so the only
  // value comparable to a process's cwd is the one the session launched in.
  let head = headCache.get(file);
  if (!head) {
    head = { cwd: null, title: null, firstPrompt: null, entrypoint: null };
    for (const e of parseLines(readChunk(file, HEAD_BYTES, false))) {
      if (!head.entrypoint && e.entrypoint) head.entrypoint = e.entrypoint;
      if (!head.cwd && e.cwd) head.cwd = e.cwd;
      if (!head.title && e.type === 'ai-title' && e.aiTitle) head.title = e.aiTitle;
      if (!head.firstPrompt && e.type === 'user' && typeof (e.message || {}).content === 'string') {
        head.firstPrompt = e.message.content.slice(0, 80);
      }
    }
    if (head.cwd) headCache.set(file, head);
  }
  if (!title) title = head.title || head.firstPrompt;

  return {
    sessionId: path.basename(file, '.jsonl'),
    file,
    // `claude -p` runs, including this app's own consults and relays, are tagged
    // sdk-cli. They are machinery, not conversations anyone had, and each one
    // would otherwise appear as a new session sharing its parent's title.
    headless: head.entrypoint === 'sdk-cli',
    cwd: head.cwd || cwd || null,
    cwdNow: cwd || null,
    title: title || '(untitled)',
    mtime: st.mtimeMs,
    sizeBytes: st.size,
    turn,
  };
}

// '~' for home, otherwise the trailing folder, which is what identifies a project.
function shortPath(p) {
  if (!p) return null;
  const home = os.homedir();
  if (p === home) return '~';
  const parts = p.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] || p;
}

function allTranscripts() {
  const rows = [];
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return rows; }
  const cutoff = Date.now() - RECENT_MS;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(ROOT, d.name);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.size === 0) continue;
      rows.push({ file, mtime: st.mtimeMs, recent: st.mtimeMs >= cutoff });
    }
  }
  return rows.sort((a, b) => b.mtime - a.mtime);
}

async function snapshot() {
  // Both sources always run. The registry is exact about what it reports, but
  // it is not guaranteed to be an exhaustive census, and trusting it alone would
  // silently mark a live session 'closed'. The process scan is the backstop.
  const registry = await liveAgents();
  const pids = await livePids();
  const cwdMap = await cwdsFor(pids.map((p) => p.pid));
  for (const p of pids) p.cwd = cwdMap[p.pid] || null;

  const all = allTranscripts()
    .slice(0, MAX_ROWS + 20)
    .map((r) => { try { return describe(r.file); } catch { return null; } })
    .filter(Boolean);
  // Never let the headless filter hide something that is actually running.
  // sdk-cli marks every `claude -p` run, not just this app's forks, so on its
  // own it could drop a live session a hook or script started.
  const liveIds = new Set((registry || []).map((a) => a.sessionId));
  const hidden = all.filter((s) => s.headless && !liveIds.has(s.sessionId));
  const headlessCount = hidden.length;
  const described = all
    .filter((s) => !s.headless || liveIds.has(s.sessionId))
    .slice(0, MAX_ROWS);

  const byId = new Map(described.map((s) => [s.sessionId, s]));

  if (registry) {
    // Exact: the registry already knows which session id each process is.
    for (const a of registry) {
      let row = byId.get(a.sessionId);
      if (!row) {
        // A session started seconds ago may have no transcript on disk yet.
        row = {
          sessionId: a.sessionId,
          file: null,
          cwd: a.cwd,
          // Nothing has been typed into it yet, so there is no title to show.
          // The peer handle at least identifies which terminal it is.
          title: (a.peerName || '').slice(0, 70) || 'new session',
          untouched: a.kind !== 'background',
          mtime: Date.now(),
          turn: null,
        };
        described.push(row);
        byId.set(a.sessionId, row);
      }
      row.pid = a.pid;
      row.kind = a.kind;
      row.peerName = a.peerName;
      row.shortId = a.shortId;
      row.reported = a.status;
    }
  }

  // Anything the registry did not account for is matched the hard way: by launch
  // directory, newest transcript first. Two sessions started in one directory are
  // told apart only by recency, which is the one genuinely fuzzy step left.
  const accountedPids = new Set(described.filter((s) => s.pid).map((s) => s.pid));
  const leftover = pids.filter((p) => !accountedPids.has(p.pid));
  const claimed = new Set(described.filter((s) => s.pid).map((s) => s.sessionId));
  for (const p of leftover.sort((a, b) => a.uptimeSec - b.uptimeSec)) {
    const match = described.find((s) => !claimed.has(s.sessionId) && p.cwd
      && (s.cwd === p.cwd || s.cwdNow === p.cwd));
    if (match) {
      claimed.add(match.sessionId);
      match.pid = p.pid;
      match.uptimeSec = p.uptimeSec;
      match.etime = p.etime;
      match.viaProcessScan = true;
    }
  }
  const strandedPids = leftover.filter((p) => !described.some((s) => s.pid === p.pid));

  const ttyMap = await ttysFor(described.filter((s) => s.pid).map((s) => s.pid));
  for (const s of described) if (s.pid) s.tty = ttyMap[s.pid] || null;

  const now = Date.now();
  for (const s of described) {
    s.cwdShort = shortPath(s.cwd);
    const age = now - s.mtime;
    if (!s.pid) s.state = 'closed';
    // Only the registry can see a session halted on a permission or trust
    // prompt; from the transcript alone that is indistinguishable from a slow
    // tool call, so this check comes first.
    else if (s.reported === 'blocked') s.state = 'blocked';
    // The registry's own view of a finished turn beats inferring it from the
    // transcript, and it is right even before anything is written to disk.
    else if (s.reported === 'idle') s.state = age > PARK_MS ? 'parked' : 'waiting';
    else if (s.turn && s.turn.done) s.state = age > PARK_MS ? 'parked' : 'waiting';
    else if (s.reported === 'busy') s.state = 'working';
    else if (age > STALL_MS) s.state = 'stalled';
    else s.state = 'working';
    s.idleSec = Math.round(age / 1000);
  }

  const rank = { blocked: 0, waiting: 1, working: 2, stalled: 3, parked: 4, closed: 5 };
  described.sort((a, b) => (rank[a.state] - rank[b.state]) || (b.mtime - a.mtime));

  return {
    at: now,
    liveCount: described.filter((s) => s.pid).length,
    waitingCount: described.filter((s) => s.state === 'waiting' || s.state === 'blocked').length,
    // A live session the registry omitted is the failure this guards against:
    // without the scan it would be reported as closed, which is worse than noisy.
    source: registry ? (described.some((x) => x.viaProcessScan) ? 'registry+scan' : 'registry') : 'scan',
    registryMissed: described.filter((x) => x.viaProcessScan).length,
    headlessHidden: headlessCount,
    unmatchedPids: strandedPids.length,
    sessions: described,
  };
}

// A short brief of what a session has been doing, for handing to another one.
// Tool traffic is dropped: only the human's asks and the assistant's prose carry
// enough meaning to be worth another session's context window.
function digest(sessionId, maxChars = 6000, maxTurns = 14) {
  const row = allTranscripts()
    .map((r) => r.file)
    .find((f) => path.basename(f, '.jsonl') === sessionId);
  if (!row) return null;

  const entries = parseLines(readChunk(row, TAIL_BYTES, true));
  const turns = [];
  for (const e of entries) {
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (e.isSidechain) continue;
    const content = (e.message || {}).content;
    let text = null;
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim();
    }
    if (!text) continue;
    if (/^<(command-name|local-command|system-reminder)/.test(text)) continue;
    turns.push({ who: e.type === 'user' ? 'Human' : 'Claude', text: text.trim() });
  }

  const recent = turns.slice(-maxTurns);
  const out = [];
  let budget = maxChars;
  for (let i = recent.length - 1; i >= 0 && budget > 0; i--) {
    const t = recent[i];
    const body = t.text.length > 1200 ? t.text.slice(0, 1200) + ' […]' : t.text;
    const block = `${t.who}: ${body}`;
    budget -= block.length;
    out.unshift(block);
  }
  return out.join('\n\n') || null;
}

module.exports = { snapshot, digest };

if (require.main === module) {
  snapshot().then((s) => {
    console.log(`${s.liveCount} live, ${s.waitingCount} waiting on you, ${s.unmatchedPids} unmatched pid(s)\n`);
    for (const r of s.sessions.slice(0, 12)) {
      const tag = r.pid ? `pid ${r.pid} up ${r.etime}` : 'closed';
      console.log(`[${r.state.padEnd(7)}] ${r.title.slice(0, 54).padEnd(54)} ${tag}`);
      console.log(`           ${r.cwd || '?'}  idle ${r.idleSec}s  last ${r.turn ? r.turn.role + '/' + r.turn.kind : '?'}`);
    }
  });
}
