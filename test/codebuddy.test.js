import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { parse, resolveCodebuddyRoots } from '../src/parsers/codebuddy.js';
import { parsers } from '../src/parsers/index.js';
import { TOOLS } from '../src/tools.js';

const start = Date.parse('2026-09-17T06:26:03.095Z');

// Record shapes copied from a real store + the CLI's own transcript writer
// (2.151.0): local turns are `{type:"message", role, content, sessionId, cwd}`,
// model calls are the API message shape carrying `message.usage`.
const userRecord = {
  id: 'b7f0c1de-1111-4a11-8a11-000000000001', parentId: null, timestamp: start,
  type: 'message', role: 'user', content: [{ type: 'input_text', text: 'DO NOT UPLOAD' }],
  sessionId: '01a0ae1f-5636-772f-af89-4d1f303fff8f', cwd: '/work/demo-project',
  providerData: { agent: 'main' },
};
const assistantRecord = (overrides = {}) => ({
  type: 'assistant', uuid: 'a926766d-e771-47d2-b275-6d5456df4c02',
  session_id: '01a0ae1f-5636-772f-af89-4d1f303fff8f', timestamp: start + 2000,
  sessionId: '01a0ae1f-5636-772f-af89-4d1f303fff8f', cwd: '/work/demo-project',
  message: {
    id: 'msg_01a926766d', model: 'claude-sonnet-4-6', role: 'assistant', type: 'message',
    usage: {
      input_tokens: 100, output_tokens: 47, cache_read_input_tokens: 1344,
      cache_creation_input_tokens: 10, cache_creation: null,
    },
  },
  ...overrides,
});

function writeTranscript(root, folder, sessionId, records) {
  const dir = join(root, 'projects', folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`),
    `${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf-8');
  return dir;
}

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-codebuddy-'));
  const previous = process.env.VIBE_USAGE_CODEBUDDY_DIRS;
  process.env.VIBE_USAGE_CODEBUDDY_DIRS = root;
  try { await run(root); }
  finally {
    if (previous === undefined) delete process.env.VIBE_USAGE_CODEBUDDY_DIRS;
    else process.env.VIBE_USAGE_CODEBUDDY_DIRS = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test('codebuddy is registered and honors CODEBUDDY_CONFIG_DIR / the fixture override', () => {
  assert.equal(typeof parsers.codebuddy, 'function');
  assert.equal(TOOLS.find(tool => tool.id === 'codebuddy')?.name, 'CodeBuddy');
  assert.deepEqual(resolveCodebuddyRoots({ VIBE_USAGE_CODEBUDDY_DIRS: '/a:/b' }), ['/a', '/b']);
  assert.deepEqual(resolveCodebuddyRoots({ CODEBUDDY_CONFIG_DIR: '/custom/.codebuddy' }), ['/custom/.codebuddy']);
  assert.deepEqual(resolveCodebuddyRoots({}, '/home/me'), [join('/home/me', '.codebuddy')]);
  assert.deepEqual(resolveCodebuddyRoots({ VIBE_USAGE_CODEBUDDY_DIRS: `/x${delimiter}/y` }), ['/x', '/y']);
});

test('codebuddy reads API-message usage, folds cache writes into input, keeps prompts human', async () => fixture(async root => {
  writeTranscript(root, 'private-work-demo-project', 'session-1', [
    userRecord,
    // Injected/tool-driven turns must not count as human prompts.
    { ...userRecord, id: 'meta-1', providerData: { isMeta: true, skipRun: true } },
    assistantRecord(),
  ]);

  const result = await parse();
  assert.equal(result.skipped, undefined);
  assert.equal(result.buckets.length, 1);
  const bucket = result.buckets[0];
  assert.equal(bucket.source, 'codebuddy');
  assert.equal(bucket.model, 'claude-sonnet-4-6');
  assert.equal(bucket.project, 'demo-project'); // from the record's cwd
  assert.equal(bucket.inputTokens, 110); // input_tokens + cache_creation_input_tokens
  assert.equal(bucket.cachedInputTokens, 1344);
  assert.equal(bucket.outputTokens, 47);
  assert.equal(bucket.reasoningOutputTokens, 0);
  assert.equal(bucket.totalTokens, 157);

  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].project, 'demo-project');
  assert.equal(result.sessions[0].userMessageCount, 1);
  assert.equal(result.sessions[0].messageCount, 2);

  // Never retain or upload the transcript's text.
  assert.equal(JSON.stringify(result).includes('DO NOT UPLOAD'), false);
}));

test('codebuddy collapses a retried/copied call onto its most complete payload', async () => fixture(async root => {
  const zeroed = assistantRecord();
  zeroed.message.usage = {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
    cache_creation_input_tokens: null, cache_creation: null,
  };
  writeTranscript(root, 'private-work-demo-project', 'session-1', [userRecord, zeroed, assistantRecord()]);

  const result = await parse();
  assert.equal(result.buckets.length, 1, 'one logical call must produce one bucket');
  assert.equal(result.buckets[0].inputTokens, 110);
}));

test('codebuddy falls back to the compressed folder name when a record has no cwd', async () => fixture(async root => {
  const withoutCwd = assistantRecord({ timestamp: start + 4000 });
  delete withoutCwd.cwd;
  withoutCwd.message = { ...withoutCwd.message, id: 'msg_other' };
  writeTranscript(root, 'private-tmp-cb-probe', 'session-2', [
    { ...userRecord, cwd: undefined },
    withoutCwd,
  ]);

  const result = await parse();
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].project, 'probe');
}));

test('codebuddy without a projects dir is simply empty, not skipped', async () => fixture(async () => {
  const result = await parse();
  assert.deepEqual(result.buckets, []);
  assert.deepEqual(result.sessions, []);
  assert.equal(result.skipped, undefined);
}));
