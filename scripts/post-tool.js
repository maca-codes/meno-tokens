// PostToolUse: trims long Bash/PowerShell/Grep output before it reaches the model,
// keeping head, tail and error lines. The full output is saved to a file the model can open.
// Also records successful Reads so pre-tool.js can spot re-reads of unchanged files,
// and flags a shell command that keeps returning the same output (loop).
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const KEY_LINE = /error|fail|exception|traceback|panic|fatal|denied|not found|warn|cannot|unable|✗|×/i;

function cutLine(line, max) {
  return line.length > max ? line.slice(0, max) + ` …[+${line.length - max} chars]` : line;
}

// Returns the trimmed text, or null when the text is already small enough.
function trim(text, cfg) {
  if (!text || text.length <= cfg.trimMaxChars) return null;
  const lines = text.split('\n');
  const H = cfg.trimHeadLines, T = cfg.trimTailLines;
  let kept;
  if (lines.length <= H + T) {
    kept = lines.map((l) => cutLine(l, cfg.maxLineChars));
  } else {
    const middle = [];
    for (let i = H; i < lines.length - T && middle.length < cfg.trimKeyLines; i++) {
      if (KEY_LINE.test(lines[i])) middle.push(`${i + 1}: ${lines[i]}`);
    }
    const omitted = lines.length - H - T;
    kept = [
      ...lines.slice(0, H),
      `… [${omitted} lines omitted` + (middle.length ? `; ${middle.length} error/warning lines from them below` : '') + ']',
      ...middle,
      ...(middle.length ? ['…'] : []),
      ...lines.slice(-T),
    ].map((l) => cutLine(l, cfg.maxLineChars));
  }
  let res = kept.join('\n');
  // Still too big (few but huge lines): hard cut, keeping both ends.
  const hard = cfg.trimMaxChars * 1.5;
  if (res.length > hard) res = res.slice(0, hard * 0.6) + '\n… [cut] …\n' + res.slice(-hard * 0.4);
  return res.length < text.length ? res : null;
}

function saveFull(input, text) {
  const dir = path.join(lib.dataDir(), 'out');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, (input.tool_use_id || lib.hash(text)).replace(/[^\w-]/g, '_') + '.txt');
  fs.writeFileSync(file, text);
  return file;
}

function note(file, before, after) {
  return `\n[token-diet] Output trimmed, ~${lib.tokens(before - after)} tokens saved. ` +
    `Full output: ${file} (Grep it, or Read with offset/limit).`;
}

function wantsFull(cmd) {
  return /#\s*full\s*$/m.test(cmd || '');
}

const input = lib.readStdin();
const cfg = lib.config();
const tool = input.tool_name;
const res = input.tool_response;

if (tool === 'Read') {
  const p = lib.resolvePath(input.tool_input && input.tool_input.file_path, input.cwd);
  try {
    const s = fs.statSync(p);
    const st = lib.loadState(input);
    const ti = input.tool_input || {};
    st.reads[p] = { mtime: s.mtimeMs, size: s.size, offset: ti.offset || 0, limit: ti.limit || 0 };
    lib.saveState(input, st);
  } catch {}
  lib.out(null);
}

// Same command with the same output again and again: the model is looping.
function withLoop(obj, loop) {
  if (!loop) return obj;
  obj = obj || { hookSpecificOutput: { hookEventName: 'PostToolUse' } };
  obj.hookSpecificOutput.additionalContext = loop.model;
  obj.systemMessage = loop.user;
  return obj;
}

if ((tool === 'Bash' || tool === 'PowerShell') && res && !res.isImage) {
  const cmd = String((input.tool_input && input.tool_input.command) || '');
  const so = String(res.stdout || ''), se = String(res.stderr || '');
  // Only outputs that report a problem: a build that keeps succeeding is not a loop.
  const loop = KEY_LINE.test(so + se) ? lib.checkLoop(input, `${tool}\n${cmd}\n${so}\n${se}`) : null;
  if (wantsFull(cmd)) lib.out(withLoop(null, loop));
  const tso = trim(so, cfg), tse = trim(se, cfg);
  if (tso === null && tse === null) lib.out(withLoop(null, loop));
  const file = saveFull(input, so + (se ? '\n--- stderr ---\n' + se : ''));
  const before = so.length + se.length;
  const nso = tso === null ? so : tso, nse = tse === null ? se : tse;
  const n = note(file, before, nso.length + nse.length);
  lib.logEvent(input, 'trim', before - nso.length - nse.length, { tool });
  lib.out(withLoop({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: Object.assign({}, res, tso !== null ? { stdout: nso + n } : { stdout: nso }, { stderr: tso === null ? nse + n : nse }),
    },
  }, loop));
}

if (tool === 'Grep' && res && typeof res.content === 'string') {
  const t = trim(res.content, cfg);
  if (t === null) lib.out(null);
  const file = saveFull(input, res.content);
  lib.logEvent(input, 'trim', res.content.length - t.length, { tool });
  lib.out({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: Object.assign({}, res, { content: t + note(file, res.content.length, t.length) }),
    },
  });
}

lib.out(null);
