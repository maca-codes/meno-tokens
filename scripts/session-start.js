// SessionStart: after /clear or compaction the earlier reads are gone from context,
// so the re-read guard forgets them. On a fresh start it loads the handoff note
// written by /token-diet:handoff (stored outside the project), so the new session continues with a few hundred
// tokens instead of the whole old context.
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const input = lib.readStdin();
const cfg = lib.config();
const source = input.source || 'startup';

if (source === 'clear' || source === 'compact') lib.resetState(input);
if (source !== 'clear' && source !== 'startup') lib.out(null);

// Housekeeping at each new session: old saved outputs and session files go, and the
// event log keeps its last 180 days, so nothing grows without limit.
if (source === 'startup') {
  const data = lib.dataDir();
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
  } catch {}
}

// Remembered for prompt.js, which suggests a lighter model for a simple first request.
if (input.model) {
  const st = lib.loadState(input);
  st.model = String(typeof input.model === 'object' ? input.model.id || '' : input.model);
  lib.saveState(input, st);
}

const cwd = input.cwd || process.cwd();
const file = lib.handoffFile(cwd);
let text, s;
try { s = fs.lstatSync(file); } catch { lib.out(null); }
if (!s.isFile() || s.size > 64 * 1024) lib.out(null); // no symlinks, no oversized notes
if (Date.now() - s.mtimeMs > cfg.handoffMaxAgeHours * 3600e3) lib.out(null);
try { text = fs.readFileSync(file, 'utf8'); } catch { lib.out(null); }

try { fs.renameSync(file, file.replace(/\.md$/,'.used.md')); } catch {}

// Context of the last message sent in this folder before the restart (0 = unknown).
let before = 0;
try { before = JSON.parse(fs.readFileSync(path.join(lib.dataDir(), 'lastctx-' + lib.hash(cwd) + '.json'), 'utf8')).used || 0; } catch {}
lib.logEvent(input, 'handoff', 0, { ctxBefore: before, handoffTokens: lib.tokens(text.length) });

lib.out({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: 'Handoff from the previous session (written by token-diet). Continue from here; ' +
      'read files only when the task needs them.\n\n' + text,
  },
});
