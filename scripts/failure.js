// PostToolUseFailure: when any tool keeps failing with the same error, tells the model
// to stop retrying and change strategy. A specific error is matched on its own, so small
// variations of a failing approach still count. A generic one ("Exit code 1", "File does
// not exist") is matched together with the tool input, so different attempts do not.
'use strict';
const lib = require('./lib');

const input = lib.readStdin();
if (input.is_interrupt || !input.error) lib.out(null);

const err = String(input.error);
const specific = err.replace(/^Exit code \d+\s*/i, '').trim().length >= 40;
const sig = `${input.tool_name}\n${err}` + (specific ? '' : '\n' + JSON.stringify(input.tool_input || {}));
const loop = lib.checkLoop(input, sig);
lib.out(loop && {
  systemMessage: loop.user,
  hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: loop.model },
});
