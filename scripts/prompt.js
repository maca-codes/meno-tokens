// UserPromptSubmit: measures the current context from the transcript and warns the
// user (not the model, so it costs no tokens) when it crosses a threshold.
// Every message re-sends the whole context, so a long session is the biggest hidden cost.
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

// Last main-thread assistant usage = what the next request will carry at least.
function contextTokens(transcript) {
  let fd;
  try {
    fd = fs.openSync(transcript, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 2 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"usage"')) continue;
      let j;
      try { j = JSON.parse(lines[i]); } catch { continue; }
      if (j.type !== 'assistant' || j.isSidechain || !j.message || !j.message.usage) continue;
      const u = j.message.usage;
      return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    }
  } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  return 0;
}

const MSG = {
  it: (k) => `token-diet: contesto a ${k}k token, e ogni messaggio lo rimanda tutto. ` +
    'Per ripartire leggero: /token-diet:handoff e poi /clear.',
  en: (k) => `token-diet: context at ${k}k tokens, and every message re-sends all of it. ` +
    'To restart light: /token-diet:handoff, then /clear.',
};

// First request of a session on Opus that looks simple (short question, nothing to
// build or fix): suggest Sonnet. Only once and only at the start, because switching
// model later re-sends the whole context without cache and costs more.
const MODEL_MSG = {
  it: 'token-diet: richiesta semplice. Se la sessione resta su cose così, passa ora a Sonnet con /model sonnet: ' +
    'costa meno. Più avanti conviene meno, perché il cambio fa ricaricare tutto il contesto. Per lavori complessi torna a Opus.',
  en: 'token-diet: simple request. If this session stays on things like this, switch to Sonnet now with /model sonnet: ' +
    'it costs less. Later it pays off less, because switching re-sends the whole context. Go back to Opus for complex work.',
};
const BUILD = /```|implement|crea|costruis|svilupp|aggiung|modific|refactor|riscriv|debug|bug|error|non funziona|progett|plugin|sito|app\b|gioco|migr|deploy|build|test|codice|script|funzion|feature|create|develop|\badd\b|rewrite|\bfix|project|website|\bcode/i;

function simplePrompt(p) {
  p = String(p || '').trim();
  return p.length > 0 && p.length <= 300 && !p.startsWith('/') && !BUILD.test(p);
}

const input = lib.readStdin();
const cfg = lib.config();
const used = contextTokens(input.transcript_path);

if (!used && cfg.modelHint) {
  const st = lib.loadState(input);
  if (!st.modelHinted && /opus/i.test(st.model || '')) {
    st.modelHinted = true;
    lib.saveState(input, st);
    if (simplePrompt(input.prompt)) lib.out({ systemMessage: MODEL_MSG[cfg.lang] || MODEL_MSG.en });
  }
}
if (!used) lib.out(null);

// Remembered so session-start.js can measure what a handoff saved.
try {
  fs.writeFileSync(path.join(lib.dataDir(), 'lastctx-' + lib.hash(input.cwd || '') + '.json'),
    JSON.stringify({ used, ts: Date.now(), sid: input.session_id }));
} catch {}

const st = lib.loadState(input);
const hit = cfg.contextWarnAt.filter((t) => used >= t && !st.warned.includes(t));
if (!hit.length) lib.out(null);
st.warned.push(...hit);
lib.saveState(input, st);
lib.out({ systemMessage: (MSG[cfg.lang] || MSG.en)(Math.round(used / 1000)) });
