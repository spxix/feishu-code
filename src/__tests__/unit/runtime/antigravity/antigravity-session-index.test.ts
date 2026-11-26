import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';

import {
  archiveAntigravitySession,
  findAntigravitySessionById,
  isAntigravityUserInputLine,
  listAntigravitySessionSummaries,
  readAntigravitySessionMessagesByFilePath,
  resolveAntigravityAppDataDir,
  resolveAntigravitySummaryDbPath,
  resolveAntigravityTranscriptPath,
} from '../../../../runtime/antigravity/session-index.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-agy-index-'));
  temporaryDirectories.push(dir);
  return dir;
}

function seedFixture(root: string): { env: NodeJS.ProcessEnv; transcriptPath: string } {
  const dbPath = path.join(root, 'conversation_summaries.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      preview TEXT,
      step_count INTEGER,
      last_modified_time TEXT,
      workspace_uris TEXT,
      parent_conversation_id TEXT,
      killed INTEGER,
      last_user_input_time TEXT
    );
  `);
  const insert = db.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, preview, step_count, last_modified_time,
      workspace_uris, parent_conversation_id, killed, last_user_input_time
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    'conv-main-1',
    'Fix login bug',
    'Can you fix login?',
    4,
    '2026-11-25 10:00:00.123456+00:00',
    JSON.stringify(['file:///workspace/app']),
    '',
    0,
    '2026-11-25 09:55:00.000+00:00',
  );
  insert.run(
    'conv-subagent-1',
    'Subagent helper',
    'subtask',
    2,
    '2026-11-25 10:01:00.000+00:00',
    JSON.stringify(['file:///workspace/app']),
    'conv-main-1',
    0,
    '2026-11-25 10:01:00.000+00:00',
  );
  insert.run(
    'conv-killed-1',
    'Killed run',
    'aborted',
    1,
    '2026-11-25 10:02:00.000+00:00',
    JSON.stringify(['file:///workspace/app']),
    null,
    1,
    '2026-11-25 10:02:00.000+00:00',
  );
  db.close();

  const transcriptPath = resolveAntigravityTranscriptPath('conv-main-1', { CODELARK_ANTIGRAVITY_HOME: root });
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: 'USER_INPUT', content: 'Hello Antigravity', created_at: '2026-11-25T09:55:00.000Z' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Hi! How can I help?', created_at: '2026-11-25T09:55:02.000Z' }),
      JSON.stringify({ type: 'TOOL_RESULT', content: 'ignored' }),
    ].join('\n') + '\n',
    'utf8',
  );

  return { env: { CODELARK_ANTIGRAVITY_HOME: root }, transcriptPath };
}

describe('Antigravity session index', () => {
  it('resolves app data paths from CODELARK_ANTIGRAVITY_HOME', () => {
    const root = createTempRoot();
    const env = { CODELARK_ANTIGRAVITY_HOME: root };
    assert.equal(resolveAntigravityAppDataDir(env), root);
    assert.equal(resolveAntigravitySummaryDbPath(env), path.join(root, 'conversation_summaries.db'));
    assert.equal(
      resolveAntigravityTranscriptPath('abc', env),
      path.join(root, 'brain', 'abc', '.system_generated', 'logs', 'transcript.jsonl'),
    );
  });

  it('lists top-level non-killed conversations and parses workspace cwd and transcript messages', () => {
    const root = createTempRoot();
    const { env, transcriptPath } = seedFixture(root);

    const listed = listAntigravitySessionSummaries(10, { env });
    assert.deepEqual(listed.map((s) => s.sessionId), ['conv-main-1']);
    assert.equal(listed[0]?.title, 'Fix login bug');
    assert.equal(listed[0]?.cwd, '/workspace/app');
    assert.equal(listed[0]?.filePath, transcriptPath);

    const found = findAntigravitySessionById('conv-main-1', undefined, { env });
    assert.equal(found?.sessionId, 'conv-main-1');
    assert.equal(findAntigravitySessionById('missing', undefined, { env }), null);

    const messages = readAntigravitySessionMessagesByFilePath(transcriptPath, 10);
    assert.deepEqual(messages, [
      { role: 'user', content: 'Hello Antigravity', timestamp: '2026-11-25T09:55:00.000Z' },
      { role: 'assistant', content: 'Hi! How can I help?', timestamp: '2026-11-25T09:55:02.000Z' },
    ]);
    assert.equal(isAntigravityUserInputLine(JSON.stringify({ type: 'USER_INPUT', content: 'hi' })), true);
    assert.equal(isAntigravityUserInputLine(JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'hi' })), false);
  });

  it('soft-archives sessions and hides them from default listing', () => {
    const root = createTempRoot();
    const { env } = seedFixture(root);

    const archived = archiveAntigravitySession('conv-main-1', '/workspace/app', env);
    assert.equal(archived?.sessionId, 'conv-main-1');
    assert.deepEqual(listAntigravitySessionSummaries(10, { env }), []);
    assert.equal(findAntigravitySessionById('conv-main-1', undefined, { env }), null);
    assert.equal(findAntigravitySessionById('conv-main-1', undefined, { env, includeArchived: true })?.sessionId, 'conv-main-1');
  });
});
