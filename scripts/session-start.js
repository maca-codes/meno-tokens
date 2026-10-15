// SessionStart: after /clear or compaction the earlier reads are gone from context,
// so the re-read guard forgets them. On a fresh start it loads the handoff note
// written by /token-diet:handoff, so the new session continues with a few hundred
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

const cwd = input.cwd || process.cwd();
const file = path.join(cwd, '.claude', 'handoff.md');
let text, s;
try { s = fs.statSync(file); text = fs.readFileSync(file, 'utf8'); } catch { lib.out(null); }
if (Date.now() - s.mtimeMs > cfg.handoffMaxAgeHours * 3600e3) lib.out(null);

try { fs.renameSync(file, path.join(cwd, '.claude', 'handoff.used.md')); } catch {}

let before = 0;
try { before = JSON.parse(fs.readFileSync(path.join(lib.dataDir(), 'lastctx-' + lib.hash(cwd) + '.json'), 'utf8')).used; } catch {}
lib.logEvent(input, 'handoff', 0, { ctxBefore: before, handoffTokens: lib.tokens(text.length) });

lib.out({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: 'Handoff from the previous session (written by token-diet). Continue from here; ' +
      'read files only when the task needs them.\n\n' + text,
  },
});
