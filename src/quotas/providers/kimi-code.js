import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { attachCacheScope } from '../cache.js';
import { quotaResult } from '../schema.js';

const PRODUCT_ID = 'kimi-code';
const DEFAULT_USAGE_URL = 'https://api.kimi.com/coding/v1/usages';

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resetDate(data, now = new Date()) {
  for (const key of ['reset_at', 'resetAt', 'reset_time', 'resetTime']) {
    const value = data?.[key];
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'number') {
      const millis = value > 10_000_000_000 ? value : value * 1000;
      if (Number.isFinite(millis)) return new Date(millis);
    }
    const millis = Date.parse(String(value));
    if (!Number.isNaN(millis)) return new Date(millis);
  }
  const seconds = number(data?.reset_in ?? data?.resetIn ?? data?.ttl);
  return seconds !== null && seconds > 0 ? new Date(now.getTime() + seconds * 1000) : null;
}

function durationSeconds(item, detail) {
  const window = item?.window && typeof item.window === 'object' ? item.window : {};
  const duration = number(window.duration ?? item?.duration ?? detail?.duration);
  if (duration === null || duration <= 0) return null;
  const unit = String(window.timeUnit ?? item?.timeUnit ?? detail?.timeUnit ?? '').toUpperCase();
  if (unit.includes('MINUTE')) return duration * 60;
  if (unit.includes('HOUR')) return duration * 3600;
  if (unit.includes('DAY')) return duration * 86400;
  if (unit.includes('WEEK')) return duration * 7 * 86400;
  return duration;
}

function labelFor(item, detail, index) {
  for (const key of ['name', 'title', 'scope']) {
    const value = item?.[key] ?? detail?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const seconds = durationSeconds(item, detail);
  if (seconds && seconds % (7 * 86400) === 0) return `${seconds / (7 * 86400)}w`;
  if (seconds && seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds && seconds % 60 === 0) return `${seconds / 60}m`;
  return `Quota ${index + 1}`;
}

function meterFrom(data, item, index, defaultLabel, now) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const limit = number(data.limit);
  let used = number(data.used);
  if (used === null && limit !== null) {
    const remaining = number(data.remaining);
    if (remaining !== null) used = limit - remaining;
  }
  if (limit === null || limit <= 0 || used === null) return null;
  const label = String(data.name || data.title || defaultLabel).trim();
  const rawIdentifier = String(data.id || item?.id || label)
    .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const meter = {
    id: `${index}-${rawIdentifier || 'quota'}`,
    label,
    utilization: Math.max(0, Math.min(100, used / limit * 100)),
  };
  const resetsAt = resetDate(data, now) || resetDate(item, now);
  if (resetsAt) meter.resetsAt = resetsAt.toISOString();
  const seconds = durationSeconds(item, data);
  if (seconds) meter.windowSeconds = seconds;
  return meter;
}

export function parseKimiUsage(payload, now = new Date()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Kimi usage response is not an object');
  }
  const meters = [];
  if (payload.usage && typeof payload.usage === 'object' && !Array.isArray(payload.usage)) {
    const summary = meterFrom(payload.usage, payload.usage, 0, 'Weekly', now);
    if (summary) meters.push(summary);
  }
  if (Array.isArray(payload.limits)) {
    const offset = meters.length;
    for (const [index, item] of payload.limits.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const detail = item.detail && typeof item.detail === 'object' && !Array.isArray(item.detail)
        ? item.detail : item;
      const meter = meterFrom(detail, item, index + offset,
        labelFor(item, detail, index), now);
      if (meter) meters.push(meter);
    }
  }
  const seen = new Set();
  return meters.filter(meter => {
    const key = `${meter.label}\0${meter.windowSeconds || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function kimiCredentialPath(environment = process.env, home = homedir()) {
  const shareDirectory = environment.KIMI_SHARE_DIR?.trim() || join(home, '.kimi');
  return join(shareDirectory, 'credentials', 'kimi-code.json');
}

export async function fetchKimiCodeQuota({
  environment = process.env,
  home = homedir(),
  fetchImpl = globalThis.fetch,
  usageURL = DEFAULT_USAGE_URL,
  now = new Date(),
  timeoutMs = 10_000,
} = {}) {
  let credentials;
  try {
    credentials = JSON.parse(readFileSync(kimiCredentialPath(environment, home), 'utf8'));
  } catch {
    return quotaResult({ id: PRODUCT_ID, status: 'missing_credentials',
      message: 'Kimi Code is not logged in', fetchedAt: now });
  }
  const token = typeof credentials?.access_token === 'string' ? credentials.access_token.trim() : '';
  if (!token) {
    return quotaResult({ id: PRODUCT_ID, status: 'missing_credentials',
      message: 'Kimi Code access token is missing', fetchedAt: now });
  }
  const expiresAt = number(credentials.expires_at);
  if (expiresAt !== null && expiresAt > 0 && expiresAt * 1000 <= now.getTime()) {
    return quotaResult({ id: PRODUCT_ID, status: 'expired_credentials',
      message: 'Kimi Code access token is expired', fetchedAt: now });
  }

  try {
    const response = await fetchImpl(usageURL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      return quotaResult({ id: PRODUCT_ID, status: 'unauthorized',
        message: 'Kimi Code rejected the saved login', fetchedAt: now });
    }
    if (!response.ok) {
      return attachCacheScope(quotaResult({ id: PRODUCT_ID, status: 'retryable_error',
        message: `Kimi usage API returned HTTP ${response.status}`, fetchedAt: now }), token);
    }
    const meters = parseKimiUsage(await response.json(), now);
    return attachCacheScope(quotaResult({
      id: PRODUCT_ID,
      status: meters.length ? 'ok' : 'no_data',
      meters,
      fetchedAt: now,
      dataAsOf: now,
    }), token);
  } catch (error) {
    return attachCacheScope(quotaResult({ id: PRODUCT_ID, status: 'retryable_error',
      message: error?.name === 'TimeoutError' ? 'Kimi usage request timed out' : 'Kimi usage request failed',
      fetchedAt: now }), token);
  }
}
