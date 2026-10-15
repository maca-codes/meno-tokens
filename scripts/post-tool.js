// PostToolUse: trims long Bash/PowerShell/Grep output before it reaches the model.
// How it trims depends on what the output is: a file listing is summarised by folder,
// JSON by its structure, a diff by its files, anything else keeps head, tail and the
// error lines in between. The full output is saved to a file the model can open.
// Also flags a shell command that keeps returning the same problem (loop), takes back
// the saving when the model reads a saved output again, and records steps towards
// fixing earlier failures (errcache.js).
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const KEY_LINE = /error|fail|exception|traceback|panic|fatal|denied|not found|warn|cannot|unable|✗|×/i;

function cutLine(line, max) {
  return line.length > max ? line.slice(0, max) + ` …[+${line.length - max} chars]` : line;
}

// Head, tail and error lines from the middle: right for logs, builds and tests.
function headTail(text, cfg, limit) {
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
  const hard = limit * 1.5;
  if (res.length > hard) res = res.slice(0, hard * 0.6) + '\n… [cut] …\n' + res.slice(-hard * 0.4);
  return res;
}

// A file listing (find, ls -R, dir /s, Get-ChildItem -Recurse): order does not matter and
// the useful part is often in the middle, so every folder is kept with its file count
// and the first names.
const LIST_CMD = /(^|[;&|(]\s*)(find|fd|ls|tree|dir|gci|get-childitem|rg\s+--files|git\s+ls-files)\b/i;
function listing(text, cmd) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const pathy = lines.filter((l) => /[\\/]/.test(l) && l.length < 300 && !/\s{3,}/.test(l)).length;
  if (!(LIST_CMD.test(cmd || '') && pathy > lines.length * 0.6) && pathy < lines.length * 0.9) return null;
  const dirs = new Map();
  for (const l of lines) {
    const m = /^(.*[\\/])([^\\/]*)$/.exec(l);
    const dir = m ? m[1] : './', name = m ? m[2] || '(folder)' : l;
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push(name);
  }
  const out = [`[${lines.length} entries in ${dirs.size} folders — listing summarised by folder]`];
  for (const [dir, names] of dirs) {
    const show = names.slice(0, 6).join(', ');
    out.push(names.length > 6 ? `${dir} (${names.length}): ${show}, … +${names.length - 6}` : `${dir} (${names.length}): ${show}`);
  }
  return out.join('\n');
}

// JSON: its structure (keys, types, array sizes) plus the start of the text.
function jsonOutline(text, cfg) {
  const s = text.trim();
  if (!/^[[{]/.test(s)) return null;
  let j;
  try { j = JSON.parse(s); } catch { return null; }
  const lines = [];
  const walk = (v, key, depth) => {
    if (lines.length > 120) return;
    const pad = '  '.repeat(depth);
    if (Array.isArray(v)) {
      lines.push(`${pad}${key}: array[${v.length}]`);
      if (v.length && depth < 3) walk(v[0], '[0]', depth + 1);
    } else if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      lines.push(`${pad}${key}: object{${keys.length}}`);
      if (depth < 3) for (const k of keys.slice(0, 40)) walk(v[k], k, depth + 1);
    } else {
      lines.push(`${pad}${key}: ${cutLine(JSON.stringify(v), 80)}`);
    }
  };
  walk(j, '(root)', 0);
  return `[JSON, ${s.length} chars — structure below, then the first part]\n` + lines.join('\n') +
    '\n--- start ---\n' + cutLine(s, Math.min(4000, cfg.trimMaxChars / 4));
}

// Diff: every file with its +/- counts, then as much of the diff as fits.
function diffOutline(text, limit) {
  if (!/^diff --git /m.test(text)) return null;
  const files = [];
  let cur = null;
  for (const l of text.split('\n')) {
    if (l.startsWith('diff --git ')) { cur = { name: l.replace(/^diff --git a\/(\S+) b\/.*$/, '$1'), add: 0, del: 0 }; files.push(cur); }
    else if (cur && l.startsWith('+') && !l.startsWith('+++')) cur.add++;
    else if (cur && l.startsWith('-') && !l.startsWith('---')) cur.del++;
  }
  const head = files.map((f) => `  ${f.name}  +${f.add} -${f.del}`).join('\n');
  const room = Math.max(2000, limit - head.length - 200);
  return `[diff of ${files.length} files — summary, then the start of the diff]\n${head}\n--- start ---\n` + text.slice(0, room);
}

// Returns the trimmed text, or null when the text is small enough (or would not get smaller).
function trim(text, cfg, cmd, limit) {
  if (!text || text.length <= limit) return null;
  const res = listing(text, cmd) || jsonOutline(text, cfg) || diffOutline(text, limit) || headTail(text, cfg, limit);
  const capped = res.length > limit * 1.5 ? headTail(res, cfg, limit) : res;
  return capped.length < text.length * 0.8 ? capped : null;
}

function saveFull(input, text) {
  const dir = lib.outDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, (input.tool_use_id || lib.hash(text)).replace(/[^\w-]/g, '_') + '.txt');
  fs.writeFileSync(file, lib.maskSecrets(text));
  return file;
}

function note(file, before, after) {
  return `\n[token-diet] Output trimmed, ~${lib.tokens(before - after)} tokens saved. ` +
    `Full output: ${file} (Grep it, or Read with offset/limit).`;
}

const wantsFull = (cmd) => /#\s*full\s*$/m.test(cmd || '');

// Remembers each trim, so a later read of the saved file can take the saving back.
function rememberTrim(input, file, saved) {
  const st = lib.loadState(input);
  st.trims = st.trims || {};
  st.trims[path.basename(file)] = saved;
  const names = Object.keys(st.trims);
  if (names.length > 50) delete st.trims[names[0]];
  lib.saveState(input, st);
}

// The model opened a saved output again: what it reads now is no longer saved.
function readBack(input, name, chars) {
  const st = lib.loadState(input);
  const saved = (st.trims || {})[name];
  if (!saved) return;
  const back = Math.min(saved, chars);
  st.trims[name] = saved - back;
  lib.saveState(input, st);
  lib.logEvent(input, 'readback', -back, { file: name });
}

const input = lib.readStdin();
const cfg = lib.config();
const tool = input.tool_name;
const res = input.tool_response;

// A success may be a step towards fixing an earlier failure, or the fix itself.
// The error memory is loaded only when a failure is waiting for its fix.
if ((lib.loadState(input).cases || []).length) require('./errcache').onSuccess(input);

// Same command with the same problem again and again: the model is looping.
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
  let loop = null;
  if (lib.hasProblem(so + se)) loop = lib.checkLoop(input, `${tool}\n${cmd}\n${so}\n${se}`);
  else lib.breakLoop(input);
  // Reading a saved output again: never trimmed again, and its saving is taken back.
  const back = lib.savedOutput(cmd);
  if (back) { readBack(input, back, so.length + se.length); lib.out(withLoop(null, loop)); }
  if (wantsFull(cmd) || lib.isProtected(cmd, cfg)) lib.out(withLoop(null, loop));
  // Output already compacted by RTK gets a higher threshold, so it is not cut twice.
  const limit = /^\s*rtk\b/.test(cmd) ? cfg.trimMaxChars * 2 : cfg.trimMaxChars;
  const tso = trim(so, cfg, cmd, limit), tse = trim(se, cfg, cmd, limit);
  if (tso === null && tse === null) lib.out(withLoop(null, loop));
  const file = saveFull(input, so + (se ? '\n--- stderr ---\n' + se : ''));
  const before = so.length + se.length;
  const nso = tso === null ? so : tso, nse = tse === null ? se : tse;
  const n = note(file, before, nso.length + nse.length);
  const saved = before - nso.length - nse.length - n.length;
  lib.logEvent(input, 'trim', saved, { tool, file: path.basename(file) });
  rememberTrim(input, file, saved);
  lib.out(withLoop({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: Object.assign({}, res, tso !== null ? { stdout: nso + n } : { stdout: nso }, { stderr: tso === null ? nse + n : nse }),
    },
  }, loop));
}

if (tool === 'Grep' && res && typeof res.content === 'string') {
  const where = input.tool_input && input.tool_input.path;
  const back = lib.savedOutput(where);
  if (back) { readBack(input, back, res.content.length); lib.out(null); }
  if (lib.isProtected(where, cfg)) lib.out(null);
  const t = trim(res.content, cfg, '', cfg.trimMaxChars);
  if (t === null) lib.out(null);
  const file = saveFull(input, res.content);
  const n = note(file, res.content.length, t.length);
  const saved = res.content.length - t.length - n.length;
  lib.logEvent(input, 'trim', saved, { tool, file: path.basename(file) });
  rememberTrim(input, file, saved);
  lib.out({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: Object.assign({}, res, { content: t + n }),
    },
  });
}

lib.out(null);
