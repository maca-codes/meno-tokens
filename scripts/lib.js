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

module.exports = { config, dataDir, readStdin, out, tokens, logEvent, loadState, saveState, resetState, hash, resolvePath };
