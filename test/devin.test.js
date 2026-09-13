import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCHEMA = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    working_directory TEXT NOT NULL,
    backend_type TEXT NOT NULL,
    model TEXT NOT NULL,
    agent_mode TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    title TEXT, main_chain_id INTEGER, shell_last_seen_index INTEGER DEFAULT 0,
    cogs_json TEXT, workspace_dirs TEXT, hidden INTEGER NOT NULL DEFAULT 0,
    metadata TEXT
  );
  CREATE TABLE message_nodes (
    row_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    node_id INTEGER NOT NULL,
    parent_node_id INTEGER,
    chat_message TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    metadata TEXT
  );
`;

function msg(id, role, { metrics = null, isUserInput = null, model = null } = {}) {
  return JSON.stringify({
    message_id: id,
    role,
    content: 'unused',
    metadata: {
      is_user_input: isUserInput,
      generation_model: model,
      metrics,
    },
  });
}

function metrics({ input = 0, output = 0, cacheRead = 0, cacheCreation = null } = {}) {
  return {
    ttft_ms: null, total_time_ms: 1000,
    input_tokens: input, output_tokens: output,
    cache_read_tokens: cacheRead, cache_creation_tokens: cacheCreation,
    tpot_ms: 1, tokens_per_sec: 10,
  };
}

async function parseFixture(t, { statements }) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-devin-test-'));
  const dbPath = join(root, 'sessions.db');
  const previous = process.env.VIBE_USAGE_DEVIN_DB;
  t.after(() => {
    if (previous === undefined) delete process.env.VIBE_USAGE_DEVIN_DB;
    else process.env.VIBE_USAGE_DEVIN_DB = previous;
    rmSync(root, { recursive: true, force: true });
  });

  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* Node 20 uses sqlite3. */ }
  const sessionRows = [
    `INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, hidden)
     VALUES ('s1', '/home/u/proj-alpha', 'windsurf', 'adaptive', 'bypass', 1789000000, 1789001000, 0)`,
    `INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, hidden)
     VALUES ('s2-fork', '/home/u/proj-alpha', 'windsurf', 'glm-5-2', 'bypass', 1789005000, 1789006000, 0)`,
    `INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, hidden)
     VALUES ('s3-hidden', '/home/u/proj-beta', 'windsurf', 'swe-1-7', 'bypass', 1789000000, 1789001000, 1)`,
  ];
  const fullSql = SCHEMA + sessionRows.join(';\n') + ';\n' + statements.map(s => {
    const lit = v => v === null ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`;
    return `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
      VALUES (${lit(s.session)}, ${s.node}, ${s.parent === undefined ? 'NULL' : s.parent}, ${lit(s.msg)}, ${s.ts});`;
  }).join('\n');

  if (DatabaseSync) {
    const db = new DatabaseSync(dbPath);
    try { db.exec(fullSql); } finally { db.close(); }
  } else {
    execFileSync('sqlite3', [dbPath, fullSql]);
  }
  process.env.VIBE_USAGE_DEVIN_DB = dbPath;
  const { parse } = await import(`../src/parsers/devin.js?fixture=${encodeURIComponent(root)}`);
  return parse();
}

test('Devin reads real per-call metrics, dedupes fork copies globally, and maps cache fields', async (t) => {
  const result = await parseFixture(t, {
    statements: [
      // Session s1: one user turn, two assistant calls.
      { session: 's1', node: 0, ts: 1789000010, msg: msg('u1', 'user', { isUserInput: true }) },
      { session: 's1', node: 1, ts: 1789000020, msg: msg('a1', 'assistant', { model: 'swe-2-high', metrics: metrics({ input: 100, output: 50, cacheRead: 5000, cacheCreation: 200 }) }) },
      { session: 's1', node: 2, ts: 1789000030, msg: msg('a2', 'assistant', { model: 'swe-2-high', metrics: metrics({ input: 10, output: 20, cacheRead: 7000 }) }) },

      // Fork s2 copies the whole s1 prefix verbatim (same message_ids,
      // original timestamps) then adds its own turn.
      { session: 's2-fork', node: 0, ts: 1789000010, msg: msg('u1', 'user', { isUserInput: true }) },
      { session: 's2-fork', node: 1, ts: 1789000020, msg: msg('a1', 'assistant', { model: 'swe-2-high', metrics: metrics({ input: 100, output: 50, cacheRead: 5000, cacheCreation: 200 }) }) },
      { session: 's2-fork', node: 2, ts: 1789000030, msg: msg('a2', 'assistant', { model: 'swe-2-high', metrics: metrics({ input: 10, output: 20, cacheRead: 7000 }) }) },
      { session: 's2-fork', node: 3, ts: 1789005100, msg: msg('u2', 'user', { isUserInput: true }) },
      { session: 's2-fork', node: 4, ts: 1789005110, msg: msg('a3', 'assistant', { model: 'glm-5-2', metrics: metrics({ input: 5, output: 5, cacheRead: 9000 }) }) },
    ],
  });

  // Copied a1/a2 must not double-count: total input = (100+200)+10+5 = 315,
  // output = 50+20+5 = 75, cacheRead = 5000+7000+9000 = 21000.
  const total = result.buckets.reduce((acc, b) => ({
    input: acc.input + b.inputTokens,
    output: acc.output + b.outputTokens,
    cached: acc.cached + b.cachedInputTokens,
  }), { input: 0, output: 0, cached: 0 });
  assert.equal(total.input, 315);
  assert.equal(total.output, 75);
  assert.equal(total.cached, 21000);
  assert.equal(result.buckets.every(b => b.source === 'devin' && b.project === 'proj-alpha'), true);
});

test('Devin sessions count only real user prompts and skip fork-copied prefix events', async (t) => {
  const result = await parseFixture(t, {
    statements: [
      { session: 's1', node: 0, ts: 1789000010, msg: msg('u1', 'user', { isUserInput: true }) },
      { session: 's1', node: 1, ts: 1789000020, msg: msg('a1', 'assistant', { metrics: metrics({ output: 10 }) }) },
      // Internal summarize request — role user but no is_user_input flag.
      { session: 's1', node: 2, ts: 1789000040, msg: msg('sum1', 'user', { isUserInput: null }) },
      { session: 's1', node: 3, ts: 1789000050, msg: msg('a2', 'assistant', { metrics: metrics({ output: 5 }) }) },

      // Fork: prefix copies carry original timestamps (< fork session's
      // created_at) and must not stretch the fork session's duration.
      { session: 's2-fork', node: 0, ts: 1789000010, msg: msg('u1', 'user', { isUserInput: true }) },
      { session: 's2-fork', node: 1, ts: 1789000020, msg: msg('a1', 'assistant', { metrics: metrics({ output: 10 }) }) },
      { session: 's2-fork', node: 2, ts: 1789005100, msg: msg('u2', 'user', { isUserInput: true }) },
      { session: 's2-fork', node: 3, ts: 1789005110, msg: msg('a3', 'assistant', { metrics: metrics({ output: 5 }) }) },
    ],
  });

  assert.equal(result.sessions.length, 2);
  const s1 = result.sessions.find(s => s.messageCount === 3 || s.userMessageCount === 1);
  assert.ok(s1);
  assert.equal(s1.userMessageCount, 1); // sum1 (internal) is not a user prompt
  assert.equal(s1.messageCount, 3);     // u1 + a1 + a2

  const fork = result.sessions.find(s => s !== s1);
  assert.equal(fork.userMessageCount, 1);
  assert.equal(fork.messageCount, 2);   // only u2 + a3, prefix excluded
  assert.equal(fork.firstMessageAt, new Date(1789005100 * 1000).toISOString());
});

test('Devin skips hidden sessions and falls back past routing-mode model ids', async (t) => {
  const result = await parseFixture(t, {
    statements: [
      // Hidden session — excluded entirely.
      { session: 's3-hidden', node: 0, ts: 1789000010, msg: msg('h1', 'user', { isUserInput: true }) },
      { session: 's3-hidden', node: 1, ts: 1789000020, msg: msg('h2', 'assistant', { metrics: metrics({ input: 999, output: 999 }) }) },
      // Visible session: generation_model missing → sessions.model 'adaptive'
      // is a routing mode, not a model.
      { session: 's1', node: 0, ts: 1789000010, msg: msg('u1', 'user', { isUserInput: true }) },
      { session: 's1', node: 1, ts: 1789000020, msg: msg('a1', 'assistant', { model: null, metrics: metrics({ output: 7 }) }) },
    ],
  });

  const total = result.buckets.reduce((acc, b) => acc + b.outputTokens, 0);
  assert.equal(total, 7); // hidden session's 999 excluded
  assert.equal(result.buckets[0].model, 'unknown');
  assert.equal(result.sessions.length, 1);
});

test('Devin returns empty when the database is absent', async (t) => {
  const previous = process.env.VIBE_USAGE_DEVIN_DB;
  t.after(() => {
    if (previous === undefined) delete process.env.VIBE_USAGE_DEVIN_DB;
    else process.env.VIBE_USAGE_DEVIN_DB = previous;
  });
  process.env.VIBE_USAGE_DEVIN_DB = join(tmpdir(), 'definitely-missing-devin-sessions.db');
  const { parse } = await import('../src/parsers/devin.js?fixture=missing');
  const result = await parse();
  assert.deepEqual(result, { buckets: [], sessions: [] });
});
