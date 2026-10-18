// Lists or deletes the known errors (errcache.js).
// Usage: node errors.js            list
//        node errors.js delete N   remove entry N from the list
//        node errors.js clear      remove all
'use strict';
const errcache = require('./errcache');
const lib = require('./lib');

const it = lib.config().lang === 'it';
const [cmd, arg] = process.argv.slice(2);
let list = errcache.load();

if (cmd === 'clear') {
  errcache.save([]);
  console.log(it ? `Cancellati ${list.length} errori.` : `Deleted ${list.length} errors.`);
  process.exit(0);
}
if (cmd === 'delete') {
  const n = parseInt(arg, 10);
  if (!(n >= 1 && n <= list.length)) { console.log(it ? 'Numero non valido.' : 'Invalid number.'); process.exit(0); }
  list.splice(n - 1, 1);
  errcache.save(list);
  console.log(it ? `Cancellato l'errore ${n}.` : `Deleted error ${n}.`);
  process.exit(0);
}

if (!list.length) { console.log(it ? 'Nessun errore salvato.' : 'No errors saved.'); process.exit(0); }
list.forEach((e, i) => {
  console.log(`${i + 1}. ${e.ts.slice(0, 10)} · ${e.project} · ${it ? 'riproposto' : 'reused'} ${e.hits || 0}x`);
  console.log(`   ${e.sample.replace(/\s+/g, ' ').slice(0, 140)}`);
  e.steps.forEach((s, j) => console.log(`   ${j + 1}) ${s}`));
});
console.log(it ? '\nSi cancellano da soli dopo 60 giorni. Per toglierne uno: /meno:errors delete N'
  : '\nEntries expire after 60 days. To remove one: /meno:errors delete N');
