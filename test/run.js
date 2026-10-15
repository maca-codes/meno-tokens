// Smoke tests: feeds fake hook inputs to each script and checks the outputs.
// Usage: node test/run.js   (uses a temporary data dir, touches nothing else)
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-diet-test-'));
const env = Object.assign({}, process.env, { CLAUDE_PLUGIN_DATA: path.join(tmp, 'data'), TOKEN_DIET_LANG: 'en' });

function run(script, input) {
  const o = execFileSync('node', [path.join(root, 'scripts', script)], { input: JSON.stringify(input), env }).toString();
  return o ? JSON.parse(o) : null;
}
let n = 0;
function test(name, fn) { fn(); n++; console.log('ok -', name); }

const big = Array.from({ length: 3000 }, (_, i) => `line ${i + 1} some padding text` + (i === 1500 ? ' ERROR boom' : '')).join('\n');
const bigFile = path.join(tmp, 'big.txt');
fs.writeFileSync(bigFile, big);
const S = { session_id: 's1', cwd: tmp };

test('long Bash output is trimmed, keeps errors, saves full copy', () => {
  const r = run('post-tool.js', Object.assign({}, S, { tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: 'x' },
    tool_response: { stdout: big, stderr: '', interrupted: false, isImage: false } }));
  const o = r.hookSpecificOutput.updatedToolOutput;
  assert(o.stdout.length < big.length / 5);
  assert(o.stdout.includes('ERROR boom'));
  assert(o.stdout.includes('line 1 ') && o.stdout.includes('line 3000'));
  assert.strictEqual(o.interrupted, false);
  const file = o.stdout.match(/Full output: (.+?) \(/)[1];
  assert.strictEqual(fs.readFileSync(file, 'utf8'), big);
});

test('short Bash output is untouched', () => {
  assert.strictEqual(run('post-tool.js', Object.assign({}, S, { tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: { stdout: 'hi', stderr: '' } })), null);
});

test('"# full" comment skips trimming', () => {
  assert.strictEqual(run('post-tool.js', Object.assign({}, S, { tool_name: 'Bash', tool_input: { command: 'cat x # full' }, tool_response: { stdout: big, stderr: '' } })), null);
});

test('minified single long line is cut', () => {
  const line = 'x'.repeat(20000);
  const r = run('post-tool.js', Object.assign({}, S, { tool_name: 'Bash', tool_use_id: 'tu2', tool_input: { command: 'x' }, tool_response: { stdout: line, stderr: '' } }));
  assert(r.hookSpecificOutput.updatedToolOutput.stdout.length < 1000);
});

test('long Grep content is trimmed', () => {
  const r = run('post-tool.js', Object.assign({}, S, { tool_name: 'Grep', tool_use_id: 'tu3', tool_input: {},
    tool_response: { mode: 'content', numFiles: 0, filenames: [], content: big, numLines: 3000 } }));
  const o = r.hookSpecificOutput.updatedToolOutput;
  assert(o.content.length < big.length / 5);
  assert.strictEqual(o.mode, 'content');
});

const read = (extra) => Object.assign({}, S, { tool_name: 'Read', tool_input: Object.assign({ file_path: bigFile }, extra) });

test('whole read of big file is denied once, then allowed', () => {
  const r = run('pre-tool.js', read({}));
  assert.strictEqual(r.hookSpecificOutput.permissionDecision, 'deny');
  assert.strictEqual(run('pre-tool.js', read({})), null);
});

test('ranged read is allowed', () => {
  assert.strictEqual(run('pre-tool.js', read({ offset: 1, limit: 50 })), null);
});

test('re-read of unchanged range is denied once; other ranges pass', () => {
  run('post-tool.js', read({ offset: 10, limit: 100 }));
  assert.strictEqual(run('pre-tool.js', read({ offset: 20, limit: 10 })).hookSpecificOutput.permissionDecision, 'deny');
  assert.strictEqual(run('pre-tool.js', read({ offset: 20, limit: 10 })), null);
  assert.strictEqual(run('pre-tool.js', read({ offset: 500, limit: 10 })), null);
});

test('re-read after the file changed is allowed', () => {
  run('post-tool.js', read({ offset: 1, limit: 5 }));
  fs.appendFileSync(bigFile, '\nmore');
  assert.strictEqual(run('pre-tool.js', read({ offset: 1, limit: 5 })), null);
});

test('subagent reads do not count for the main thread', () => {
  run('post-tool.js', Object.assign(read({ offset: 1, limit: 7 }), { agent_id: 'sub1' }));
  assert.strictEqual(run('pre-tool.js', read({ offset: 1, limit: 7 })), null);
});

test('context warning fires once per threshold', () => {
  const tr = path.join(tmp, 't.jsonl');
  const usage = { input_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 90000 };
  fs.writeFileSync(tr, JSON.stringify({ type: 'assistant', isSidechain: false, message: { usage } }) + '\n' +
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { usage: { input_tokens: 1 } } }) + '\n');
  const inp = { session_id: 's2', cwd: tmp, transcript_path: tr };
  assert(/91k tokens/.test(run('prompt.js', inp).systemMessage));
  assert.strictEqual(run('prompt.js', inp), null);
});

test('handoff note is injected after /clear and consumed', () => {
  fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.claude', 'handoff.md'), '# Handoff\n## Goal\nTest');
  const r = run('session-start.js', { session_id: 's3', cwd: tmp, source: 'clear' });
  assert(r.hookSpecificOutput.additionalContext.includes('## Goal'));
  assert(fs.existsSync(path.join(tmp, '.claude', 'handoff.used.md')));
  assert.strictEqual(run('session-start.js', { session_id: 's4', cwd: tmp, source: 'startup' }), null);
});

test('report adds up savings and takes back overrides', () => {
  const o = execFileSync('node', [path.join(root, 'scripts', 'report.js')], { env }).toString();
  assert(/Total/.test(o) && /Restarts with handoff: 1/.test(o));
});

console.log(`\n${n} tests passed`);
fs.rmSync(tmp, { recursive: true, force: true });
