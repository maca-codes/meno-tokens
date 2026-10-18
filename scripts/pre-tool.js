// PreToolUse on Read: stops two common wastes, each with a one-time "are you sure".
// 1. Reading a big file whole, when a range or a Grep would do.
// 2. Re-reading a file that is already in context and has not changed since.
// Repeating the exact same call goes through, so the model is never stuck.
// Reads that go through are recorded here (no PostToolUse hook on Read: one process
// per Read instead of two). A read of a saved full output takes its saving back.
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const SKIP_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svg|pdf|ipynb)$/i;
const READ_MAX = 2000; // Read returns 2000 lines at most when no limit is given

const input = lib.readStdin();
if (input.tool_name !== 'Read') lib.out(null);
const cfg = lib.config();
const ti = input.tool_input || {};
const p = lib.resolvePath(ti.file_path, input.cwd);
if (!p || SKIP_EXT.test(p) || lib.isProtected(p, cfg)) lib.out(null);

let s;
try { s = fs.statSync(p); } catch { lib.out(null); }
if (!s.isFile()) lib.out(null);

const st = lib.loadState(input);
const offset = ti.offset || 0, limit = ti.limit || 0;
const key = lib.hash([p, s.mtimeMs, s.size, offset, limit].join('|'));

// Parts of this file already read in this session (the file unchanged since).
const prev = st.reads[p];
const ranges = prev && prev.mtime === s.mtimeMs && prev.size === s.size
  ? (prev.ranges || [[prev.offset || 0, (prev.offset || 0) + (prev.limit || READ_MAX)]]) : [];
const start = offset, end = offset + (limit || READ_MAX);

// Lets the call through and records what it covers, for the re-read check.
function allow() {
  st.reads[p] = { mtime: s.mtimeMs, size: s.size, ranges: ranges.concat([[start, end]]).slice(-10) };
  lib.saveState(input, st);
  lib.out(null);
}

// A saved full output: the model chose to open it, so it is never blocked, and what
// it reads is no longer a saving (trims live on the main session, see post-tool.js).
const back = lib.savedOutput(p);
if (back) {
  const main = lib.mainOf(input);
  const ms = lib.loadState(main);
  const saved = (ms.trims || {})[back];
  if (saved) {
    const chars = limit ? Math.min(s.size, limit * 80) : s.size;
    const take = Math.min(saved, chars);
    ms.trims[back] = saved - take;
    lib.saveState(main, ms);
    lib.logEvent(input, 'readback', -take, { file: back });
  }
  if (cfg.readGuard) allow();
  lib.out(null);
}

// The guards below are off by default: in real use the model repeated nearly every
// blocked read, so a block cost one extra round trip and saved nothing.
if (!cfg.readGuard) lib.out(null);

// Second identical call: the model insists, let it through.
// The saving logged at deny time is taken back, so the report stays honest.
if (st.pending[key]) {
  const prevDeny = st.pending[key];
  delete st.pending[key];
  lib.logEvent(input, 'override', -prevDeny.chars, { file: path.basename(p) });
  allow();
}

function deny(reason, kind, savedChars) {
  st.pending[key] = { ts: Date.now(), chars: savedChars };
  lib.saveState(input, st);
  lib.logEvent(input, kind, savedChars, { file: path.basename(p) });
  lib.out({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: '[token-diet] ' + reason,
    },
  });
}

// Re-read: same file, unchanged, and an earlier read covered this range.
if (ranges.some(([a, b]) => start >= a && end <= b)) {
  const est = limit ? Math.min(s.size, limit * 60) : s.size;
  deny(`${path.basename(p)} is unchanged since you read it earlier in this session; use the copy already in context. ` +
    'If that copy is gone (e.g. after compaction), repeat this exact call.', 'reread', est);
}

// Whole read of a big file. Very big files are judged by size alone, without loading them.
if (!limit && s.size > cfg.readMaxBytes) {
  let lines = 0;
  if (s.size <= cfg.readMaxBytes * 2) {
    try { lines = fs.readFileSync(p, 'utf8').split('\n').length; } catch {}
  }
  if (!lines || lines > cfg.readMaxLines) {
    const shown = lines ? `${lines} lines, ` : '';
    // Half the read is counted: the model still Greps and reads the part it needs.
    const full = lines > READ_MAX ? Math.round(s.size * READ_MAX / lines) : s.size;
    deny(`${path.basename(p)} is big (${shown}~${lib.tokens(s.size)} tokens). ` +
      'Grep for what you need, then Read with offset/limit. If you really need the whole file, repeat this exact call.',
      'bigread', Math.round(full / 2));
  }
}

allow();
