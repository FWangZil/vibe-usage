import { existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { projectFromCwd, toCount } from './fs-utils.js';
import { getCodebuddyRoots } from '../tools.js';

// CodeBuddy Code (Tencent's terminal agent, `@tencent-ai/codebuddy-code`). The
// store follows Claude Code's layout:
//   <home>/projects/<compressed-cwd>/<sessionId>.jsonl   (+ nested subagent dirs)
// where <home> is `$CODEBUDDY_CONFIG_DIR` or ~/.codebuddy.
//
// Two record shapes live in those transcripts (verified against 2.151.0's own
// writer and a real store): local turns are `{type:"message", role:"user"|…,
// content, sessionId, cwd}`, while every successful model call is the API
// message shape — `{message:{id, model, role:"assistant",
// usage:{input_tokens, output_tokens, cache_read_input_tokens,
// cache_creation_input_tokens}}}` — so token accounting reads `message.usage`
// only. `usage.cache_creation` (the per-TTL breakdown) is written as `null`, so
// cache writes fold into input and cannot be priced per TTL, matching every
// parser that has no split.
const SOURCE = 'codebuddy';
const PROJECTS = 'projects';

export function resolveCodebuddyRoots(env = process.env, home) {
  return getCodebuddyRoots(env, home);
}

/** Session id of a transcript file, and the project fallback from its folder. */
function fileIdentity(filePath, projectsDir) {
  const sessionId = basename(filePath, '.jsonl');
  const relative = filePath.startsWith(projectsDir + sep) ? filePath.slice(projectsDir.length + 1) : '';
  const folder = relative.split(sep)[0] || '';
  // Compressed cwd folders look like `private-tmp-my-project`; the last segment
  // is the best guess when a record carries no cwd.
  const fallback = folder.split('-').filter(Boolean).at(-1) || 'unknown';
  return { sessionId, fallback };
}

function findTranscripts(root, onWarning) {
  const projectsDir = join(root, PROJECTS);
  if (!existsSync(projectsDir)) return { projectsDir, files: [] };
  const files = [];
  const walk = dir => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (err) { onWarning(`codebuddy: 无法读取目录 ${dir}: ${err.message}`); return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
    }
  };
  walk(projectsDir);
  return { projectsDir, files };
}

/**
 * Provider routing/tier labels ('auto', 'default', …) are not model ids, and
 * server-side pricing matches the model string alone: a bare `auto` would be
 * billed at Cursor's `auto` rate — the collision PR #83 fixed for Qoder by
 * renaming it `qoder-auto`. Namespace the tier labels with the tool prefix;
 * concrete ids (`claude-sonnet-4-6`, …) pass through untouched.
 */
const ROUTING_TIER_IDS = new Set([
  'auto', 'default', 'default-model', 'fast', 'turbo', 'lite', 'ultimate', 'performance', 'efficient',
]);

function normalizeModel(model) {
  const lower = model.toLowerCase();
  return ROUTING_TIER_IDS.has(lower) ? `${SOURCE}-${lower}` : model;
}

/** One usage-bearing assistant message, keyed so retries/copies collapse. */
function usageEntry(obj, projectFallback, sessionId) {
  const usage = obj.message?.usage;
  if (!usage) return null;
  const timestampMs = Number(obj.timestamp) || Date.parse(obj.message?.timestamp) || null;
  const timestamp = Number.isFinite(timestampMs) ? new Date(timestampMs) : null;
  if (!timestamp || isNaN(timestamp.getTime())) return null;

  const cacheWrite = toCount(usage.cache_creation_input_tokens);
  const inputTokens = toCount(usage.input_tokens) + cacheWrite;
  const outputTokens = toCount(usage.output_tokens);
  const cachedInputTokens = toCount(usage.cache_read_input_tokens);
  if (!inputTokens && !outputTokens && !cachedInputTokens) return null;

  const messageId = typeof obj.message?.id === 'string' ? obj.message.id.trim() : '';
  const providerMessageId = typeof obj.providerData?.messageId === 'string' ? obj.providerData.messageId.trim() : '';
  const ownId = typeof obj.id === 'string' ? obj.id.trim() : '';
  // The CLI leaves `message.id` empty on some builds and keeps the per-message id
  // in providerData; `conversationRequestId` is a *turn* id (one turn can hold
  // several billable calls), so it is explicitly not a dedup key. Without this
  // chain every call collapses onto one empty key and the session under-counts.
  const identity = messageId || providerMessageId || ownId;
  const dedupeKey = identity ? `call:${identity}` : null;

  const model = normalizeModel([
    obj.message?.model,
    obj.providerData?.requestModelId,
    obj.providerData?.model,
  ].find(value => typeof value === 'string' && value.trim()) || 'unknown');

  return {
    dedupeKey,
    usageScore: inputTokens + outputTokens + cachedInputTokens,
    entry: {
      source: SOURCE,
      model,
      project: projectFromCwd(obj.cwd, projectFallback),
      timestamp,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningOutputTokens: 0,
    },
    sessionId: typeof obj.sessionId === 'string' && obj.sessionId ? obj.sessionId : sessionId,
  };
}

/** Human prompt? Local user turns only — the CLI marks injected/system text. */
function isHumanPrompt(obj) {
  if (obj?.role !== 'user' && obj?.message?.role !== 'user') return false;
  if (obj.providerData?.isMeta || obj.providerData?.skipRun) return false;
  if (obj.providerData?.isSessionSeparator || obj.providerData?.isCompactSummary) return false;
  return true;
}

function readTimestamp(obj) {
  const ms = Number(obj?.timestamp);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export async function parse() {
  const warnings = [];
  const onWarning = message => warnings.push(message);
  const entries = [];
  const events = [];
  const byKey = new Map();
  const anonymous = [];
  let skipped = false;

  for (const root of resolveCodebuddyRoots()) {
    const { projectsDir, files } = findTranscripts(root, onWarning);
    for (const file of files) {
      const { sessionId, fallback } = fileIdentity(file, projectsDir);
      let stream;
      try {
        stream = createReadStream(file);
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of lines) {
          if (!line.trim()) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          if (!obj || typeof obj !== 'object') continue;

          const entry = usageEntry(obj, fallback, sessionId);
          if (entry) {
            if (!entry.dedupeKey) anonymous.push(entry);
            else {
              const current = byKey.get(entry.dedupeKey);
              if (!current || entry.usageScore > current.usageScore) byKey.set(entry.dedupeKey, entry);
            }
            const timestamp = readTimestamp(obj);
            if (timestamp) events.push({ sessionId: entry.sessionId, source: SOURCE, project: entry.entry.project, timestamp, role: 'assistant' });
            continue;
          }

          if (isHumanPrompt(obj)) {
            const timestamp = readTimestamp(obj);
            if (timestamp) {
              events.push({
                sessionId: typeof obj.sessionId === 'string' && obj.sessionId ? obj.sessionId : sessionId,
                source: SOURCE,
                project: projectFromCwd(obj.cwd) || fallback,
                timestamp,
                role: 'user',
              });
            }
          }
        }
      } catch (err) {
        // A transcript that cannot be read means this source's snapshot is
        // incomplete: skip the source so its previous upload state survives.
        skipped = true;
        onWarning(`codebuddy: 无法读取会话 ${file}: ${err.message}`);
      } finally {
        stream?.close();
      }
    }
  }

  for (const entry of anonymous) entries.push(entry.entry);
  for (const entry of byKey.values()) entries.push(entry.entry);

  const buckets = aggregateToBuckets(entries);
  const sessions = extractSessions(events);
  return skipped
    ? { buckets: [], sessions: [], skipped: true, warnings }
    : { buckets, sessions, warnings };
}
