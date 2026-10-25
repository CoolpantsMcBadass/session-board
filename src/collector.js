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
// A ceiling on how far back the tail read will grow chasing the peer window.
// Reached only by a transcript with megabytes written inside two minutes, and
// at that point the session is noisy enough that one missed link does not
// matter more than the read does.
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const HEAD_BYTES = 96 * 1024;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const STALL_MS = 120 * 1000;
const PARK_MS = 30 * 60 * 1000;
const MAX_ROWS = 40;
// Which waitingFor values mean a modal gate rather than an ordinary pause.
// Matched loosely on purpose: the exact wording is the CLI's to change, and
// mistaking a gate for a pause is the expensive direction of that error.
const GATE_RE = /permission|trust|approve|confirm/i;
// How long after a message two sessions still count as working together. Peer
// traffic is bursty: a pair trade several messages in a few seconds and then go
// quiet while they each do the work, and treating that quiet as "finished"
// would end the collaboration mid-task.
//
// Six minutes rather than the two this started as, because two was a guess and
// the real traffic on this machine disagreed with it: across 109 gaps between
// consecutive peer messages, the median gap was about 176 seconds and a third
// ran past 2 minutes, some to half an hour. Two minutes was cutting off the
// median conversation. Six covers most of them without pretending a pair who
// stopped talking half an hour ago are still working together.
const PEER_WINDOW_MS = 6 * 60 * 1000;

// The head of a transcript is immutable, so its launch cwd is cached for good.
const headCache = new Map();

// Cumulative token spend for a live session: every assistant turn's usage
// summed over the session's whole life, not just what the tail read covers.
// A transcript on this machine runs to tens of MB, so summing it fresh every
// 2-second poll is not an option. Each file keeps its own cursor instead: the
// bytes already turned into a running total, and the undecoded tail that
// didn't yet end on a newline. A poll only ever reads what was appended since
// the last one, so the cost of this is one full-file read the first time a
// session is seen live, and a few hundred bytes on every poll after.
//
// Scoped to live sessions only (see snapshot()): a closed session's total is
// never going to change again and isn't worth the first-read cost to learn.
const usageCache = new Map();

function scanUsage(file, size) {
  let u = usageCache.get(file);
  if (!u) { u = { offset: 0, total: 0, context: null, carry: Buffer.alloc(0), lastId: null }; usageCache.set(file, u); }
  // The file is shorter than last time: not an append, but a different file
  // at the same path (a session id is never reused, so this shouldn't happen
  // in practice, but a stale cursor reading past the real end would throw).
  if (size < u.offset) { u.offset = 0; u.total = 0; u.context = null; u.carry = Buffer.alloc(0); u.lastId = null; }
  if (size <= u.offset) return u;

  const start = u.offset;
  const fd = fs.openSync(file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, size - start, start);
  } finally {
    fs.closeSync(fd);
  }
  // However this call ends, the bytes just read are not read again: anything
  // left incomplete is kept, decoded, in `carry`, not re-fetched from disk.
  u.offset = size;

  const chunk = Buffer.concat([u.carry, buf]);
  const lastNL = chunk.lastIndexOf(0x0a);
  if (lastNL === -1) { u.carry = chunk; return u; }
  u.carry = chunk.subarray(lastNL + 1);

  for (const line of chunk.subarray(0, lastNL + 1).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'assistant') continue;
    const usage = (e.message || {}).usage;
    if (!usage) continue;
    // One API response is written as one line per content block (thinking,
    // text, each tool call), and every one of those lines carries the whole
    // response's usage. Counting lines counted most turns two to five times:
    // measured 2026-10-15, 168 usage lines for 70 responses in one session.
    // The copies are always consecutive (0 exceptions in 11,784 lines across
    // every transcript on this machine), so the previous id is enough.
    const id = (e.message || {}).id;
    if (id && id === u.lastId) continue;
    u.lastId = id || null;
    const prompt = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
    // Every turn is its own billed API call, prompt and all, however much of
    // that prompt overlaps the turn before it: this is the sum Claude Code's
    // own cost accounting means by a session's total, not a token count of
    // unique content.
    u.total += prompt + (usage.output_tokens || 0);
    u.context = prompt;
  }
  return u;
}

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
      // Why a session cannot proceed, when the registry knows: "permission
      // prompt", "input needed" and so on. A status of 'waiting' without this
      // would only say that it has stopped, not that a human is the reason.
      waitingFor: a.waitingFor || null,
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

// Two sessions talking leaves a record on both sides, and they are not the same
// shape. The sender writes a SendMessage tool_use naming the peer by handle; the
// receiver gets a plain user turn wrapping the text in a cross-session-message
// tag whose `from` is the sender's unix socket, and that socket is named after
// the sender's pid. The pid is the better key of the two, because a pid matches
// the process table directly while a handle has to be looked up in a registry
// that does not always list every session.
const CROSS_RE = /<cross-session-message\s+from="uds:[^"]*?\/(\d+)\.sock"\s+from-name="([^"]*)"/;

function peerEventFrom(entry) {
  const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  if (!at) return null;
  const content = (entry.message || {}).content;

  if (entry.type === 'assistant' && Array.isArray(content)) {
    for (const b of content) {
      if (b && b.type === 'tool_use' && b.name === 'SendMessage' && b.input && b.input.to) {
        return { dir: 'out', at, to: String(b.input.to), summary: b.input.summary || null };
      }
    }
    return null;
  }

  if (entry.type === 'user' && typeof content === 'string') {
    const m = CROSS_RE.exec(content);
    if (m) return { dir: 'in', at, fromPid: Number(m[1]), fromName: m[2] || null };
  }
  return null;
}

// What a session is asking permission for. A tool_use is written the moment
// the agent decides to call the tool, before anyone approves it, and the
// matching tool_result only appears once it has run. So the newest tool_use
// with no result behind it is the thing on screen waiting for an answer.
//
// Only the shape is read, never anything that would be surprising to find in a
// panel: the tool's name and the one short field it uses to describe itself.
function pendingToolOf(entries) {
  const resolved = new Set();
  for (let i = entries.length - 1; i >= 0; i--) {
    const content = (entries[i].message || {}).content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || !b.type) continue;
      if (b.type === 'tool_result' && b.tool_use_id) resolved.add(b.tool_use_id);
      if (b.type === 'tool_use' && b.id && !resolved.has(b.id)) {
        const inp = b.input || {};
        const what = inp.description || inp.command || inp.file_path || inp.path || inp.pattern || '';
        return { name: b.name || 'a tool', what: String(what).replace(/\s+/g, ' ').trim().slice(0, 120) };
      }
    }
  }
  return null;
}

function lastBlockKind(entry) {
  const content = (entry.message || {}).content;
  if (typeof content === 'string') return 'str';
  if (!Array.isArray(content) || !content.length) return null;
  const last = content[content.length - 1];
  return last && last.type ? last.type : null;
}

// A fixed-size tail is enough for the title, the cwd and the turn state, all of
// which are at the very end of the file. It is not enough for peer messages: a
// single oversized entry written after one, a large tool_result say, can push a
// five-second-old message clean out of a 256KB slice, and the slice is taken in
// raw bytes before anything is parsed, so no amount of filtering downstream can
// get it back. The read grows until it has actually covered the window.
function readTailCovering(file, cutoff) {
  let bytes = TAIL_BYTES;
  for (;;) {
    const chunk = readChunk(file, bytes, true);
    const entries = parseLines(chunk);
    // The whole file is in hand, so there is nothing further back to find.
    if (!chunk.partialFirstLine) return entries;
    if (bytes >= MAX_TAIL_BYTES) return entries;
    // The oldest entry read is still inside the window, so an older one that
    // also counts may be sitting just behind the cut.
    const oldest = entries.find((e) => e.timestamp && Date.parse(e.timestamp));
    if (oldest && Date.parse(oldest.timestamp) < cutoff) return entries;
    bytes *= 2;
  }
}

// Walk a transcript's tail backwards for the newest title, cwd and turn state.
function describe(file) {
  const st = fs.statSync(file);
  const entries = readTailCovering(file, Date.now() - PEER_WINDOW_MS);
  let title = null;
  let cwd = null;
  let turn = null;
  // The newest assistant turn's own usage block: input_tokens plus both cache
  // fields is exactly what that API call sent as the prompt, which is the
  // context window's current fill. Walking backward for title/cwd/turn
  // already passes this same entry, so it costs nothing extra to also keep.
  let usage = null;
  let model = null;
  const peerEvents = [];
  const cutoff = Date.now() - PEER_WINDOW_MS;
  let pastWindow = false;


  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!pastWindow) {
      const ev = peerEventFrom(e);
      if (ev && ev.at >= cutoff) peerEvents.push(ev);
      // Entries are in order, so the first one older than the window means
      // every entry behind it is older too and none of them can still count.
      if (e.timestamp) {
        const t = Date.parse(e.timestamp);
        if (t && t < cutoff) pastWindow = true;
      }
    }
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
    if (!usage && e.type === 'assistant') {
      const u = (e.message || {}).usage;
      if (u) { usage = u; model = (e.message || {}).model || null; }
    }
    // The peer walk has its own stopping point, so the usual one is not
    // enough on its own any more.
    if (title && cwd && turn && usage && pastWindow) break;
  }
  const contextTokens = usage
    ? (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)
    : null;

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
    pendingTool: pendingToolOf(entries),
    peerEvents,
    contextTokens,
    // The model of the newest turn, e.g. claude-opus-5-5. A handoff starts its
    // successor on the same tier unless told otherwise.
    model,
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

// ignorePids lets the app leave out the `claude` processes it started itself.
// Nothing in a fork's own record distinguishes it from a session a person
// opened: the registry calls it interactive like any other, so the caller that
// spawned it is the only one who can say.
async function snapshot(opts = {}) {
  const ignorePids = opts.ignorePids || new Set();
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
      row.waitingFor = a.waitingFor;
      // When the session was opened, which is what decides the board's first
      // session, the one docked when the board opens.
      row.startedAt = a.startedAt || null;
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
      match.startedAt = Date.now() - p.uptimeSec * 1000;
      match.viaProcessScan = true;
    }
  }
  const strandedPids = leftover.filter((p) => !described.some((s) => s.pid === p.pid)
    && !ignorePids.has(p.pid));
  // Dropped after matching rather than before, so a fork cannot be mistaken for
  // the session it was forked from and quietly claim its row.
  for (let i = described.length - 1; i >= 0; i--) {
    if (described[i].pid && ignorePids.has(described[i].pid)) described.splice(i, 1);
  }

  const ttyMap = await ttysFor(described.filter((s) => s.pid).map((s) => s.pid));
  for (const s of described) if (s.pid) s.tty = ttyMap[s.pid] || null;

  // Cumulative spend, live sessions only: see scanUsage()'s own comment for
  // why a closed session is never worth the first-read cost.
  for (const s of described) {
    if (!s.pid || !s.file) continue;
    let size;
    try { size = fs.statSync(s.file).size; } catch { continue; }
    const u = scanUsage(s.file, size);
    s.totalTokens = u.total || null;
    // The tail read in describe() usually already has the newest turn, but a
    // session that just started or whose newest turn fell outside that read
    // has nothing there yet; the full-file scan has seen everything, so it
    // wins when describe() came back empty.
    if (s.contextTokens == null) s.contextTokens = u.context;
  }

  const now = Date.now();
  for (const s of described) {
    s.cwdShort = shortPath(s.cwd);
    const age = now - s.mtime;
    if (!s.pid) s.state = 'closed';
    // Only the registry can see a session halted on a permission or trust
    // prompt; from the transcript alone that is indistinguishable from a slow
    // tool call, so this check comes first.
    else if (s.reported === 'blocked') s.state = 'blocked';
    // 'waiting' from the registry means the session has stopped and a person is
    // the reason, and waitingFor says which kind. A permission or trust prompt
    // is a gate: nothing happens until someone answers the menu on screen, and
    // hiding that window would strand the session for good. Anything else is an
    // ordinary pause for the next instruction, which is every peer's resting
    // state and must not paint as an emergency.
    //
    // Until this branch existed, 'waiting' matched none of them: it fell past
    // every test to 'working', then to 'stalled' two minutes later. A session
    // sitting on a permission prompt looked busy, the "waiting on you" count
    // never saw it, and the office would have hidden its window quite happily.
    else if (s.reported === 'waiting') {
      s.state = GATE_RE.test(s.waitingFor || '') ? 'blocked'
        : (age > PARK_MS ? 'parked' : 'waiting');
    }
    // The registry's own view of a finished turn beats inferring it from the
    // transcript, and it is right even before anything is written to disk.
    else if (s.reported === 'idle') s.state = age > PARK_MS ? 'parked' : 'waiting';
    else if (s.turn && s.turn.done) s.state = age > PARK_MS ? 'parked' : 'waiting';
    else if (s.reported === 'busy') s.state = 'working';
    else if (age > STALL_MS) s.state = 'stalled';
    else s.state = 'working';
    s.idleSec = Math.round(age / 1000);
  }

  // Resolve each side's half of a conversation into one list of who is talking
  // to whom. Both sides record the same message, so the pair key collapses them
  // into a single link rather than two.
  const byPeerName = new Map();
  const byPid = new Map();
  for (const x of described) {
    if (x.peerName) byPeerName.set(x.peerName, x.sessionId);
    if (x.pid) byPid.set(x.pid, x.sessionId);
  }
  const linkMap = new Map();
  for (const x of described) {
    for (const ev of x.peerEvents || []) {
      if (now - ev.at > PEER_WINDOW_MS) continue;
      // Direction is kept, not just the pair, so a view can tell which side
      // opened the conversation from the side that was contacted. This file is
      // shared by every view and should not know what any of them draw.
      const a = ev.dir === 'out' ? x.sessionId : (byPid.get(ev.fromPid) || byPeerName.get(ev.fromName));
      const b = ev.dir === 'out' ? byPeerName.get(ev.to) : x.sessionId;
      // A session whose partner is not on the board (closed, or never matched
      // to a pid) has nobody to walk to, so the link is dropped rather than
      // left dangling.
      if (!a || !b || a === b) continue;
      const key = a + '>' + b;
      const prev = linkMap.get(key);
      if (!prev || ev.at > prev.at) {
        linkMap.set(key, { a, b, at: ev.at, summary: ev.summary || (prev && prev.summary) || null });
      }
    }
  }
  const links = [...linkMap.values()].sort((p, q) => q.at - p.at);
  // The per-session event lists have done their job and are bulky; the links
  // are what the views actually want.
  for (const x of described) delete x.peerEvents;

  const rank = { blocked: 0, waiting: 1, working: 2, stalled: 3, parked: 4, closed: 5 };
  described.sort((a, b) => (rank[a.state] - rank[b.state]) || (b.mtime - a.mtime));

  return {
    at: now,
    links,
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
function digest(sessionId, maxChars = 6000, maxTurns = 14, preread = null) {
  let entries = preread;
  if (!entries) {
    const row = allTranscripts()
      .map((r) => r.file)
      .find((f) => path.basename(f, '.jsonl') === sessionId);
    if (!row) return null;
    entries = parseLines(readChunk(row, TAIL_BYTES, true));
  }
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

// What a fresh session needs to carry on from one whose context has grown
// expensive. Unlike digest(), which is read on every ask and must stay small,
// this runs once per handoff, so it reads further back: a tool-heavy session's
// last 256KB can hold only a few hundred characters of prose, which is not
// enough to continue anyone's work from.
//
// Three parts, cheapest to most useful: the session's opening request (what the
// work is for), the files it wrote or edited most recently (where the work is),
// and the recent conversation (where it stands). The successor reads the files
// themselves; the brief only has to point at them.
const HANDOFF_TAIL_BYTES = 4 * 1024 * 1024;

function handoffBrief(sessionId) {
  const file = allTranscripts()
    .map((r) => r.file)
    .find((f) => path.basename(f, '.jsonl') === sessionId);
  if (!file) return null;

  let opening = null;
  let cwd = null;
  // The opening request can sit behind several hundred KB of attached context
  // at the head of a file, well past the 96KB the poll reads; one handoff can
  // afford the larger read.
  for (const e of parseLines(readChunk(file, 1024 * 1024, false))) {
    if (!cwd && e.cwd) cwd = e.cwd;
    if (opening || e.type !== 'user' || e.isSidechain) continue;
    const c = (e.message || {}).content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
    if (text && !/^<(command-name|local-command|system-reminder|local-command-caveat)/.test(text.trim())) {
      opening = text.trim().slice(0, 2000);
    }
  }

  const entries = parseLines(readChunk(file, HANDOFF_TAIL_BYTES, true));
  const touched = new Map(); // path -> 'edited' | 'read', newest last
  for (const e of entries) {
    if (e.type !== 'assistant' || e.isSidechain) continue;
    for (const b of ((e.message || {}).content || [])) {
      if (!b || b.type !== 'tool_use' || !b.input) continue;
      const p = b.input.file_path || b.input.notebook_path;
      if (!p) continue;
      const wrote = /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name);
      const was = touched.get(p);
      touched.delete(p);
      touched.set(p, wrote || was === 'edited' ? 'edited' : 'read');
    }
  }
  const files = [...touched].reverse();
  const edited = files.filter(([, k]) => k === 'edited').slice(0, 15).map(([p]) => p);
  const read = files.filter(([, k]) => k === 'read').slice(0, 10).map(([p]) => p);

  const recent = digest(sessionId, 16000, 40, entries);
  return { cwd, opening, edited, read, recent };
}

module.exports = { snapshot, digest, handoffBrief };

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
