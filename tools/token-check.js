// Checks that the board's own claude calls stay as cheap as they should, and
// that being cheap hasn't broken them. Run with `npm run check-tokens`.
//
// It runs the real claude binary with the exact arguments main.js uses (both
// come from src/jobs.js), so it spends a little usage: about a dozen small
// calls, mostly Haiku, roughly $0.03 at API prices. Four parts:
//
//   1. Overhead: each job's fixed cost, measured on a one-word prompt. This is
//      what every single ask/relay pays before any excerpt is added.
//   2. Answers: each job answers a question whose answer is only in a made-up
//      excerpt, so a trim that leaves calls cheap but useless fails here.
//   3. Savings left: tries each further trim on top of the current flags and
//      reports any that would still save a meaningful amount. New CLI
//      versions add flags and prompt text; this is where that shows up.
//   4. Real use: averages from the app's own usage log, so a job that has
//      grown expensive in practice (big excerpts) is visible.
//
// Exits non-zero when a budget or an answer check fails.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JOBS, jobArgs, probeArgs } = require('../src/jobs');

const CLAUDE = process.env.SB_CLAUDE_BIN || '/opt/homebrew/bin/claude';
// Fixed prompt tokens per call, with headroom over what was measured when the
// budget was set (2026-10-16: 3.2K for every job). Raise one only on purpose.
const OVERHEAD_BUDGET = 4000;
// A trim is worth reporting when it saves at least this much per call.
const WORTH_IT = 300;

// A scratch directory with nothing in it, so no project CLAUDE.md is pulled in
// and the test transcripts land somewhere of their own.
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-token-check-'));
fs.writeFileSync(path.join(CWD, 'notes.txt'), 'The deploy target is the staging-west cluster.\n');

let failed = 0;
const fail = (msg) => { failed++; console.log('  FAIL  ' + msg); };
const pass = (msg) => console.log('  ok    ' + msg);

function run(args) {
  const out = execFileSync(CLAUDE, args, { cwd: CWD, input: '', encoding: 'utf8', timeout: 120000, maxBuffer: 16 << 20 });
  const r = JSON.parse(out.trim());
  const u = r.usage || {};
  return {
    answer: (r.result || '').trim(),
    sessionId: r.session_id,
    prompt: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
    usd: r.total_cost_usd || 0,
  };
}
// The test's own calls never need a transcript.
const once = (args) => run([...args.slice(0, -2), '--no-session-persistence', ...args.slice(-2)]);

const EXCERPT = [
  'Here is a recent excerpt of a Claude Code conversation that ran in this directory.',
  '--- begin excerpt ---',
  'user: the login page times out after 30s, can you fix it',
  'assistant: The timeout comes from src/auth/session.ts, where REFRESH_MS is 30000. I raised it to 120000 and added a retry.',
  '--- end excerpt ---',
].join('\n');

let spent = 0;
const t0 = Date.now();

console.log('\n1. Fixed overhead per call (budget ' + OVERHEAD_BUDGET + ' prompt tokens)');
const overhead = {};
for (const job of Object.keys(JOBS)) {
  const r = once(jobArgs(job, { prompt: 'Reply with just: ok' }));
  spent += r.usd;
  overhead[job] = r.prompt;
  const line = `${job.padEnd(8)} ${String(r.prompt).padStart(6)} tokens on ${JOBS[job].model}`;
  r.prompt <= OVERHEAD_BUDGET ? pass(line) : fail(line + ' (over budget)');
}
{
  // The probe streams, so its usage comes from the result line.
  const out = execFileSync(CLAUDE, probeArgs(), { cwd: CWD, input: '', encoding: 'utf8', timeout: 120000, maxBuffer: 4 << 20 });
  let tokens = 0; let limits = false;
  for (const line of out.split('\n')) {
    if (line.includes('rate_limit_event')) limits = true;
    if (!line.includes('"type":"result"')) continue;
    try {
      const r = JSON.parse(line); const u = r.usage || {};
      tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      spent += r.total_cost_usd || 0;
    } catch { /* partial line */ }
  }
  const line = `probe    ${String(tokens).padStart(6)} tokens on haiku`;
  tokens && tokens <= OVERHEAD_BUDGET ? pass(line) : fail(line + (tokens ? ' (over budget)' : ' (no usage seen)'));
  limits ? pass('probe still returns the usage-limit reading') : fail('probe returned no rate_limit_event, so the limit bars would go blank');
}

console.log('\n2. Answers still right');
{
  const r = once(jobArgs('consult', { prompt: EXCERPT + '\n\nWhich file was changed, and to what value?' }));
  spent += r.usd;
  /session\.ts/.test(r.answer) && /120000|120,000|120 ?s/.test(r.answer)
    ? pass('ask reads the excerpt: ' + r.answer.slice(0, 70).replace(/\n/g, ' '))
    : fail('ask missed the excerpt: ' + r.answer.slice(0, 120));
}
{
  const r = once(jobArgs('consult', { prompt: 'Read notes.txt in this directory. What is the deploy target? One line.' }));
  spent += r.usd;
  /staging-west/.test(r.answer) ? pass('ask can still read live files with its tools') : fail('ask could not read a file: ' + r.answer.slice(0, 120));
}
{
  const r = once(jobArgs('relay', { prompt: 'Another Claude Code session sent this.\n' + EXCERPT + '\n\nIn one sentence, does the change look risky?' }));
  spent += r.usd;
  r.answer.length > 10 ? pass('relay answers') : fail('relay gave no answer');
  /—/.test(r.answer) ? fail('relay used an em-dash despite the system prompt') : pass('no em-dashes in answers');
}

console.log('\n3. Further trims that would still save tokens (on the ask job)');
{
  const base = jobArgs('consult', { prompt: 'Reply with just: ok' });
  const swap = (flag, value) => {
    const a = [...base]; const i = a.indexOf(flag);
    if (i === -1) return [...a.slice(0, -2), flag, value, ...a.slice(-2)];
    a[i + 1] = value; return a;
  };
  const trials = {
    // Names ending in "?" give something up; the rest would be free savings.
    'no tools at all: could no longer read files?': swap('--tools', ''),
    'only Read: could no longer search or find files by name?': swap('--tools', 'Read'),
    'skills turned off': [...base.slice(0, -2), '--disable-slash-commands', ...base.slice(-2)],
    'no user/project settings': [...base.slice(0, -2), '--setting-sources', '', ...base.slice(-2)],
  };
  let any = false;
  for (const [name, args] of Object.entries(trials)) {
    let r;
    try { r = once(args); } catch (e) { console.log(`        ${name}: failed to run`); continue; }
    spent += r.usd;
    const saved = overhead.consult - r.prompt;
    const tradeoff = name.endsWith('?');
    if (saved >= WORTH_IT && !tradeoff) { any = true; console.log(`  SAVE  ${String(saved).padStart(5)} tokens for free: ${name}`); }
    else if (saved >= WORTH_IT) console.log(`  trade ${String(saved).padStart(5)} tokens, but ${name.slice(0, -1)}`);
    else console.log(`        ${String(saved).padStart(5)} tokens: ${name}`);
  }
  console.log(any ? '        a free saving above is worth adding to src/jobs.js' : '        no free savings left; the trades above cost the jobs a capability');
}

console.log('\n4. Real use, from the app\'s usage log');
{
  const log = path.join(os.homedir(), 'Library', 'Application Support', 'session-board', 'usage.jsonl');
  let rows = [];
  try { rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { /* none yet */ }
  if (!rows.length) console.log('        no calls logged yet');
  const by = {};
  for (const r of rows) {
    const k = r.job + (r.resumed ? ' (follow-up)' : '');
    const b = by[k] || (by[k] = { n: 0, prompt: 0, usd: 0 });
    b.n++; b.prompt += (r.input || 0) + (r.cacheWrite || 0) + (r.cacheRead || 0); b.usd += r.usd || 0;
  }
  for (const [k, b] of Object.entries(by)) {
    console.log(`        ${k.padEnd(20)} ${String(b.n).padStart(4)} calls, avg ${Math.round(b.prompt / b.n).toString().padStart(6)} prompt tokens, $${(b.usd / b.n).toFixed(4)} each`);
  }
}

fs.rmSync(CWD, { recursive: true, force: true });
console.log(`\n${failed ? failed + ' check(s) failed' : 'all checks passed'}. This run used about $${spent.toFixed(3)} at API prices, ${Math.round((Date.now() - t0) / 1000)}s.\n`);
process.exit(failed ? 1 : 0);
