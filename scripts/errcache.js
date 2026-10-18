// Error fingerprint cache: remembers how a failing call was fixed and offers that
// fix as a hint when the same error comes back, in any project.
// Flow: a failure opens a "case" in the session state. Edits and commands that follow
// are recorded as steps. When the same call later succeeds, the case is saved with
// its steps. No model tokens are spent to learn a fix, only to show one (~100 tokens).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

const MAX_STEPS = 8;        // more steps than this: the link between error and fix is too weak
const MAX_AGE_DAYS = 60;
const MAX_ENTRIES = 200;
const MAX_OPEN = 3;

// Fixed location (not CLAUDE_PLUGIN_DATA): the /meno:errors skill runs without it.
function cacheFile() {
  if (process.env.MENO_ERRORS) return process.env.MENO_ERRORS;   // tests
  return path.join(lib.homeDir(), 'errors.json');
}

// A file that exists but cannot be read is never overwritten: that would wipe the memory.
let unreadable = false;
function load() {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') unreadable = true;
  }
  if (!Array.isArray(list)) { unreadable = true; list = []; }
  const since = Date.now() - MAX_AGE_DAYS * 864e5;
  return list.filter((e) => e && Date.parse(e.ts) >= since);
}

function save(list) {
  if (unreadable) return;
  lib.writeJSON(cacheFile(), list.slice(-MAX_ENTRIES), true);
}

// Paths, numbers and hashes are masked: the same error in another folder or line still matches.
// Returns null for errors too generic to recognise ("Exit code 1") and for our own denials.
function fingerprint(tool, error) {
  const err = String(error || '');
  if (/\[(?:meno|token-diet)\]|doesn't want to proceed|permission/i.test(err)) return null;
  const body = err.replace(/^Exit code \d+\s*/i, '').trim();
  if (body.length < 40) return null;
  const norm = body.slice(0, 600)
    .replace(/[A-Za-z]:[\\/][^\s'"`]*/g, '<path>')
    .replace(/(?:\/[\w.@-]+){2,}\/?/g, '<path>')
    .replace(/\b[0-9a-f]{7,}\b/gi, '<hex>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ');
  return lib.hash(tool + '\n' + norm);
}

// What counts as "the same call" succeeding later: same tool and, for shell
// commands, the same first two words (so `npm test -- --x` closes `npm test`).
function callKey(tool, ti) {
  ti = ti || {};
  if (ti.command) return tool + ':' + String(ti.command).trim().split(/\s+/).slice(0, 2).join(' ');
  return tool + ':' + (ti.file_path || ti.notebook_path || ti.url || '');
}

// Commands that only look around (list, print, search, status) are not part of a fix.
const LOOK_ONLY = /^(cd|ls|dir|pwd|echo|cat|type|head|tail|less|more|grep|rg|find|which|where|get-childitem|get-content|gci|git (status|log|diff|show|branch))\b/i;

function step(tool, ti) {
  ti = ti || {};
  if (ti.command) {
    const c = lib.maskSecrets(String(ti.command).replace(/\s+/g, ' ').trim());
    if (LOOK_ONLY.test(c) && !/[;&|]/.test(c)) return null;
    return `ran \`${c.length > 120 ? c.slice(0, 120) + '…' : c}\``;
  }
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return `${tool === 'Write' ? 'wrote' : 'edited'} ${path.basename(ti.file_path || ti.notebook_path || '')}`;
  return null;
}

// On failure: open a case, and return a hint if this error was fixed before.
function onFailure(input) {
  const fp = fingerprint(input.tool_name, input.error);
  if (!fp) return null;
  const st = lib.loadState(input);
  st.cases = (st.cases || []).filter((c) => c.key !== callKey(input.tool_name, input.tool_input));
  st.cases.push({ fp, key: callKey(input.tool_name, input.tool_input), sample: lib.maskSecrets(String(input.error).slice(0, 200)), steps: [] });
  st.cases = st.cases.slice(-MAX_OPEN);
  st.hinted = st.hinted || [];
  let hit = null;
  if (!st.hinted.includes(fp)) {
    const list = load();
    hit = list.filter((e) => e.fp === fp).pop() || null;
    if (hit) {
      st.hinted.push(fp);
      hit.hits = (hit.hits || 0) + 1;
      save(list);
      lib.logEvent(input, 'errhit', 0, { tool: input.tool_name, project: hit.project });
    }
  }
  lib.saveState(input, st);
  if (!hit) return null;
  const T = {
    it: `[meno] Errore già visto (${hit.ts.slice(0, 10)}, ${hit.project}): ho passato a Claude la soluzione di allora.`,
    en: `[meno] Known error (${hit.ts.slice(0, 10)}, ${hit.project}): passed the earlier fix to Claude.`,
  };
  return {
    model: `[meno] This error was seen before (${hit.ts.slice(0, 10)}, project ${hit.project}) and was fixed by: ` +
      hit.steps.map((s, i) => `${i + 1}) ${s}`).join(' ') +
      '. This is a hint from an automatic record: check it fits here before repeating it.',
    user: T[lib.config().lang] || T.en,
  };
}

// On success: add the call as a step to open cases; close the case it resolves.
function onSuccess(input) {
  const st = lib.loadState(input);
  if (!st.cases || !st.cases.length) return;
  const key = callKey(input.tool_name, input.tool_input);
  const s = step(input.tool_name, input.tool_input);
  const keep = [];
  for (const c of st.cases) {
    if (c.key === key) {
      if (c.steps.length) {
        const list = load().filter((e) => e.fp !== c.fp);
        list.push({ fp: c.fp, ts: new Date().toISOString(), project: path.basename(input.cwd || '') || '?', sample: c.sample, steps: c.steps, hits: 0 });
        save(list);
        lib.logEvent(input, 'errsave', 0, { tool: input.tool_name });
      }
      continue;
    }
    if (s && c.steps[c.steps.length - 1] !== s) c.steps.push(s);
    if (c.steps.length <= MAX_STEPS) keep.push(c);
  }
  st.cases = keep;
  lib.saveState(input, st);
}

module.exports = { onFailure, onSuccess, fingerprint, load, save, cacheFile };
