import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverQuotaProducts, fetchQuotaProducts } from '../src/quotas/registry.js';
import {
  fetchKimiCodeQuota,
  kimiCredentialPath,
  parseKimiUsage,
} from '../src/quotas/providers/kimi-code.js';
import { fetchZaiQuota, parseZaiQuota } from '../src/quotas/providers/zai.js';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const kimiPayload = {
  usage: { name: 'Weekly', used: 25, limit: 100, reset_at: '2026-09-14T00:00:00Z' },
  limits: [
    {
      window: { duration: 300, timeUnit: 'MINUTE' },
      detail: { remaining: 80, limit: 100, resetAt: '2026-09-07T05:00:00Z' },
    },
  ],
};

const zaiPayload = {
  code: 200,
  msg: 'success',
  success: true,
  data: {
    planName: 'Pro',
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 25, nextResetTime: 1785816000000 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 9, nextResetTime: 1786291200000 },
      { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 1000, currentValue: 224,
        remaining: 776, percentage: 22 },
    ],
  },
};

test('quota discovery uses presence signals and advertises Cursor as non-fetchable', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-quota-discovery-'));
  const bin = join(root, 'bin');
  mkdirSync(join(root, '.kimi-code'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(bin, 'zcode'), '#!/bin/sh\n');
  chmodSync(join(bin, 'zcode'), 0o700);
  try {
    const envelope = discoverQuotaProducts({
      environment: { PATH: bin },
      home: root,
      platform: 'linux',
    });
    assert.equal(envelope.schemaVersion, 1);
    assert.deepEqual(envelope.products, [
      { id: 'kimi-code', detected: true, fetchable: true },
      { id: 'zcode', detected: true, fetchable: true },
      { id: 'cursor-grok', detected: false, fetchable: false },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Kimi parser supports summary, detail.remaining, duration, and reset spellings', () => {
  const meters = parseKimiUsage(kimiPayload, new Date('2026-09-07T00:00:00Z'));
  assert.equal(meters.length, 2);
  assert.deepEqual(meters[0], {
    id: '0-weekly',
    label: 'Weekly',
    utilization: 25,
    resetsAt: '2026-09-14T00:00:00.000Z',
  });
  assert.equal(meters[1].label, '5h');
  assert.equal(meters[1].utilization, 20);
  assert.equal(meters[1].windowSeconds, 18_000);
  assert.equal(meters[1].resetsAt, '2026-09-07T05:00:00.000Z');
});

test('Kimi fetch reads its official file, never refreshes it, and sends bearer auth', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-kimi-quota-'));
  const share = join(root, 'share');
  mkdirSync(join(share, 'credentials'), { recursive: true });
  writeFileSync(join(share, 'credentials', 'kimi-code.json'), JSON.stringify({
    access_token: 'kimi-fixture-token',
    refresh_token: 'must-not-be-used',
    expires_at: 2_000_000_000,
  }));
  let authorization;
  try {
    assert.equal(kimiCredentialPath({ KIMI_SHARE_DIR: share }, root),
      join(share, 'credentials', 'kimi-code.json'));
    const result = await fetchKimiCodeQuota({
      environment: { KIMI_SHARE_DIR: share },
      home: root,
      now: new Date('2026-09-07T00:00:00Z'),
      fetchImpl: async (_url, request) => {
        authorization = request.headers.Authorization;
        return jsonResponse(kimiPayload);
      },
    });
    assert.equal(authorization, 'Bearer kimi-fixture-token');
    assert.equal(result.status, 'ok');
    assert.equal(result.meters.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Kimi expired credentials return a provider status without network access', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-kimi-expired-'));
  mkdirSync(join(root, '.kimi', 'credentials'), { recursive: true });
  writeFileSync(join(root, '.kimi', 'credentials', 'kimi-code.json'), JSON.stringify({
    access_token: 'expired',
    refresh_token: 'not-refreshed',
    expires_at: 1,
  }));
  let called = false;
  try {
    const result = await fetchKimiCodeQuota({
      environment: {},
      home: root,
      now: new Date('2026-09-07T00:00:00Z'),
      fetchImpl: async () => { called = true; },
    });
    assert.equal(result.status, 'expired_credentials');
    assert.equal(called, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Z.ai parser maps plan windows and count-derived MCP utilization', () => {
  const parsed = parseZaiQuota(zaiPayload, new Date('2026-08-01T00:00:00Z'));
  assert.equal(parsed.planLabel, 'Pro');
  assert.deepEqual(parsed.meters.map(meter => [meter.label, meter.utilization]), [
    ['5h', 25],
    ['7d', 9],
    ['MCP', 22.4],
  ]);
  assert.equal(parsed.meters[0].windowSeconds, 5 * 3600);
  assert.equal(parsed.meters[1].windowSeconds, 7 * 86400);
});

test('provider meter identifiers remain unique when upstream identifiers repeat', () => {
  const kimi = parseKimiUsage({
    limits: [
      { id: 'same', name: 'Primary', used: 1, limit: 10 },
      { id: 'same', name: 'Secondary', used: 2, limit: 10 },
    ],
  });
  assert.deepEqual(kimi.map(meter => meter.id), ['0-same', '1-same']);

  const zai = parseZaiQuota({
    code: 200,
    success: true,
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 },
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 20 },
      ],
    },
  });
  assert.deepEqual(zai.meters.map(meter => meter.id), [
    '0-tokens_limit-3-5',
    '1-tokens_limit-3-5',
  ]);
});

test('Z.ai fetch requires an explicit key and isolates authorization failure', async () => {
  let called = false;
  const missing = await fetchZaiQuota({
    environment: {},
    fetchImpl: async () => { called = true; },
  });
  assert.equal(missing.status, 'missing_credentials');
  assert.equal(called, false);

  let authorization;
  const denied = await fetchZaiQuota({
    environment: { Z_AI_API_KEY: 'zai-fixture-key' },
    fetchImpl: async (_url, request) => {
      authorization = request.headers.Authorization;
      return jsonResponse({}, 401);
    },
  });
  assert.equal(authorization, 'Bearer zai-fixture-key');
  assert.equal(denied.status, 'unauthorized');
});

test('fetch handles only requested products and uses sanitized cache on transient failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-quota-cache-'));
  mkdirSync(join(root, '.kimi', 'credentials'), { recursive: true });
  writeFileSync(join(root, '.kimi', 'credentials', 'kimi-code.json'), JSON.stringify({
    access_token: 'must-never-enter-cache',
    expires_at: 2_000_000_000,
  }));
  const environment = { VIBE_USAGE_QUOTA_CACHE_DIR: join(root, 'cache') };
  try {
    const live = await fetchQuotaProducts(['kimi-code'], {
      environment,
      home: root,
      now: new Date('2026-09-07T00:00:00Z'),
      fetchImpl: async () => jsonResponse(kimiPayload),
    });
    assert.deepEqual(live.products.map(product => product.id), ['kimi-code']);
    assert.equal(live.products[0].source, 'live');
    const cacheText = readFileSync(join(root, 'cache', 'quota-cache.json'), 'utf8');
    assert.equal(cacheText.includes('must-never-enter-cache'), false);

    const cached = await fetchQuotaProducts(['kimi-code'], {
      environment,
      home: root,
      now: new Date('2026-09-07T01:00:00Z'),
      fetchImpl: async () => { throw new Error('offline'); },
    });
    assert.equal(cached.products[0].status, 'ok');
    assert.equal(cached.products[0].source, 'cache');
    assert.equal(JSON.stringify(cached).includes('must-never-enter-cache'), false);

    const cachedAfterServerError = await fetchQuotaProducts(['kimi-code'], {
      environment,
      home: root,
      now: new Date('2026-09-07T01:30:00Z'),
      fetchImpl: async () => jsonResponse({}, 503),
    });
    assert.equal(cachedAfterServerError.products[0].status, 'ok');
    assert.equal(cachedAfterServerError.products[0].source, 'cache');

    writeFileSync(join(root, '.kimi', 'credentials', 'kimi-code.json'), JSON.stringify({
      access_token: 'a-different-account-token',
      expires_at: 2_000_000_000,
    }));
    const differentAccount = await fetchQuotaProducts(['kimi-code'], {
      environment,
      home: root,
      now: new Date('2026-09-07T02:00:00Z'),
      fetchImpl: async () => { throw new Error('offline'); },
    });
    assert.equal(differentAccount.products[0].status, 'retryable_error');
    assert.equal(differentAccount.products[0].source, 'live');

    writeFileSync(join(root, '.kimi', 'credentials', 'kimi-code.json'), JSON.stringify({
      access_token: 'must-never-enter-cache',
      expires_at: 2_000_000_000,
    }));
    const stale = await fetchQuotaProducts(['kimi-code'], {
      environment,
      home: root,
      now: new Date('2026-09-16T00:00:00Z'),
      fetchImpl: async () => { throw new Error('offline'); },
    });
    assert.equal(stale.products[0].status, 'retryable_error');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
