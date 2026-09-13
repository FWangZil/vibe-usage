import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { projectFromCwd, toCount } from './fs-utils.js';
import { getDevinDbPaths } from '../devin-roots.js';
import { queryDbJsonSnapshotOnLock, sqliteUnavailableError, isSqliteUnavailableError } from './sqlite.js';

// Devin CLI (the agent inside Devin Desktop, formerly Windsurf) persists every
// session in <data>/cli/sessions.db. message_nodes is a forest — /fork and
// /revert keep abandoned turns as sibling chains, and forking into a NEW
// session copies the whole prefix verbatim (same message_id, same created_at,
// same metrics). Only message_id dedupe collapses both copies; restricting to
// sessions.main_chain_id would additionally drop abandoned turns, but those
// were real API calls so they count toward usage.
const ROWS_SQL = `SELECT
  n.session_id AS sessionId,
  n.created_at AS createdAt,
  s.created_at AS sessionCreatedAt,
  s.working_directory AS workingDir,
  s.model AS sessionModel,
  json_extract(n.chat_message, '$.message_id') AS messageId,
  json_extract(n.chat_message, '$.role') AS role,
  json_extract(n.chat_message, '$.metadata.is_user_input') AS isUserInput,
  json_extract(n.chat_message, '$.metadata.generation_model') AS generationModel,
  json_extract(n.chat_message, '$.metadata.metrics.input_tokens') AS inputTokens,
  json_extract(n.chat_message, '$.metadata.metrics.output_tokens') AS outputTokens,
  json_extract(n.chat_message, '$.metadata.metrics.cache_read_tokens') AS cacheReadTokens,
  json_extract(n.chat_message, '$.metadata.metrics.cache_creation_tokens') AS cacheCreationTokens
  FROM message_nodes n
  JOIN sessions s ON s.id = n.session_id
  WHERE s.hidden = 0`;

// sessions.model can hold routing modes rather than a real model id.
const NON_MODEL_IDS = new Set(['adaptive', 'auto', 'agent']);

function normalizeModel(generationModel, sessionModel) {
  const perMessage = typeof generationModel === 'string' ? generationModel.trim() : '';
  if (perMessage && !NON_MODEL_IDS.has(perMessage)) return perMessage;
  const perSession = typeof sessionModel === 'string' ? sessionModel.trim() : '';
  return perSession && !NON_MODEL_IDS.has(perSession) ? perSession : 'unknown';
}

function usageScore(row) {
  return toCount(row.inputTokens) + toCount(row.outputTokens)
    + toCount(row.cacheReadTokens) + toCount(row.cacheCreationTokens);
}

export async function parse() {
  const dbPaths = getDevinDbPaths();
  if (dbPaths.length === 0) return { buckets: [], sessions: [] };

  // One LLM call can be copied onto several chains/sessions under the same
  // message_id. Keep the highest-usage copy per message_id (the copies only
  // differ by float jitter or post-hoc extension fields) and attribute it to
  // the earliest copy's session — for a fork, the session that ran the call.
  const usageByMessage = new Map();
  // Per-session event dedupe: chains inside one session share the prefix too.
  const eventSeen = new Set();
  const sessionEvents = [];

  for (const dbPath of dbPaths) {
    let rows;
    try {
      rows = queryDbJsonSnapshotOnLock(dbPath, ROWS_SQL, {
        tempPrefix: 'vibe-usage-devin-',
      });
    } catch (err) {
      if (isSqliteUnavailableError(err)) throw sqliteUnavailableError('Devin');
      throw err;
    }

    for (const row of rows) {
      const timestamp = new Date(row.createdAt * 1000);
      if (isNaN(timestamp.getTime())) continue;
      const sessionCreatedAt = new Date(row.sessionCreatedAt * 1000);
      const project = projectFromCwd(row.workingDir);
      const role = row.role === 'user' ? 'user' : row.role === 'assistant' ? 'assistant' : null;

      // Session timing: only real user prompts (is_user_input) open a turn —
      // the store also logs role='user' rows for internal summarize/compact
      // requests, which would fragment every turn they sit inside. Nodes
      // copied from another session at fork time keep their original
      // created_at; dropping anything older than the session's own creation
      // keeps a fork's duration from stretching back over the copied prefix.
      if (role && row.messageId
        && !isNaN(sessionCreatedAt.getTime())
        && timestamp >= sessionCreatedAt
        && (role !== 'user' || row.isUserInput === 1 || row.isUserInput === true)
      ) {
        const key = `${row.sessionId}${row.messageId}`;
        if (!eventSeen.has(key)) {
          eventSeen.add(key);
          sessionEvents.push({
            sessionId: row.sessionId,
            source: 'devin',
            project,
            timestamp,
            role,
          });
        }
      }

      if (role !== 'assistant' || !row.messageId) continue;
      const score = usageScore(row);
      if (score === 0) continue;

      const entry = {
        source: 'devin',
        model: normalizeModel(row.generationModel, row.sessionModel),
        project,
        timestamp,
        inputTokens: toCount(row.inputTokens) + toCount(row.cacheCreationTokens),
        outputTokens: toCount(row.outputTokens),
        cachedInputTokens: toCount(row.cacheReadTokens),
        reasoningOutputTokens: 0,
        score,
      };
      const existing = usageByMessage.get(row.messageId);
      if (!existing || score > existing.score
        || (score === existing.score && timestamp < existing.timestamp)) {
        usageByMessage.set(row.messageId, entry);
      }
    }
  }

  return {
    buckets: aggregateToBuckets([...usageByMessage.values()]),
    sessions: extractSessions(sessionEvents),
  };
}
