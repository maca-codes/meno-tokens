// Prints what token-diet saved, per day. Usage: node report.js [days=7]
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const days = parseInt(process.argv[2], 10) || 7;
const cfg = lib.config();
const T = {
  it: {
    title: `token-diet — ultimi ${days} giorni`, none: 'Ancora nessun intervento registrato.',
    head: ['Giorno', 'Output tagliati', 'Riaperti', 'Letture evitate', 'Riletture evitate', 'Ripensamenti', 'Cicli fermati', 'Errori riconosciuti', 'Token risparmiati (netti)'],
    total: 'Totale', handoff: 'Ripartenze con riassunto',
    hrow: (n, a, b) => `${n} — contesto prima della ripartenza ${a}, riassunto ~${b} token`,
    unknown: 'non misurato',
    since: (d) => `Dal ${d} è attiva la versione 0.7 (soglie più alte, tagli per tipo di output): i giorni prima non sono confrontabili.`,
    note: 'Stima: 1 token ogni 4 caratteri. Il risparmio è netto: "Riaperti" = output tagliati che Claude ha poi riletto dal file salvato, e "Ripensamenti" = letture bloccate e poi ripetute; quel che hanno riletto è già tolto. "Cicli fermati" = lo stesso tentativo fallito 3 volte di fila: risparmio non stimato. "Errori riconosciuti" = errori già risolti in passato, soluzione passata a Claude.',
  },
  en: {
    title: `token-diet — last ${days} days`, none: 'No interventions recorded yet.',
    head: ['Day', 'Outputs trimmed', 'Reopened', 'Big reads avoided', 'Re-reads avoided', 'Overrides', 'Loops stopped', 'Known errors', 'Tokens saved (net)'],
    total: 'Total', handoff: 'Restarts with handoff',
    hrow: (n, a, b) => `${n} — context before the restart ${a}, handoff ~${b} tokens`,
    unknown: 'not measured',
    since: (d) => `Version 0.7 is active since ${d} (higher thresholds, trimming by output type): earlier days are not comparable.`,
    note: 'Estimate: 1 token per 4 characters. The saving is net: "Reopened" = trimmed outputs Claude then read again from the saved file, and "Overrides" = blocked reads the model repeated; what they read is already taken back. "Loops stopped" = the same failed attempt 3 times in a row; saving not estimated. "Known errors" = errors fixed before, earlier fix passed to Claude.',
  },
};
const L = T[cfg.lang] || T.en;

// Skill commands may run without CLAUDE_PLUGIN_DATA, so also look in every
// token-diet data dir (one per marketplace the plugin came from).
function dirs() {
  if (process.env.CLAUDE_PLUGIN_DATA) return [process.env.CLAUDE_PLUGIN_DATA];
  const base = path.join(require('os').homedir(), '.claude', 'plugins', 'data');
  let found = [];
  try { found = fs.readdirSync(base).filter((d) => /^token-diet(-|$)/.test(d)).map((d) => path.join(base, d)); } catch {}
  return found.concat(lib.dataDir());
}

let rows = [];
for (const d of new Set(dirs())) {
  try {
    rows.push(...fs.readFileSync(path.join(d, 'events.jsonl'), 'utf8').trim().split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
  } catch {}
}
const since = Date.now() - days * 864e5;
rows = rows.filter((r) => Date.parse(r.ts) >= since);

console.log(L.title);
if (!rows.length) { console.log(L.none); process.exit(0); }

const KEYS = ['trim', 'readback', 'bigread', 'reread', 'override', 'loop', 'errhit'];
const empty = () => Object.assign({ saved: 0 }, ...KEYS.map((k) => ({ [k]: 0 })));
const byDay = {};
const hand = [];
for (const r of rows) {
  const d = r.ts.slice(0, 10);
  const b = byDay[d] || (byDay[d] = empty());
  if (r.kind === 'handoff') { hand.push(r); continue; }
  b[r.kind] = (b[r.kind] || 0) + 1;
  b.saved += r.saved || 0;
}

const fmt = (n) => n.toLocaleString(cfg.lang === 'it' ? 'it-IT' : 'en-US');
const table = [L.head];
const tot = empty();
for (const d of Object.keys(byDay).sort()) {
  const b = byDay[d];
  for (const k in tot) tot[k] += b[k] || 0;
  table.push([d, ...KEYS.map((k) => b[k]), fmt(b.saved)].map(String));
}
table.push([L.total, ...KEYS.map((k) => tot[k]), fmt(tot.saved)].map(String));
const w = L.head.map((_, i) => Math.max(...table.map((r) => r[i].length)));
for (const r of table) console.log(r.map((c, i) => (i ? c.padStart(w[i]) : c.padEnd(w[i]))).join('  '));

if (hand.length) {
  const known = hand.filter((r) => r.ctxBefore > 0);
  const a = known.length ? `~${fmt(Math.round(known.reduce((s, r) => s + r.ctxBefore, 0) / known.length / 1000))}k ${cfg.lang === 'it' ? 'token' : 'tokens'}` : L.unknown;
  const b = fmt(Math.round(hand.reduce((s, r) => s + (r.handoffTokens || 0), 0) / hand.length));
  console.log(`\n${L.handoff}: ${L.hrow(hand.length, a, b)}`);
}

// Days before 0.7 used other thresholds: say so when both are in the table.
const first07 = rows.filter((r) => r.v && r.v >= '0.7').map((r) => r.ts.slice(0, 10)).sort()[0];
if (first07 && rows.some((r) => !r.v)) console.log('\n' + L.since(first07));
console.log('\n' + L.note);
