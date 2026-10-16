// The command line for every claude call the board makes on its own. It lives
// apart from main.js so tools/token-check.js can run exactly these arguments
// without starting Electron: a test that copied the flags would keep passing
// after main.js drifted away from them.

// Which model runs each kind of call. Without a --model these inherited
// whatever the user's default was, so making Opus the default quietly made
// every ask cost ~36x what Haiku charges for the same answer (measured
// 2026-10-15: $0.066 vs $0.0018). Ask and relay read an excerpt and summarise
// it, which is Haiku's job; chat is a conversation someone is actually
// steering, so it gets Sonnet unless the panel says otherwise.
const JOBS = {
  consult: { model: 'haiku', effort: 'low' },
  relay:   { model: 'haiku', effort: 'low' },
  chat:    { model: 'sonnet' },
};

// Each tool's definition rides in the prompt, and narrowing to the three
// read-only ones took the fixed cost of a call from ~17K tokens to ~6K. These
// calls run under -p with no permission mode, so anything that writes was
// being refused anyway.
const JOB_TOOLS = 'Read,Grep,Glob';

// Claude Code's own system prompt is written for a coding agent at a terminal
// and was half of what was left: measured 2026-10-16, a call costs 6.5K prompt
// tokens with it and 3.2K with this. Nothing in it applies to reading an
// excerpt and answering a question about it. The tool definitions still carry
// their own instructions, so Read/Grep/Glob work the same.
const SYSTEM_PROMPT = [
  'You run inside Session Board, a small desktop app that watches Claude Code',
  'sessions. You are asked about one of those sessions, usually from an excerpt',
  'of its conversation given in the message. You can read files in the',
  'session\'s working directory with Read, Grep and Glob; you cannot change',
  'anything. Answer briefly and specifically, in plain text that reads well in a',
  'narrow panel. Do not use em-dashes.',
].join(' ');

// Ten-odd MCP servers are configured on this machine; an empty config with
// --strict-mcp-config keeps every one of them, and their tool lists, out of
// the prompt (and avoids the trust prompt a fresh process otherwise hits in a
// project that has them).
const NO_MCP = ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];

function jobArgs(job, { prompt, resumeId, model }) {
  const spec = JOBS[job];
  const args = [];
  if (resumeId) args.push('--resume', resumeId);
  args.push(
    '--model', model || spec.model,
    '--tools', JOB_TOOLS,
    '--system-prompt', SYSTEM_PROMPT,
    ...NO_MCP,
    '--output-format', 'json',
  );
  if (spec.effort) args.push('--effort', spec.effort);
  args.push('-p', prompt);
  return args;
}

// The limits probe only exists to read the rate_limit_event that comes back
// with any response, so it asks the cheapest model the cheapest question with
// the smallest prompt that still works.
function probeArgs() {
  return [
    '--model', 'haiku',
    '--tools', 'Read',
    '--system-prompt', 'Reply with just: ok',
    ...NO_MCP,
    '--output-format', 'stream-json',
    '--verbose',
    // Without this every probe leaves a transcript behind: ~96 files a day
    // in ~/.claude/projects, each one more for the usage scan to read.
    '--no-session-persistence',
    '-p', 'Reply with just: ok',
  ];
}

module.exports = { JOBS, JOB_TOOLS, SYSTEM_PROMPT, jobArgs, probeArgs };
