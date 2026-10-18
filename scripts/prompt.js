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
  it: (k) => `Meno: contesto a ${k}k token, e ogni messaggio lo rimanda tutto. ` +
    'Per ripartire leggero: /meno:handoff e poi /clear.',
  en: (k) => `Meno: context at ${k}k tokens, and every message re-sends all of it. ` +
    'To restart light: /meno:handoff, then /clear.',
};

const CACHE_MSG = {
  it: (m, k) => `Meno: pausa di ${m} minuti, la cache è probabilmente scaduta: questo messaggio rimanda ${k}k token a prezzo pieno. ` +
    'Se cambi argomento, conviene ripartire leggero: /meno:handoff e poi /clear.',
  en: (m, k) => `Meno: ${m}-minute pause, the cache has probably expired: this message re-sends ${k}k tokens at full price. ` +
    'If you are switching topic, restart light: /meno:handoff, then /clear.',
};

// First request of a session: the right model for what follows. Opus on something
// simple: suggest Sonnet. Sonnet or Haiku on something clearly hard: suggest Opus, which
// gets it right in fewer attempts. Only once and only at the start, because switching
// model later re-sends the whole context without cache and costs more.
// Shown to the user only (systemMessage): it costs the model nothing.
const MODEL_MSG = {
  it: 'Meno: richiesta semplice. Se la sessione resta su cose così, passa ora a Sonnet con /model sonnet: ' +
    'costa meno. Più avanti conviene meno, perché il cambio fa ricaricare tutto il contesto. Per lavori complessi torna a Opus.',
  en: 'Meno: simple request. If this session stays on things like this, switch to Sonnet now with /model sonnet: ' +
    'it costs less. Later it pays off less, because switching re-sends the whole context. Go back to Opus for complex work.',
};
const UP_MSG = {
  it: 'Meno: richiesta complessa. Per lavori così Opus sbaglia meno e fa meno tentativi: passa ora con /model opus ' +
    '(più avanti il cambio costa di più, perché ricarica tutto il contesto).',
  en: 'Meno: complex request. For work like this Opus makes fewer mistakes and retries: switch now with /model opus ' +
    '(later the switch costs more, because it re-sends the whole context).',
};
const BUILD = /```|implement|crea|costruis|svilupp|aggiung|modific|refactor|riscriv|debug|bug|error|non funziona|progett|plugin|sito|app\b|gioco|migr|deploy|build|test|codice|script|funzion|feature|create|develop|\badd\b|rewrite|\bfix|project|website|\bcode/i;
// Only strong signals: a long, detailed brief, or work known to need deep reasoning.
const HARD = /architett|architect|da zero|from scratch|refactor\w*\s+(?:complet|intero|tutto|whole|entire)|riscriv\w*\s+(?:tutto|intero)|race condition|deadlock|memory leak|concorrenz|concurren|vulnerab|security audit|audit di sicurezza|migra\w*\s+(?:da|a|from|to)\b|ottimizz\w*\s+(?:le\s+)?prestazioni|performance (?:issue|problem)|perché non funziona|why (?:does|is) .* not work/i;

function simplePrompt(p) {
  p = String(p || '').trim();
  return p.length > 0 && p.length <= 300 && !p.startsWith('/') && !BUILD.test(p);
}
function hardPrompt(p) {
  p = String(p || '').trim();
  return !p.startsWith('/') && (p.length > 800 || HARD.test(p));
}

const input = lib.readStdin();
const cfg = lib.config();
const used = contextTokens(input.transcript_path);
const hint = cfg.modelHint === true ? 'both' : cfg.modelHint;

if (!used && (hint === 'both' || hint === 'down')) {
  const st = lib.loadState(input);
  if (!st.modelHinted && st.model) {
    st.modelHinted = true;
    lib.saveState(input, st);
    if (/opus|fable|mythos/i.test(st.model) && simplePrompt(input.prompt)) lib.out({ systemMessage: MODEL_MSG[cfg.lang] || MODEL_MSG.en });
    if (hint === 'both' && /sonnet|haiku/i.test(st.model) && hardPrompt(input.prompt)) lib.out({ systemMessage: UP_MSG[cfg.lang] || UP_MSG.en });
  }
}
if (!used) lib.out(null);

// Remembered so session-start.js can measure what a handoff saved.
try {
  fs.writeFileSync(path.join(lib.dataDir(), 'lastctx-' + lib.hash(input.cwd || '') + '.json'),
    JSON.stringify({ used, ts: Date.now(), sid: input.session_id }));
} catch {}

const st = lib.loadState(input);
const msgs = [];

// A pause longer than the prompt cache lifetime: the next message re-sends the whole
// context at full price. Told to the user only (costs nothing), and only when it is big.
const now = Date.now();
const ttl = lib.cacheTtl(cfg);
if (ttl > 0 && st.lastPrompt && now - st.lastPrompt > ttl * 60e3 && used >= 30000) {
  msgs.push((CACHE_MSG[cfg.lang] || CACHE_MSG.en)(Math.round((now - st.lastPrompt) / 60e3), Math.round(used / 1000)));
}
st.lastPrompt = now;

const hit = cfg.contextWarnAt.filter((t) => used >= t && !st.warned.includes(t));
if (hit.length) {
  st.warned.push(...hit);
  msgs.push((MSG[cfg.lang] || MSG.en)(Math.round(used / 1000)));
}
lib.saveState(input, st);
lib.out(msgs.length ? { systemMessage: msgs.join('\n') } : null);
