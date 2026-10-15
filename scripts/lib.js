// Shared helpers for token-diet hooks. No dependencies: Node built-ins only.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = {
  lang: null,                 // 'it' | 'en' | null (auto from system locale)
  trimMaxChars: 8000,         // tool output above this gets trimmed (~2k tokens)
  trimHeadLines: 40,
  trimTailLines: 30,
  trimKeyLines: 20,           // error/warning lines kept from the middle
  maxLineChars: 400,          // single lines longer than this get cut (minified code, base64)
  readMaxLines: 400,          // Read without offset/limit above this asks for a range first
  readMaxBytes: 40000,
  contextWarnAt: [80000, 150000, 250000, 400000],
  handoffMaxAgeHours: 48,
  loopAfter: 3,               // same failure (or same command + output) this many times = loop
};

function dataDir() {
  const dir = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.token-diet');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let cfgCache = null;
function config() {
  if (cfgCache) return cfgCache;
  let user = {};
  try { user = JSON.parse(fs.readFileSync(path.join(dataDir(), 'config.json'), 'utf8')); } catch {}
  cfgCache = Object.assign({}, DEFAULTS, user);
  if (!cfgCache.lang) {
    const env = process.env.TOKEN_DIET_LANG;
    let loc = '';
    try { loc = Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch {}
    cfgCache.lang = env || (loc.toLowerCase().startsWith('it') ? 'it' : 'en');
  }
  return cfgCache;
}

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function out(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

// ~4 chars per token: rough but stable, and the same estimate everywhere.
const tokens = (chars) => Math.round(chars / 4);

function logEvent(input, kind, savedChars, extra) {
  try {
    const row = Object.assign({
      ts: new Date().toISOString(),
      sid: input.session_id || '',
      cwd: input.cwd || '',
      kind,
      saved: tokens(savedChars),
    }, extra || {});
    fs.appendFileSync(path.join(dataDir(), 'events.jsonl'), JSON.stringify(row) + '\n');
  } catch {}
}

// Per-session state (reads seen, warnings given, pending confirmations).
function stateFile(input) {
  const dir = path.join(dataDir(), 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const key = (input.session_id || 'nosession') + (input.agent_id ? '-' + input.agent_id : '');
  return path.join(dir, key.replace(/[^\w-]/g, '_') + '.json');
}

function loadState(input) {
  try { return JSON.parse(fs.readFileSync(stateFile(input), 'utf8')); } catch { return { reads: {}, warned: [], pending: {} }; }
}

function saveState(input, st) {
  try { fs.writeFileSync(stateFile(input), JSON.stringify(st)); } catch {}
}

function resetState(input) {
  try { fs.unlinkSync(stateFile(input)); } catch {}
}

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

function resolvePath(p, cwd) {
  if (!p) return p;
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd || process.cwd(), p);
}

// Loop detection: counts identical outcomes (same failure, or same command with the
// same output) per session. Numbers are masked so timestamps, PIDs and line counts
// do not hide a repeat. Returns a note for the model every loopAfter repeats.
const LOOP_MSG = {
  it: (n) => `[token-diet] Claude ha ottenuto lo stesso risultato ${n} volte: gli ho chiesto di cambiare strategia.`,
  en: (n) => `[token-diet] Claude got the same result ${n} times: asked it to change strategy.`,
};

function checkLoop(input, sig) {
  const cfg = config();
  const key = hash(sig.replace(/\d+/g, '#').slice(0, 4000));
  const st = loadState(input);
  st.loops = st.loops || {};
  const n = (st.loops[key] || 0) + 1;
  st.loops[key] = n;
  saveState(input, st);
  if (n < cfg.loopAfter || n % cfg.loopAfter) return null;
  logEvent(input, 'loop', 0, { tool: input.tool_name, repeats: n });
  return {
    model: `[token-diet] This is the ${n}th time this ${input.tool_name} call ends with the same result. ` +
      'Retrying the same approach is not working. Stop and change strategy: re-read the error, ' +
      'check your assumptions, try a different method, or ask the user.',
    user: (LOOP_MSG[cfg.lang] || LOOP_MSG.en)(n),
  };
}

module.exports = { config, dataDir, readStdin, out, tokens, logEvent, loadState, saveState, resetState, hash, resolvePath, checkLoop };

// Handoff notes live outside the project, so a cloned repo cannot ship one that
// gets loaded as trusted context. Fixed location (not CLAUDE_PLUGIN_DATA) because
// the skill that writes the note and the hook that reads it see different env.
function handoffFile(cwd) {
  let key = path.resolve(cwd || process.cwd());
  if (process.platform === 'win32') key = key.toLowerCase();
  const dir = path.join(os.homedir(), '.claude', 'token-diet', 'handoff');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, hash(key) + '.md');
}

module.exports.handoffFile = handoffFile;
