import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { CODELARK_HOME } from '../../configuration/paths.js';

export interface AntigravitySessionSummary {
  sessionId: string;
  filePath: string;
  cwd: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  stepCount?: number;
}

export interface AntigravityTranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

interface ArchivedAntigravitySession {
  sessionId: string;
  cwd: string;
  archivedAt: string;
  title?: string;
}

interface SummaryRow {
  conversation_id: string;
  title: string;
  preview: string;
  step_count: number;
  last_modified_time: string;
  workspace_uris: string;
  last_user_input_time: string;
}

function expandHome(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith(`~${path.sep}`) || trimmed.startsWith('~/')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export function resolveAntigravityAppDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const direct = env.CODELARK_ANTIGRAVITY_HOME?.trim() || env.ANTIGRAVITY_APP_DATA_DIR?.trim();
  if (direct) return path.resolve(expandHome(direct));
  return path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

export function resolveAntigravitySummaryDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveAntigravityAppDataDir(env), 'conversation_summaries.db');
}

export function resolveAntigravityTranscriptPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveAntigravityAppDataDir(env), 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
}

function archiveStorePath(): string {
  return path.join(CODELARK_HOME, 'data', 'antigravity-archived-sessions.json');
}

function readArchivedSessions(): Map<string, ArchivedAntigravitySession> {
  const filePath = archiveStorePath();
  if (!fs.existsSync(filePath)) return new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return new Map();
    const map = new Map<string, ArchivedAntigravitySession>();
    for (const entry of parsed) {
      if (entry && typeof entry === 'object' && typeof (entry as ArchivedAntigravitySession).sessionId === 'string') {
        map.set((entry as ArchivedAntigravitySession).sessionId, entry as ArchivedAntigravitySession);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function writeArchivedSessions(archived: Map<string, ArchivedAntigravitySession>): void {
  const filePath = archiveStorePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify([...archived.values()], null, 2), 'utf8');
}

function parseWorkspaceCwd(workspaceUris: string | null | undefined): string {
  if (!workspaceUris) return '';
  try {
    const parsed = JSON.parse(workspaceUris) as unknown;
    const first = Array.isArray(parsed) ? parsed.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : undefined;
    if (!first) return '';
    if (first.startsWith('file://')) {
      try {
        return fileURLToPath(first);
      } catch {
        return first.replace(/^file:\/\//, '');
      }
    }
    return first;
  } catch {
    return '';
  }
}

function normalizeIsoTimestamp(value: string | null | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  // SQLite rows look like "2026-11-25 10:54:56.490324022+00:00"
  const normalized = value.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function rowToSummary(row: SummaryRow, env: NodeJS.ProcessEnv): AntigravitySessionSummary {
  const transcriptPath = resolveAntigravityTranscriptPath(row.conversation_id, env);
  const updatedAt = normalizeIsoTimestamp(row.last_modified_time) || normalizeIsoTimestamp(row.last_user_input_time);
  const createdAt = normalizeIsoTimestamp(row.last_user_input_time) || updatedAt;
  return {
    sessionId: row.conversation_id,
    filePath: fs.existsSync(transcriptPath) ? transcriptPath : resolveAntigravitySummaryDbPath(env),
    cwd: parseWorkspaceCwd(row.workspace_uris),
    title: row.title?.trim() || row.preview?.trim() || row.conversation_id.slice(0, 8),
    createdAt,
    updatedAt,
    stepCount: typeof row.step_count === 'number' ? row.step_count : undefined,
  };
}

export function listAntigravitySessionSummaries(
  limit?: number,
  options: { env?: NodeJS.ProcessEnv; includeArchived?: boolean } = {},
): AntigravitySessionSummary[] {
  const env = options.env || process.env;
  const dbPath = resolveAntigravitySummaryDbPath(env);
  if (!fs.existsSync(dbPath)) return [];
  const archived = options.includeArchived ? new Map<string, ArchivedAntigravitySession>() : readArchivedSessions();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(`
      SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, last_user_input_time
      FROM conversation_summaries
      WHERE (parent_conversation_id IS NULL OR parent_conversation_id = '')
        AND (killed IS NULL OR killed = 0)
      ORDER BY last_modified_time DESC
    `).all() as unknown as SummaryRow[];
    const summaries = rows
      .filter(row => row.conversation_id && !archived.has(row.conversation_id))
      .map(row => rowToSummary(row, env));
    return typeof limit === 'number' && Number.isFinite(limit) && limit > 0
      ? summaries.slice(0, Math.floor(limit))
      : summaries;
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export function findAntigravitySessionById(
  sessionId: string,
  _cwd?: string,
  options: { env?: NodeJS.ProcessEnv; includeArchived?: boolean } = {},
): AntigravitySessionSummary | null {
  const trimmed = sessionId.trim();
  if (!trimmed) return null;
  const env = options.env || process.env;
  const dbPath = resolveAntigravitySummaryDbPath(env);
  if (fs.existsSync(dbPath)) {
    const archived = options.includeArchived ? new Map<string, ArchivedAntigravitySession>() : readArchivedSessions();
    if (archived.has(trimmed)) return null;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db.prepare(`
        SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, last_user_input_time
        FROM conversation_summaries
        WHERE conversation_id = ?
        LIMIT 1
      `).get(trimmed) as unknown as SummaryRow | undefined;
      if (row?.conversation_id) return rowToSummary(row, env);
    } catch {
      // fall through to transcript file check
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }
  const transcriptPath = resolveAntigravityTranscriptPath(trimmed, env);
  if (fs.existsSync(transcriptPath)) {
    const stat = fs.statSync(transcriptPath);
    return {
      sessionId: trimmed,
      filePath: transcriptPath,
      cwd: _cwd || '',
      title: trimmed.slice(0, 8),
      createdAt: stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
    };
  }
  return null;
}

export function archiveAntigravitySession(
  sessionId: string,
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
): AntigravitySessionSummary | null {
  const existing = findAntigravitySessionById(sessionId, cwd, { env, includeArchived: true });
  if (!existing) return null;
  const archived = readArchivedSessions();
  archived.set(existing.sessionId, {
    sessionId: existing.sessionId,
    cwd: existing.cwd || cwd || '',
    archivedAt: new Date().toISOString(),
    title: existing.title,
  });
  writeArchivedSessions(archived);
  return existing;
}

export function isAntigravityUserInputLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as { type?: unknown; content?: unknown };
    return parsed?.type === 'USER_INPUT' && typeof parsed.content === 'string' && parsed.content.trim().length > 0;
  } catch {
    return false;
  }
}

export function readAntigravitySessionMessagesByFilePath(
  filePath: string,
  limit = 20,
): AntigravityTranscriptMessage[] {
  if (!filePath || !filePath.endsWith('.jsonl') || !fs.existsSync(filePath)) return [];
  const messages: AntigravityTranscriptMessage[] = [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as {
          type?: unknown;
          content?: unknown;
          created_at?: unknown;
        };
        if (typeof parsed.content !== 'string' || !parsed.content.trim()) continue;
        if (parsed.type === 'USER_INPUT') {
          messages.push({
            role: 'user',
            content: parsed.content.trim(),
            timestamp: typeof parsed.created_at === 'string' ? parsed.created_at : undefined,
          });
        } else if (parsed.type === 'PLANNER_RESPONSE') {
          messages.push({
            role: 'assistant',
            content: parsed.content.trim(),
            timestamp: typeof parsed.created_at === 'string' ? parsed.created_at : undefined,
          });
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    return [];
  }
  return limit > 0 ? messages.slice(-limit) : messages;
}
