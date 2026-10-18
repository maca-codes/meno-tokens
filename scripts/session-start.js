// SessionStart:
// - after /clear or compaction the earlier reads are gone from context, so the per-session
//   state is reset (the savings of saved outputs stay, see lib.resetState);
// - on a new start, /clear or compaction it adds a short instruction: searches and long
//   reads go to a light subagent, so only a summary enters this context;
// - on a fresh start or /clear it loads the handoff note written by /meno:handoff
//   (stored outside the project), so the new session continues with a few hundred tokens
//   instead of the whole old context;
// - once a day it deletes old saved outputs and session files.
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const input = lib.readStdin();
const cfg = lib.config();
const source = input.source || 'startup';

if (source === 'clear' || source === 'compact') lib.resetState(input);

// Housekeeping, at most once a day (also for sessions that are only ever resumed):
// old saved outputs and session files go, and the event log keeps its last 180 days.
function housekeeping() {
  const data = lib.dataDir();
  const stamp = path.join(data, 'housekeeping.stamp');
  try { if (Date.now() - fs.statSync(stamp).mtimeMs < 864e5) return; } catch {}
  try { fs.writeFileSync(stamp, ''); } catch {}
  lib.cleanDir(path.join(data, 'out'), cfg.keepOutputsDays);
  lib.cleanDir(path.join(data, 'sessions'), Math.max(cfg.keepOutputsDays, 7));
  lib.cleanDir(data, 30, /^lastctx-/);
  lib.cleanDir(path.dirname(lib.handoffFile(input.cwd || process.cwd())), 30, /\.used\.md$/);
  const log = path.join(data, 'events.jsonl');
  try {
    if (fs.statSync(log).size > 2 * 1024 * 1024) {
      const since = Date.now() - 180 * 864e5;
      const keep = fs.readFileSync(log, 'utf8').split('\n').filter((l) => {
        try { return Date.parse(JSON.parse(l).ts) >= since; } catch { return false; }
      });
      fs.writeFileSync(log + '.tmp', keep.join('\n') + '\n');
      fs.renameSync(log + '.tmp', log);
    }
  } catch (e) { if (e.code !== 'ENOENT') lib.logError('housekeeping', e); }
}
if (source === 'startup' || source === 'resume') housekeeping();
if (source === 'resume') lib.out(null);

// Remembered for prompt.js (model hint) and agent.js / post-tool.js (subagent costs).
if (input.model) {
  const st = lib.loadState(input);
  st.model = String(typeof input.model === 'object' ? input.model.id || '' : input.model);
  lib.saveState(input, st);
}

// Every token read into this context is sent again with each later message: reading
// through a subagent keeps only its summary here. ~70 tokens, once per session.
const DELEGATE = 'Meno: to keep this context small, when a task needs searching or reading more than ~3 files, ' +
  'delegate that part to a subagent (Explore, or Agent with model "haiku") and ask for a short summary with file:line ' +
  'references. Plan, decide, edit and verify yourself; read directly only the lines you will change. ' +
  'Do not delegate small lookups or the edits themselves.';

const parts = cfg.delegateHint ? [DELEGATE] : [];

// Handoff note: only on a fresh start or after /clear, in the same folder.
function handoff() {
  if (source !== 'clear' && source !== 'startup') return null;
  const cwd = input.cwd || process.cwd();
  const file = lib.handoffFile(cwd);
  let s;
  try { s = fs.lstatSync(file); } catch { return null; }
  if (!s.isFile() || s.size > 64 * 1024) return null; // no symlinks, no oversized notes
  if (Date.now() - s.mtimeMs > cfg.handoffMaxAgeHours * 3600e3) return null;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try { fs.renameSync(file, file.replace(/\.md$/, '.used.md')); } catch {}
  // Context of the last message sent in this folder before the restart (0 = unknown).
  let before = 0;
  try { before = JSON.parse(fs.readFileSync(path.join(lib.dataDir(), 'lastctx-' + lib.hash(cwd) + '.json'), 'utf8')).used || 0; } catch {}
  lib.logEvent(input, 'handoff', 0, { ctxBefore: before, handoffTokens: lib.tokens(text.length) });
  return 'Handoff from the previous session (written by Meno). Continue from here; ' +
    'read files only when the task needs them.\n\n' + text;
}
const note = handoff();
if (note) parts.push(note);

lib.out(parts.length ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') } } : null);
