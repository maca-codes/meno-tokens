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
    head: ['Giorno', 'Output tagliati', 'Letture evitate', 'Riletture evitate', 'Ripensamenti', 'Cicli fermati', 'Errori riconosciuti', 'Token risparmiati'],
    total: 'Totale', handoff: 'Ripartenze con riassunto',
    hrow: (n, a, b) => `${n} — contesto medio da ${a}k a ${b}k token per messaggio`,
    note: 'Stima: 1 token ogni 4 caratteri. "Ripensamenti" = letture bloccate e poi ripetute: il loro risparmio è già tolto. "Cicli fermati" = tentativi uguali falliti 3 volte: risparmio non stimato. "Errori riconosciuti" = errori già risolti in passato, soluzione passata a Claude.',
  },
  en: {
    title: `token-diet — last ${days} days`, none: 'No interventions recorded yet.',
    head: ['Day', 'Outputs trimmed', 'Big reads avoided', 'Re-reads avoided', 'Overrides', 'Loops stopped', 'Known errors', 'Tokens saved'],
    total: 'Total', handoff: 'Restarts with handoff',
    hrow: (n, a, b) => `${n} — average context from ${a}k to ${b}k tokens per message`,
    note: 'Estimate: 1 token per 4 characters. "Overrides" = blocked reads the model repeated; their saving is already taken back. "Loops stopped" = the same failed attempt 3 times; saving not estimated. "Known errors" = errors fixed before, earlier fix passed to Claude.',
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
for (const d of dirs()) {
  try {
    rows.push(...fs.readFileSync(path.join(d, 'events.jsonl'), 'utf8').trim().split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
  } catch {}
}
const since = Date.now() - days * 864e5;
rows = rows.filter((r) => Date.parse(r.ts) >= since);

console.log(L.title);
if (!rows.length) { console.log(L.none); process.exit(0); }

const byDay = {};
const hand = [];
for (const r of rows) {
  const d = r.ts.slice(0, 10);
  const b = byDay[d] || (byDay[d] = { trim: 0, bigread: 0, reread: 0, override: 0, loop: 0, errhit: 0, saved: 0 });
  if (r.kind === 'handoff') { hand.push(r); continue; }
  b[r.kind] = (b[r.kind] || 0) + 1;
  b.saved += r.saved || 0;
}

const fmt = (n) => n.toLocaleString(cfg.lang === 'it' ? 'it-IT' : 'en-US');
const table = [L.head];
const tot = { trim: 0, bigread: 0, reread: 0, override: 0, loop: 0, errhit: 0, saved: 0 };
for (const d of Object.keys(byDay).sort()) {
  const b = byDay[d];
  for (const k in tot) tot[k] += b[k] || 0;
  table.push([d, b.trim, b.bigread, b.reread, b.override, b.loop, b.errhit, fmt(b.saved)].map(String));
}
table.push([L.total, tot.trim, tot.bigread, tot.reread, tot.override, tot.loop, tot.errhit, fmt(tot.saved)].map(String));
const w = L.head.map((_, i) => Math.max(...table.map((r) => r[i].length)));
for (const r of table) console.log(r.map((c, i) => (i ? c.padStart(w[i]) : c.padEnd(w[i]))).join('  '));

if (hand.length) {
  const a = Math.round(hand.reduce((s, r) => s + (r.ctxBefore || 0), 0) / hand.length / 1000);
  const b = Math.round(hand.reduce((s, r) => s + (r.handoffTokens || 0), 0) / hand.length / 1000);
  console.log(`\n${L.handoff}: ${L.hrow(hand.length, a, b)}`);
}
console.log('\n' + L.note);
