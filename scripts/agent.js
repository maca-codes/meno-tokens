// PreToolUse on Agent: a general-purpose subagent started without a model inherits the
// main one, often Opus, even for work that Sonnet does as well. With agentModel "on" it
// runs on Sonnet instead. A model chosen in the call, or in an agent's own definition,
// is never touched: only general-purpose agents with no model get the default.
'use strict';
const lib = require('./lib');

const MSG = {
  it: 'token-diet: subagent senza modello indicato, avviato su Sonnet invece di Opus.',
  en: 'token-diet: subagent with no model given, started on Sonnet instead of Opus.',
};

const input = lib.readStdin();
const cfg = lib.config();
const ti = input.tool_input || {};
if (cfg.agentModel !== 'on' || ti.model) lib.out(null);
if ((ti.subagent_type || 'general-purpose') !== 'general-purpose') lib.out(null);

// Only when the main model costs more than Sonnet (unknown = Claude Code's default, Opus).
const main = lib.mainModel(input);
if (main && !/opus|fable|mythos/i.test(main)) lib.out(null);

lib.logEvent(input, 'route', 0, { to: 'sonnet' });
lib.out({
  systemMessage: MSG[cfg.lang] || MSG.en,
  // No permissionDecision: the call is not approved here, so the user's own permission
  // rules for Agent still decide. updatedInput alone is applied (tested on Claude Code 2.1.302).
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    updatedInput: Object.assign({}, ti, { model: 'sonnet' }),
  },
});
