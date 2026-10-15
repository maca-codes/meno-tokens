// PreToolUse on Read: stops two common wastes, each with a one-time "are you sure".
// 1. Reading a big file whole, when a range or a Grep would do.
// 2. Re-reading a file that is already in context and has not changed since.
// Repeating the exact same call goes through, so the model is never stuck.
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const SKIP_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svg|pdf|ipynb)$/i;

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

// Second identical call: the model insists, let it through.
// The saving logged at deny time is taken back, so the report stays honest.
if (st.pending[key]) {
  const back = st.pending[key];
  delete st.pending[key];
  lib.saveState(input, st);
  lib.logEvent(input, 'override', -back.chars, { file: path.basename(p) });
  lib.out(null);
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

// Re-read: same file, unchanged, and the earlier read covered this range.
const prev = st.reads[p];
if (prev && prev.mtime === s.mtimeMs && prev.size === s.size) {
  const prevEnd = prev.limit ? prev.offset + prev.limit : Infinity;
  const end = limit ? offset + limit : Infinity;
  const covered = offset >= prev.offset && end <= prevEnd;
  if (covered) {
    const est = limit ? Math.min(s.size, limit * 60) : s.size;
    deny(`${path.basename(p)} is unchanged since you read it earlier in this session; use the copy already in context. ` +
      'If that copy is gone (e.g. after compaction), repeat this exact call.', 'reread', est);
  }
}

// Whole read of a big file.
if (!limit && s.size > cfg.readMaxBytes) {
  let lines = 0;
  try { lines = fs.readFileSync(p, 'utf8').split('\n').length; } catch {}
  if (lines > cfg.readMaxLines || s.size > cfg.readMaxBytes * 2) {
    deny(`${path.basename(p)} is big (${lines} lines, ~${lib.tokens(s.size)} tokens). ` +
      'Grep for what you need, then Read with offset/limit. If you really need the whole file, repeat this exact call.',
      'bigread', lines > 2000 ? Math.round(s.size * 2000 / lines) : s.size); // Read returns 2000 lines at most
  }
}

lib.out(null);
