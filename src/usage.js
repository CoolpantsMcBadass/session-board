// Token and dollar totals across every Claude Code transcript on this machine,
// for the usage panel. DOM-free and electron-free, so it runs (and is tested)
// in plain node: `node src/usage.js` prints today / 7d / 30d.
//
// The dollars are what the same tokens would cost at API prices. On a Pro or
// Max subscription that is not what is billed, but it is still the right way
// to compare one session, model or project against another.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(os.homedir(), '.claude', 'projects');

// Per million tokens. Sources: the claude-api model reference, cached
// 2026-10-06. Writes are derived from input: 1.25x for the 5-minute cache,
// 2x for the 1-hour one. Checked against two calls whose exact cost the CLI
// reported itself (Opus 5.5 $0.0657692, Haiku 5.5 $0.00076723): both match.
// Opus 5's cache-read rate isn't listed there; it uses the standard 0.1x.
const PRICES = {
  'claude-opus-5-5':   { in: 4,    out: 20,   read: 0.20 },
  'claude-opus-5':     { in: 5,    out: 25,   read: 0.50 },
  'claude-sonnet-5-5': { in: 2,    out: 10,   read: 0.20 },
  'claude-sonnet-5':   { in: 2,    out: 10,   read: 0.20 },
  'claude-haiku-5-5':  { in: 0.10, out: 0.50, read: 0.01,
    // Haiku 5.5 charges 5x once a prompt passes 100K tokens.
    over: { at: 100000, in: 0.50, out: 2.50, read: 0.05 } },
  'claude-haiku-4-5':  { in: 1,    out: 5,    read: 0.10 },
};

function priceFor(model) {
  if (!model) return null;
  if (PRICES[model]) return PRICES[model];
  // Dated ids like claude-haiku-4-5-20251001 price as their family.
  const base = Object.keys(PRICES).find((k) => model.startsWith(k + '-'));
  return base ? PRICES[base] : null;
}

// One response's usage block in, dollars out; null for a model with no price
// (its tokens still count, its dollars are reported as unpriced).
function costOf(model, u) {
  const p0 = priceFor(model);
  if (!p0) return null;
  const cw = u.cache_creation || {};
  const w1h = cw.ephemeral_1h_input_tokens || 0;
  // Older lines carry only the total; treat any write not split out as 5m.
  const w5m = cw.ephemeral_5m_input_tokens != null
    ? cw.ephemeral_5m_input_tokens
    : Math.max(0, (u.cache_creation_input_tokens || 0) - w1h);
  const prompt = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const p = p0.over && prompt > p0.over.at ? p0.over : p0;
  return ((u.input_tokens || 0) * p.in
    + w5m * p.in * 1.25
    + w1h * p.in * 2
    + (u.cache_read_input_tokens || 0) * p.read
    + (u.output_tokens || 0) * p.out) / 1e6;
}

function dayOf(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d || isNaN(d)) return null;
  // Local calendar day, since "today" means the user's today.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Per-file state, kept between scans (and across restarts via save/load), so
// a scan only reads bytes appended since the last one. The first scan reads
// everything: ~2.4s for 364MB on this machine.
function freshEntry(born) {
  return { offset: 0, carry: '', lastId: null, cwd: null, cwds: {}, title: null, headless: false, born };
}

// Responses are counted once per message id across every file, not per file.
// `claude --resume <id> --fork-session` copies the parent's whole history into
// the fork's transcript, ids and usage included: measured 2026-10-15, forks
// made by the board's old ask/chat carried 295-365 of their parent's responses
// each, and 800 ids appeared in more than one file. Files are scanned oldest
// first, so the parent claims its own responses and a fork keeps only what it
// added.
function scanFile(file, size, e, seen) {
  if (size < e.offset) Object.assign(e, freshEntry(e.born));
  if (size <= e.offset) return;
  const fd = fs.openSync(file, 'r');
  let text;
  try {
    const buf = Buffer.alloc(size - e.offset);
    fs.readSync(fd, buf, 0, buf.length, e.offset);
    text = e.carry + buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  e.offset = size;
  const lastNL = text.lastIndexOf('\n');
  e.carry = lastNL === -1 ? text : text.slice(lastNL + 1);
  if (lastNL === -1) return;

  for (const line of text.slice(0, lastNL).split('\n')) {
    // Cheap substring tests first: most lines are tool output, and parsing
    // every one of them is most of what a full scan would cost.
    const isTitle = line.includes('"ai-title"');
    const hasUsage = line.includes('"usage"') && line.includes('"assistant"');
    const needHead = !e.cwd || (!e.headless && line.includes('"sdk-cli"'));
    if (!isTitle && !hasUsage && !needHead) continue;
    let x;
    try { x = JSON.parse(line); } catch { continue; }
    if (!e.cwd && x.cwd) e.cwd = x.cwd;
    if (x.entrypoint === 'sdk-cli') e.headless = true;
    if (x.type === 'ai-title' && x.aiTitle) e.title = x.aiTitle;
    if (x.type !== 'assistant' || !x.message || !x.message.usage) continue;
    // One response is also written once per content block, each copy carrying
    // the full usage; those copies are always consecutive.
    const id = x.message.id;
    if (id && id === e.lastId) continue;
    e.lastId = id || null;
    if (id && seen.has(id)) continue;
    const model = x.message.model;
    if (!model || model === '<synthetic>') continue;
    const day = dayOf(x.timestamp);
    if (!day) continue;
    // Where the shell was when this turn ran. Most sessions here are launched
    // from ~ and cd into a project, so the launch cwd alone would file nearly
    // everything under ~; the commonest working cwd says what the work was.
    if (x.cwd) e.cwds[x.cwd] = (e.cwds[x.cwd] || 0) + 1;
    const u = x.message.usage;
    const tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
    const usd = costOf(model, u);
    const rec = { f: file, day, model, tokens, usd: usd || 0, unpriced: usd == null ? tokens : 0 };
    seen.set(id || file + ':' + seen.size, rec);
  }
}

function transcripts() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT); } catch { return out; }
  for (const d of dirs) {
    const dir = path.join(ROOT, d);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) if (n.endsWith('.jsonl')) out.push(path.join(dir, n));
  }
  return out;
}

function createUsage(cacheFile) {
  let files = {};
  let seen = new Map();
  if (cacheFile) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c.v === 2) { files = c.files || {}; seen = new Map(c.seen || []); }
    } catch { /* no cache yet: the first scan builds it */ }
  }

  function scan() {
    const list = [];
    for (const f of transcripts()) {
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      if (!files[f]) files[f] = freshEntry(st.birthtimeMs || st.mtimeMs);
      list.push([f, st.size]);
    }
    list.sort((a, b) => files[a[0]].born - files[b[0]].born);
    for (const [f, size] of list) {
      try { scanFile(f, size, files[f], seen); } catch { /* unreadable this time: next scan retries */ }
    }
    // A transcript deleted since an earlier scan keeps its records, so its
    // spend stays in the totals: the money was still spent.
  }

  function save() {
    if (!cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ v: 2, files, seen: [...seen] }));
    } catch { /* a cache is a convenience */ }
  }

  function projectOf(e) {
    if (e.headless) return 'board & scripts (claude -p)';
    const home = os.homedir();
    const ranked = Object.entries(e.cwds || {}).sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const cwd = ranked.find((c) => c !== home) || ranked[0] || e.cwd;
    if (!cwd) return '(unknown)';
    return cwd === home ? '~' : path.basename(cwd);
  }

  // period: 'today' | '7d' | '30d' | 'all'
  function summary(period) {
    scan();
    save();
    const days = { today: 1, '7d': 7, '30d': 30 }[period];
    let since = null;
    if (days) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - (days - 1));
      since = dayOf(d);
    }
    const blank = () => ({ tokens: 0, usd: 0, unpriced: 0, turns: 0 });
    const add = (into, r) => {
      into.tokens += r.tokens; into.usd += r.usd; into.unpriced += r.unpriced; into.turns += 1;
    };
    const total = blank();
    const byModel = {};
    const byProject = {};
    const byFile = {};
    for (const r of seen.values()) {
      if (since && r.day < since) continue;
      add(total, r);
      add(byModel[r.model] || (byModel[r.model] = blank()), r);
      add(byFile[r.f] || (byFile[r.f] = blank()), r);
    }
    const bySession = [];
    for (const [file, s] of Object.entries(byFile)) {
      const e = files[file] || freshEntry(0);
      const project = projectOf(e);
      const p = byProject[project] || (byProject[project] = blank());
      p.tokens += s.tokens; p.usd += s.usd; p.unpriced += s.unpriced; p.turns += s.turns;
      bySession.push({
        sessionId: path.basename(file, '.jsonl'),
        title: e.title || '(untitled)',
        project,
        headless: e.headless,
        ...s,
      });
    }
    const rank = (obj) => Object.entries(obj).map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
    return {
      period,
      since,
      total,
      byModel: rank(byModel),
      byProject: rank(byProject),
      bySession: bySession.sort((a, b) => b.usd - a.usd || b.tokens - a.tokens).slice(0, 12),
      sessionCount: bySession.length,
    };
  }

  return { summary };
}

module.exports = { createUsage, costOf, PRICES };

if (require.main === module) {
  const u = createUsage(null);
  for (const p of ['today', '7d', '30d', 'all']) {
    const t0 = Date.now();
    const s = u.summary(p);
    console.log(`${p.padEnd(5)} $${s.total.usd.toFixed(2).padStart(8)}  ${(s.total.tokens / 1e6).toFixed(1).padStart(7)}M tok  ${s.total.turns} turns  ${s.sessionCount} sessions  (${Date.now() - t0}ms)`);
  }
  const s = u.summary('all');
  console.log('\nby model:'); for (const m of s.byModel) console.log(`  ${m.name.padEnd(28)} $${m.usd.toFixed(2)}${m.unpriced ? '  +' + m.unpriced + ' unpriced tok' : ''}`);
  console.log('\nby project:'); for (const m of s.byProject.slice(0, 8)) console.log(`  ${m.name.padEnd(28)} $${m.usd.toFixed(2)}`);
  console.log('\ntop sessions:'); for (const m of s.bySession.slice(0, 6)) console.log(`  $${m.usd.toFixed(2).padStart(7)}  ${m.title.slice(0, 50)}`);
}
