// Measures the fixed context: what every session loads before the first message
// (instructions, memory index, skill descriptions, MCP servers, startup hooks), and
// what of it was actually used in the last N days, from the session transcripts.
// Read-only: it changes nothing. Usage: node hygiene.js [days=30]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

const days = parseInt(process.argv[2], 10) || 30;
const cfg = lib.config();
const it = cfg.lang === 'it';
const t = (a, b) => (it ? a : b);
const HOME = process.env.TOKEN_DIET_HOME || os.homedir();   // tests
const CLAUDE = path.join(HOME, '.claude');
const cwd = process.cwd();

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const json = (f) => { try { return JSON.parse(read(f)); } catch { return null; } };
const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const tok = (s) => lib.tokens(s.length);
const fmt = (n) => n.toLocaleString(it ? 'it-IT' : 'en-US');
const short = (f) => f.replace(HOME, '~');

// ---- 1. Instruction files ----
const instr = [];
const seen = new Set();
const inside = (p, root) => {
  const r = path.relative(root, p);
  return r && !r.startsWith('..') && !path.isAbsolute(r);
};
// root: where imports of this file may point. User files (~/.claude, config) are
// trusted; a project file (maybe from a cloned repo) only imports from its own folder
// or ~/.claude, so it cannot make the analysis step read files elsewhere.
function addFile(f, kind, depth, root) {
  f = path.resolve(f);
  if (root && !inside(f, root) && !inside(f, CLAUDE)) return;
  if (seen.has(f.toLowerCase())) return;
  const s = read(f);
  if (s === null) return;
  seen.add(f.toLowerCase());
  instr.push({ file: f, kind, text: s, tokens: tok(s), lines: s.split('\n').length });
  if ((depth || 0) >= 3) return;
  // @imports, outside code blocks
  const body = s.replace(/```[\s\S]*?```/g, '');
  for (const m of body.matchAll(/(?:^|\s)@([~\w./\\-]+\.md)\b/g)) {
    const p = m[1].startsWith('~') ? path.join(HOME, m[1].slice(1)) : path.resolve(path.dirname(f), m[1]);
    addFile(p, t('importato', 'imported'), (depth || 0) + 1, root);
  }
}
addFile(path.join(CLAUDE, 'CLAUDE.md'), t('globale', 'global'));
for (const f of ls(path.join(CLAUDE, 'rules'))) if (f.endsWith('.md')) addFile(path.join(CLAUDE, 'rules', f), 'rule');
for (let d = cwd, prev = ''; d !== prev; prev = d, d = path.dirname(d)) {
  for (const n of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) addFile(path.join(d, n), t('progetto', 'project'), 0, d);
}
for (const f of ls(path.join(cwd, '.claude', 'rules'))) if (f.endsWith('.md')) addFile(path.join(cwd, '.claude', 'rules', f), 'rule', 0, cwd);
addFile(path.join(CLAUDE, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), 'memory', 'MEMORY.md'), t('memoria', 'memory'));
for (const f of cfg.hygieneExtraFiles || []) addFile(f.replace(/^~/, HOME), t('extra', 'extra'));

// ---- 2. Skills ----
const settings = json(path.join(CLAUDE, 'settings.json')) || {};
const enabled = Object.keys(settings.enabledPlugins || {}).filter((k) => settings.enabledPlugins[k]);
const installed = (json(path.join(CLAUDE, 'plugins', 'installed_plugins.json')) || {}).plugins || {};
const pluginDirs = enabled.map((k) => ({ id: k, name: k.split('@')[0], dir: ((installed[k] || [])[0] || {}).installPath })).filter((p) => p.dir);

function frontmatter(s) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(s || '');
  const o = {};
  if (!m) return o;
  let last = null;
  for (const l of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(l);
    if (kv) {
      last = kv[1];
      o[last] = /^[>|][-+]?$/.test(kv[2]) ? '' : kv[2].replace(/^["']|["']$/g, '');
    } else if (last && /^\s+\S/.test(l)) {
      o[last] = (o[last] ? o[last] + ' ' : '') + l.trim();   // folded / multi-line value
    }
  }
  return o;
}

const skills = [];
function addSkills(dir, source, prefix) {
  for (const d of ls(dir)) {
    const s = read(path.join(dir, d, 'SKILL.md'));
    if (s === null) continue;
    const fm = frontmatter(s);
    const name = fm.name || d;
    skills.push({
      name: prefix ? `${prefix}:${name}` : name, dir: d, source,
      hidden: fm['disable-model-invocation'] === 'true',
      tokens: fm['disable-model-invocation'] === 'true' ? 0 : tok(name + ': ' + (fm.description || '')),
      descChars: (fm.description || '').length,
    });
  }
}
addSkills(path.join(CLAUDE, 'skills'), t('utente', 'user'));
addSkills(path.join(cwd, '.claude', 'skills'), t('progetto', 'project'));
for (const p of pluginDirs) {
  const pj = json(path.join(p.dir, '.claude-plugin', 'plugin.json')) || {};
  const extra = [].concat(pj.skills || []);
  for (const d of new Set(['skills', ...extra].map((x) => path.resolve(p.dir, x)))) addSkills(d, 'plugin ' + p.name, p.name);
}

// ---- 3. MCP servers ----
const cj = json(path.join(HOME, '.claude.json')) || {};
const mcp = [];
for (const k of Object.keys(cj.mcpServers || {})) mcp.push({ name: k, source: t('utente', 'user') });
const projCfg = Object.entries(cj.projects || {}).find(([p]) => path.resolve(p).toLowerCase() === cwd.toLowerCase());
for (const k of Object.keys((projCfg && projCfg[1].mcpServers) || {})) mcp.push({ name: k, source: t('progetto (locale)', 'project (local)') });
for (const k of Object.keys((json(path.join(cwd, '.mcp.json')) || {}).mcpServers || {})) mcp.push({ name: k, source: '.mcp.json' });
for (const p of pluginDirs) {
  const m = json(path.join(p.dir, '.mcp.json'));
  for (const k of Object.keys((m && (m.mcpServers || m)) || {})) mcp.push({ name: k, source: 'plugin ' + p.name });
}
const env = Object.assign({}, settings.env || {}, (json(path.join(cwd, '.claude', 'settings.json')) || {}).env, (json(path.join(cwd, '.claude', 'settings.local.json')) || {}).env);
const connectorsOff = String(env.ENABLE_CLAUDEAI_MCP_SERVERS || process.env.ENABLE_CLAUDEAI_MCP_SERVERS || '') === 'false';

// ---- 4. Startup hooks (they add text to every session) ----
const startHooks = [];
const hookCmds = (h) => ((h && h.SessionStart) || []).flatMap((g) => (g.hooks || []).map((x) => [x.command, ...(x.args || [])].join(' ')));
for (const c of hookCmds(settings.hooks)) startHooks.push({ source: t('utente', 'user'), cmd: c });
for (const p of pluginDirs) {
  const h = json(path.join(p.dir, 'hooks', 'hooks.json'));
  for (const c of hookCmds(h && h.hooks)) startHooks.push({ source: 'plugin ' + p.name, cmd: c });
}

// ---- 5. Usage in the last N days, from transcripts ----
const since = Date.now() - days * 864e5;
const usedSkills = new Map(), usedMcp = new Map();
let nFiles = 0;
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
for (const p of ls(path.join(CLAUDE, 'projects'))) {
  const dir = path.join(CLAUDE, 'projects', p);
  for (const f of ls(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const full = path.join(dir, f);
    let st; try { st = fs.statSync(full); } catch { continue; }
    if (st.mtimeMs < since) continue;
    const s = read(full);
    if (!s) continue;
    nFiles++;
    for (const m of s.matchAll(/"name":"Skill","input":\{"skill":"([^"]+)"/g)) bump(usedSkills, m[1]);
    for (const m of s.matchAll(/<command-name>\/?([^<\s]+)<\/command-name>/g)) bump(usedSkills, m[1]);
    for (const m of s.matchAll(/"type":"tool_use","id":"[^"]*","name":"mcp__(.+?)__/g)) bump(usedMcp, m[1]);
  }
}
const skillUses = (sk) => {
  let n = 0;
  for (const [k, v] of usedSkills) {
    const base = k.includes(':') ? k.split(':').pop() : k;
    if (k === sk.name || base === sk.dir || base === sk.name.split(':').pop()) n += v;
  }
  return n;
};
const mcpUses = (name) => {
  let n = 0;
  for (const [k, v] of usedMcp) if (k === name || k.replace(/^plugin_[^_]+_/, '') === name) n += v;
  return n;
};

// ---- 6. Duplicate lines across instruction files ----
const lineMap = new Map();
for (const f of instr) {
  for (const raw of f.text.split('\n')) {
    const l = raw.trim().replace(/^[-*#>\s]+/, '');
    if (l.length < 30) continue;
    const k = l.toLowerCase();
    if (!lineMap.has(k)) lineMap.set(k, { line: l, files: [] });
    lineMap.get(k).files.push(short(f.file));
  }
}
const dups = [...lineMap.values()].filter((d) => d.files.length > 1);

// ---- Report ----
const out = [];
const P = (s) => out.push(s);
const instrTot = instr.reduce((s, f) => s + f.tokens, 0);
const skillTot = skills.reduce((s, k) => s + k.tokens, 0);

P(t(`token-diet hygiene — contesto fisso (${short(cwd)}), utilizzo negli ultimi ${days} giorni (${nFiles} sessioni)`,
  `token-diet hygiene — fixed context (${short(cwd)}), usage in the last ${days} days (${nFiles} sessions)`));
P('');
P(t(`Istruzioni caricate a ogni sessione: ~${fmt(instrTot)} token`, `Instructions loaded every session: ~${fmt(instrTot)} tokens`));
for (const f of instr.sort((a, b) => b.tokens - a.tokens)) {
  const flag = f.lines > 200 ? t('  ← lungo', '  ← long') : '';
  P(`  ${String(fmt(f.tokens)).padStart(6)}  ${f.kind.padEnd(10)} ${short(f.file)} (${f.lines} ${t('righe', 'lines')})${flag}`);
}
P('');
P(t(`Skill: ${skills.length}, descrizioni ~${fmt(skillTot)} token a sessione`, `Skills: ${skills.length}, descriptions ~${fmt(skillTot)} tokens per session`));
const groups = {};
for (const s of skills) (groups[s.source] = groups[s.source] || []).push(s);
for (const [src, list] of Object.entries(groups)) {
  const unused = list.filter((s) => !skillUses(s));
  P(`  ${src}: ${list.length} skill, ~${fmt(list.reduce((a, s) => a + s.tokens, 0))} token` +
    (unused.length ? t(` — mai usate: ${unused.length}`, ` — never used: ${unused.length}`) : ''));
  for (const s of list) {
    const n = skillUses(s);
    const notes = [n ? t(`usata ${n}x`, `used ${n}x`) : t('mai usata', 'never used')];
    if (s.descChars > 500) notes.push(t(`descrizione lunga (${s.descChars} caratteri)`, `long description (${s.descChars} chars)`));
    if (s.hidden) notes.push(t('solo comando, non pesa', 'command only, no cost'));
    P(`      ${s.name.padEnd(36)} ${String(s.tokens).padStart(4)}  ${notes.join(', ')}`);
  }
}
P('');
P(t('Server MCP:', 'MCP servers:'));
if (!mcp.length) P(t('  nessuno configurato', '  none configured'));
for (const m of mcp) {
  const n = mcpUses(m.name);
  P(`  ${m.name.padEnd(24)} ${m.source.padEnd(20)} ${n ? t(`usato ${n}x`, `used ${n}x`) : t('mai usato', 'never used')}`);
}
P(t(`  Connettori claude.ai: ${connectorsOff ? 'esclusi' : 'attivi (ENABLE_CLAUDEAI_MCP_SERVERS non è false)'}`,
  `  claude.ai connectors: ${connectorsOff ? 'off' : 'on (ENABLE_CLAUDEAI_MCP_SERVERS is not false)'}`));
P('');
P(t('Hook all\'avvio (aggiungono testo a ogni sessione):', 'Startup hooks (add text to every session):'));
if (!startHooks.length) P(t('  nessuno', '  none'));
for (const h of startHooks) P(`  ${h.source.padEnd(20)} ${h.cmd.length > 90 ? h.cmd.slice(0, 90) + '…' : h.cmd}`);
P('');
P(t(`Righe duplicate tra i file di istruzioni: ${dups.length}`, `Duplicate lines across instruction files: ${dups.length}`));
for (const d of dups.slice(0, 15)) P(`  "${d.line.slice(0, 80)}" — ${[...new Set(d.files)].join(', ')}`);
P('');
P(t(`Totale stimato misurabile: ~${fmt(instrTot + skillTot)} token fissi a sessione (più i nomi dei tool MCP, non misurabili da qui).`,
  `Estimated measurable total: ~${fmt(instrTot + skillTot)} fixed tokens per session (plus MCP tool names, not measurable from here).`));
P(t('Stima: 1 token ogni 4 caratteri.', 'Estimate: 1 token per 4 characters.'));
console.log(out.join('\n'));

// File list for the analysis step (second part of the skill).
if (process.argv.includes('--files')) console.log('\nFILES:\n' + instr.map((f) => f.file).join('\n'));
