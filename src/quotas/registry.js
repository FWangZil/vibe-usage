import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { loadCachedQuota, saveCachedQuota } from './cache.js';
import { fetchKimiCodeQuota } from './providers/kimi-code.js';
import { fetchZaiQuota } from './providers/zai.js';
import { FETCHABLE_QUOTA_PRODUCT_IDS, quotaEnvelope, quotaResult } from './schema.js';

const providers = new Map([
  ['kimi-code', fetchKimiCodeQuota],
  ['zcode', fetchZaiQuota],
]);

function executableExists(name, environment) {
  return (environment.PATH || '').split(delimiter).filter(Boolean).some(directory => {
    const path = join(directory, name);
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function discoverQuotaProducts({
  environment = process.env,
  home = homedir(),
  platform = process.platform,
} = {}) {
  const applications = platform === 'darwin'
    ? ['/Applications', join(home, 'Applications')] : [];
  const existsAny = paths => paths.some(path => existsSync(path));
  return quotaEnvelope([
    {
      id: 'kimi-code',
      detected: existsAny([join(home, '.kimi'), join(home, '.kimi-code')])
        || executableExists('kimi', environment),
      fetchable: true,
    },
    {
      id: 'zcode',
      detected: existsAny([join(home, '.zcode'), join(home, '.config', 'zcode'),
        ...applications.map(path => join(path, 'ZCode.app'))])
        || executableExists('zcode', environment),
      fetchable: true,
    },
    {
      id: 'cursor-grok',
      detected: existsAny([join(home, '.cursor'),
        ...applications.map(path => join(path, 'Cursor.app'))])
        || executableExists('cursor', environment),
      fetchable: false,
    },
  ]);
}

export async function fetchQuotaProducts(ids, options = {}) {
  const unique = [...new Set(ids)];
  const invalid = unique.filter(id => !FETCHABLE_QUOTA_PRODUCT_IDS.includes(id));
  if (invalid.length) throw new Error(`Unsupported quota product: ${invalid.join(', ')}`);

  const fetched = await Promise.all(unique.map(async id => {
    try {
      return await providers.get(id)(options);
    } catch {
      return quotaResult({ id, status: 'retryable_error', message: 'Provider failed unexpectedly' });
    }
  }));
  const results = fetched.map(result => {
    if (result.status === 'ok') {
      saveCachedQuota(result, result.cacheScope, options.environment);
      return result;
    }
    if (result.status === 'retryable_error') {
      return loadCachedQuota(
        result.id,
        result.cacheScope,
        options.environment,
        options.now || new Date()
      ) || result;
    }
    return result;
  });
  return quotaEnvelope(results);
}
