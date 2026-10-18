// Shared helpers for Meno hooks. No dependencies: Node built-ins only.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// A hook must never break Claude Code: on any unexpected error, exit quietly and
// let the tool result through unchanged. The error is written to errors.log, so a
// feature that stops working shows up in the report instead of looking like "nothing to do".
process.on('uncaughtException', (e) => { logError(path.basename(process.argv[1] || 'hook'), e); process.exit(0); });

const VERSION = '0.8.2';

const DEFAULTS = {
  lang: null,                 // 'it' | 'en' | null (auto from system locale)
  trimMaxChars: 16000,        // tool output above this gets trimmed (~4k tokens)
  trimHeadLines: 40,
  trimTailLines: 30,
  trimKeyLines: 20,           // error/warning lines kept from the middle
  maxLineChars: 400,          // single lines longer than this get cut (minified code, base64)
  readMaxLines: 800,          // Read without offset/limit above this asks for a range first
  readMaxBytes: 60000,
  contextWarnAt: [80000, 150000, 250000, 400000],
  handoffMaxAgeHours: 48,
  hygieneExtraFiles: [],      // more files read at every session start, measured by /meno:hygiene
  modelHint: 'both',         // first request: 'both' (Opus->Sonnet if simple, Sonnet->Opus if hard), 'down', or false
  delegateHint: true,        // at session start, ask Claude to delegate searches and long reads to a light subagent
  agentModel: 'off',         // 'on': subagents started without a model run on Sonnet instead of inheriting Opus
  readGuard: false,          // true: block whole reads of big files and unchanged re-reads (one "are you sure" each)
  loopAfter: 3,              // same failure (or same command + output) this many times in a row = loop
  neverTrim: [],             // folders ("~" allowed) whose files are never trimmed or blocked, e.g. notes read at startup
  keepOutputsDays: 7,        // saved full outputs and session files older than this are deleted
  cacheTtlMinutes: 60,       // after a pause longer than this the context is re-sent without cache (0 = no warning)
};

function dataDir() {
  const dir = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.meno');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let cfgCache = null;
function config() {
  if (cfgCache) return cfgCache;
  let user = {};
  // Skill commands may run without CLAUDE_PLUGIN_DATA: then look in the plugin data dirs too.
  const base = path.join(process.env.MENO_HOME || os.homedir(), '.claude', 'plugins', 'data');
  // The data dirs of the old name (token-diet) are read too, so a config written before
  // the rename keeps working.
  let dirs = [dataDir()];
  try { dirs = dirs.concat(fs.readdirSync(base).filter((d) => /^(meno|token-diet)(-|$)/.test(d)).map((d) => path.join(base, d))); } catch {}
  for (const d of dirs) {
    try { user = JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8')); break; } catch {}
  }
  if (!user || typeof user !== 'object' || Array.isArray(user)) user = {};
  cfgCache = Object.assign({}, DEFAULTS, user);
  // A wrong type in config.json falls back to the default instead of crashing a hook.
  for (const k of Object.keys(DEFAULTS)) {
    const d = DEFAULTS[k], v = cfgCache[k];
    if (d === null || v === d || k === 'modelHint') continue;
    if (Array.isArray(d) ? !Array.isArray(v) : typeof v !== typeof d) cfgCache[k] = d;
  }
  if (!cfgCache.lang) {
    const env = (process.env.MENO_LANG || process.env.TOKEN_DIET_LANG);
    let loc = '';
    try { loc = Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch {}
    cfgCache.lang = env || (loc.toLowerCase().startsWith('it') ? 'it' : 'en');
  }
  return cfgCache;
}

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

// Synchronous write: process.exit right after an async write can cut a big JSON on Windows pipes.
function out(obj) {
  if (obj) {
    const buf = Buffer.from(JSON.stringify(obj));
    let off = 0;
    while (off < buf.length) {
      try { off += fs.writeSync(1, buf, off); } catch (e) { if (e.code !== 'EAGAIN') break; }
    }
  }
  process.exit(0);
}

// ~4 chars per token: rough but stable, and the same estimate everywhere.
const tokens = (chars) => Math.round(chars / 4);

// Internal errors of the hooks, one line each, capped so it never grows big.
function logError(where, e) {
  try {
    const file = path.join(dataDir(), 'errors.log');
    const line = `${new Date().toISOString()} ${where} ${String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')}\n`;
    fs.appendFileSync(file, line);
    if (fs.statSync(file).size > 200 * 1024) {
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').slice(-500).join('\n'));
    }
  } catch {}
}

function logEvent(input, kind, savedChars, extra) {
  try {
    const row = Object.assign({
      ts: new Date().toISOString(),
      sid: input.session_id || '',
      cwd: input.cwd || '',
      kind,
      saved: tokens(savedChars),
      v: VERSION,
    }, extra || {});
    fs.appendFileSync(path.join(dataDir(), 'events.jsonl'), JSON.stringify(row) + '\n');
  } catch (e) { logError('logEvent', e); }
}

// Write to a temp file, then rename: a reader never sees half a file, and a crash
// mid-write leaves the old file intact. On Windows the rename can fail for a moment
// (EPERM/EBUSY while another hook or an antivirus holds the file): retried briefly.
const pause = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
function writeJSON(file, data, pretty) {
  const tmp = file + '.tmp-' + process.pid;
  let err;
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, pretty ? 1 : 0));
      fs.renameSync(tmp, file);
      return true;
    } catch (e) { err = e; pause(15 * (i + 1)); }
  }
  try { fs.unlinkSync(tmp); } catch {}
  logError('writeJSON ' + path.basename(file), err);
  return false;
}

// Per-session state (reads seen, warnings given, pending confirmations).
function stateFile(input) {
  const dir = path.join(dataDir(), 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const key = (input.session_id || 'nosession') + (input.agent_id ? '-' + input.agent_id : '');
  return path.join(dir, key.replace(/[^\w-]/g, '_') + '.json');
}

function loadState(input) {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(stateFile(input), 'utf8')); } catch {}
  if (!st || typeof st !== 'object') st = {};
  st.reads = st.reads || {};
  st.warned = st.warned || [];
  st.pending = st.pending || {};
  return st;
}

function saveState(input, st) {
  try { writeJSON(stateFile(input), st); } catch (e) { logError('saveState', e); }
}

// After /clear or compaction the earlier reads leave the context, but the trimmed
// outputs saved on disk can still be opened: their savings and the model name stay,
// so a later read of a saved output is still taken back from the report.
function resetState(input) {
  const st = loadState(input);
  const keep = { trims: st.trims, model: st.model, modelHinted: st.modelHinted };
  try { fs.unlinkSync(stateFile(input)); } catch {}
  if (keep.trims || keep.model) saveState(input, keep);
}

// Trims are remembered on the main session, so a subagent that opens a saved output
// takes its saving back too.
const mainOf = (input) => ({ session_id: input.session_id, cwd: input.cwd });

// "0.10" > "0.7": compared as numbers, part by part.
function versionAtLeast(v, min) {
  const a = String(v || '0').split('.').map(Number), b = String(min).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

// $ per million tokens: input, output, cache read. Cache writes cost 1.25x input
// (5 minutes) or 2x input (1 hour). Source: Anthropic price list, October 2026.
const PRICES = { fable: [10, 50, 0.25], mythos: [10, 50, 0.25], opus: [4, 20, 0.2], sonnet: [2, 10, 0.2], haiku: [0.1, 0.5, 0.01] };
function family(model) {
  const m = /(fable|mythos|opus|sonnet|haiku)/i.exec(String(model || ''));
  return m ? m[1].toLowerCase() : null;
}

// Cost in $ of one API usage object on a model family; null when the model is unknown.
function costOf(model, u) {
  const p = PRICES[family(model)];
  if (!p || !u) return null;
  const cc = u.cache_creation || {};
  const w1h = cc.ephemeral_1h_input_tokens || 0;
  const w5m = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : (u.cache_creation_input_tokens || 0) - w1h;
  return ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1] + (u.cache_read_input_tokens || 0) * p[2] +
    w5m * p[0] * 1.25 + w1h * p[0] * 2) / 1e6;
}

// Model of the main conversation: from SessionStart when Claude Code gave it, otherwise
// from the last main-thread reply in the transcript. null when unknown.
function mainModel(input) {
  const st = loadState(mainOf(input));
  if (st.model) return st.model;
  let fd;
  try {
    fd = fs.openSync(input.transcript_path, 'r');
    const size = fs.fstatSync(fd).size, len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"model"')) continue;
      let j;
      try { j = JSON.parse(lines[i]); } catch { continue; }
      if (j.type === 'assistant' && !j.isSidechain && j.message && j.message.model) return j.message.model;
    }
  } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  return null;
}

// Minutes after which the prompt cache has expired: Claude Code's own setting wins.
function cacheTtl(cfg) {
  if (process.env.FORCE_PROMPT_CACHING_5M === '1') return 5;
  const m = /^(\d+)\s*([mh])$/i.exec(String(process.env.CLAUDE_CODE_PROMPT_CACHE_TTL || '').trim());
  if (m) return Number(m[1]) * (m[2].toLowerCase() === 'h' ? 60 : 1);
  return cfg.cacheTtlMinutes;
}

const hash = (s) => require('crypto').createHash('sha1').update(s).digest('hex').slice(0, 12);

function resolvePath(p, cwd) {
  if (!p) return p;
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd || process.cwd(), p);
}

// Paths compared lowercase with forward slashes; Git Bash "/c/..." becomes "c:/...".
function normPath(p) {
  let s = String(p || '').replace(/\\/g, '/').toLowerCase();
  s = s.replace(/(^|[\s"'=(])\/([a-z])\//g, '$1$2:/');
  return s;
}

// True when the text (a path or a whole shell command) mentions a neverTrim folder.
function isProtected(text, cfg) {
  const t = normPath(text);
  if (!t) return false;
  return (cfg.neverTrim || []).some((dir) => {
    const d = normPath(String(dir).replace(/^~(?=$|[\\/])/, os.homedir())).replace(/\/+$/, '');
    return d.length > 0 && t.includes(d);
  });
}

// Folder of the saved full outputs, and the saved file a path or command points to.
const outDir = () => path.join(dataDir(), 'out');
function savedOutput(text) {
  const t = normPath(text), d = normPath(outDir()) + '/';
  const i = t.indexOf(d);
  if (i < 0) return null;
  const m = /^[\w-]+\.txt/.exec(t.slice(i + d.length));
  return m ? m[0] : null;
}

// Masks things that look like credentials before text is stored on disk.
function maskSecrets(s) {
  return String(s || '')
    .replace(/(authorization:\s*(?:bearer|basic|token)\s+)\S+/gi, '$1***')
    .replace(/\b(bearer\s+)[\w.~+/-]{8,}=*/gi, '$1***')
    .replace(/((?:pass(?:word)?|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth)[\w-]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/(\s-p)(?=\S)\S+/g, '$1***')
    .replace(/(:\/\/[^\s:/@]+:)[^\s@/]+@/g, '$1***@')
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr]|AKIA|AIza)[\w-]{12,}/g, '***')
    .replace(/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/g, '***');
}

// Deletes files older than maxDays in dir (only names matching re, when given).
function cleanDir(dir, maxDays, re) {
  const limit = Date.now() - maxDays * 864e5;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (re && !re.test(n)) continue;
    const f = path.join(dir, n);
    try { if (fs.statSync(f).mtimeMs < limit) fs.unlinkSync(f); } catch {}
  }
}

// True when the text reports a real problem: "0 failed" or "warnings: 0" are not problems.
const PROBLEM = /error|fail|exception|traceback|panic|fatal|denied|not found|warn|cannot|unable|✗|×/i;
const ZERO = /\b(?:0|no)\s+(?:errors?|failed|failures?|failing|warnings?|problems?)\b|\b(?:errors?|failed|failures?|warnings?)\s*[:=]\s*0\b/gi;
function hasProblem(text) {
  return String(text || '').split('\n').some((l) => PROBLEM.test(l.replace(ZERO, '')));
}

// Loop detection: counts identical outcomes (same failure, or same command with the
// same output) in a row. Numbers are masked so timestamps, PIDs and line counts do not
// hide a repeat. Any different outcome in between resets the count, so the same test
// run three times hours apart is not a loop. Returns a note every loopAfter repeats.
const LOOP_MSG = {
  it: (n) => `[meno] Claude ha ottenuto lo stesso risultato ${n} volte: gli ho chiesto di cambiare strategia.`,
  en: (n) => `[meno] Claude got the same result ${n} times: asked it to change strategy.`,
};

function checkLoop(input, sig) {
  const cfg = config();
  const key = hash(sig.replace(/\d+/g, '#').slice(0, 4000));
  const st = loadState(input);
  const n = (st.loop && st.loop.key === key ? st.loop.n : 0) + 1;
  st.loop = { key, n };
  delete st.loops;
  saveState(input, st);
  if (n < cfg.loopAfter || n % cfg.loopAfter) return null;
  logEvent(input, 'loop', 0, { tool: input.tool_name, repeats: n });
  return {
    model: `[meno] This is the ${n}th time in a row this ${input.tool_name} call ends with the same result. ` +
      'Retrying the same approach is not working. Stop and change strategy: re-read the error, ' +
      'check your assumptions, try a different method, or ask the user.',
    user: (LOOP_MSG[config().lang] || LOOP_MSG.en)(n),
  };
}

// Any outcome that is not a repeat breaks the streak.
function breakLoop(input) {
  const st = loadState(input);
  if (st.loop) { delete st.loop; saveState(input, st); }
}

// Handoff notes live outside the project, so a cloned repo cannot ship one that
// gets loaded as trusted context. Fixed location (not CLAUDE_PLUGIN_DATA) because
// the skill that writes the note and the hook that reads it see different env.
// ~/.claude/meno: handoff notes and the error memory. The folder of the old name
// (token-diet, up to 0.8.1) is moved here the first time it is needed.
function homeDir() {
  const dir = path.join(os.homedir(), '.claude', 'meno');
  const old = path.join(os.homedir(), '.claude', 'token-diet');
  if (!fs.existsSync(dir) && fs.existsSync(old)) {
    try { fs.renameSync(old, dir); } catch (e) { logError('homeDir', e); }
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function handoffFile(cwd) {
  let key = path.resolve(cwd || process.cwd());
  if (process.platform === 'win32') key = key.toLowerCase();
  const dir = path.join(homeDir(), 'handoff');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, hash(key) + '.md');
}

module.exports = {
  VERSION, config, dataDir, readStdin, out, tokens, logError, logEvent, writeJSON, loadState, saveState, resetState, mainOf,
  versionAtLeast, family, costOf, mainModel, cacheTtl, homeDir, hash,
  resolvePath, normPath, isProtected, outDir, savedOutput, maskSecrets, cleanDir, hasProblem, checkLoop, breakLoop, handoffFile,
};
