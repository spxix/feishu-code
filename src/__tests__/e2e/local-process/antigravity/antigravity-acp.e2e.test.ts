import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  AntigravityAcpProvider,
  closeAllAntigravityAcpSessions,
  closeAntigravityAcpSession,
  interruptAntigravityAcpSession,
} from '../../../../runtime/antigravity/acp-provider.js';
import { PendingPermissions } from '../../../../runtime/permission-gateway.js';
import { processMessage } from '../../../../bridge/turn/interactive/sdk-conversation-engine.js';
import { consumeSseEvents } from '../../../../runtime/sse-stream-decoder.js';
import { normalizeReasoningEffort, normalizeSandboxMode } from '../../../../runtime/options.js';
import { handleBridgeCommand } from '../../../../bridge/command/dispatch.js';
import {
  getSessionActiveRuntime,
  getSessionAntigravitySessionId,
} from '../../../../domain/session-runtime.js';
import { initBridgeTestContext, RecordingAdapter } from '../../../helpers/bridge/test-bridge-utils.js';

const originalHome = process.env.CODELARK_TEST_ORIGINAL_HOME || os.homedir();

function resolveRealAgyExecutable(): string | undefined {
  const explicit = process.env.CODELARK_REAL_ANTIGRAVITY_E2E_EXECUTABLE
    || process.env.CODELARK_ANTIGRAVITY_EXECUTABLE
    || process.env.ANTIGRAVITY_EXECUTABLE;
  if (explicit?.trim() && fs.existsSync(explicit.trim())) return explicit.trim();
  const candidates = [
    path.join(originalHome, '.local', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy'),
    '/usr/local/bin/agy',
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function realAgyEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: originalHome,
    USERPROFILE: originalHome,
  };
}

function shouldRunLiveE2e(): { ok: boolean; executable?: string; reason?: string } {
  if (process.env.CODELARK_REAL_ANTIGRAVITY_E2E !== '1') {
    return { ok: false, reason: 'set CODELARK_REAL_ANTIGRAVITY_E2E=1 to run live agy acp e2e tests' };
  }
  const executable = resolveRealAgyExecutable();
  if (!executable) {
    return { ok: false, reason: 'real agy CLI executable not found' };
  }
  return { ok: true, executable };
}

type ObservedEvent = { type: string; data: any };

function observeStream(stream: ReadableStream<string>, onEvent?: (event: ObservedEvent) => void) {
  const events: ObservedEvent[] = [];
  const done = (async () => {
    for await (const chunk of stream) {
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const parsed = JSON.parse(line.slice(6));
        let data = parsed.data;
        try { data = JSON.parse(data); } catch {}
        const event = { type: parsed.type, data };
        events.push(event);
        onEvent?.(event);
      }
    }
  })();
  return { events, done };
}

function joinedText(events: ObservedEvent[]): string {
  return events
    .filter((event) => event.type === 'text')
    .map((event) => (typeof event.data === 'string' ? event.data : event.data?.text || ''))
    .join('');
}

const tempDirs: string[] = [];

afterEach(async () => {
  await closeAllAntigravityAcpSessions();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Antigravity ACP live e2e (mock Feishu + real agy acp)', () => {
  it('runs IM commands, streams multi-turn tool calls through Bridge processMessage, resumes via session/load, and reads /t + /his', { timeout: 120_000 }, async (t) => {
    const check = shouldRunLiveE2e();
    if (!check.ok) { t.skip(check.reason); return; }

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-agy-e2e-ws-'));
    tempDirs.push(workspace);

    const permissions = new PendingPermissions();
    const provider = new AntigravityAcpProvider(permissions, {
      executable: check.executable,
      env: realAgyEnv(),
    });
    const store = initBridgeTestContext({ llm: provider });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: `oc_agy_e2e_${randomUUID().slice(0, 8)}` };

    const initialSession = store.createSession('Antigravity E2E', '', undefined, workspace);
    store.upsertChannelChat({ ...address, bridgeSessionId: initialSession.id });

    const commandDeps = {
      getActiveTask: () => undefined,
      diagnoseSessionHealth: async () => null,
      diagnoseAllActiveSessions: async () => [],
    };
    const runCommand = async (text: string) => {
      const before = adapter.sent.length;
      await handleBridgeCommand(
        adapter,
        { address, text, messageId: `msg-${randomUUID().slice(0, 8)}`, timestamp: Date.now() } as any,
        text,
        commandDeps,
      );
      const deadline = Date.now() + 5_000;
      while (adapter.sent.length <= before && Date.now() < deadline) {
        await delay(10);
      }
      return adapter.sent.at(-1);
    };

    // 1. Switch runtime via `/runtime agy` alias and configure session settings
    const switchReply = await runCommand('/runtime agy');
    assert.match(switchReply?.text || '', /Antigravity|antigravity/i);

    const binding = store.getChannelChat(address.channelType, address.chatId)!;
    const agySession = store.getSession(binding.bridgeSessionId)!;
    assert.equal(getSessionActiveRuntime(agySession), 'antigravity');

    const currentReply = await runCommand('/current');
    assert.equal(currentReply?.richCard?.template, 'green');
    assert.match(JSON.stringify(currentReply?.richCard || {}), /Antigravity/);

    const yoloReply = await runCommand('/yolo on');
    assert.match(yoloReply?.text || '', /yolo/i);

    const reasoningReply = await runCommand('/r low');
    assert.match(reasoningReply?.text || '', /low/);

    const providerReply = await runCommand('/p');
    assert.match(providerReply?.text || '', /acp/);

    // 2. Turn 1 via real Bridge conversation engine (`processMessage`)
    const runtimePort = {
      store,
      llm: provider,
      normalizeReasoningEffort,
      normalizeSandboxMode,
      consumeSseEvents,
    };
    const previews1: string[] = [];
    const toolEvents1: Array<{ kind: string; name?: string; detail?: string }> = [];
    const turn1 = await processMessage(
      binding,
      `Create a file named hello.txt in ${workspace} containing exactly "ALPHA_123", verify it exists, and reply with DONE_ALPHA.`,
      undefined,
      undefined,
      undefined,
      (preview) => { previews1.push(preview); },
      (kind, name, detail) => { toolEvents1.push({ kind, name, detail }); },
      undefined,
      undefined,
      undefined,
      { isCurrentTask: () => true },
      runtimePort,
    );

    assert.equal(turn1.outcome, 'completed', `Turn 1 failed: ${JSON.stringify(turn1)}`);
    assert.equal(turn1.hasError, false);
    assert.match(turn1.responseText, /DONE_ALPHA/i);
    assert.ok(previews1.length > 0, 'expected streaming preview updates during Turn 1');
    assert.ok(toolEvents1.length > 0, 'expected tool events during Turn 1');

    const helloPath = path.join(workspace, 'hello.txt');
    assert.ok(fs.existsSync(helloPath), 'expected hello.txt to be created by agy');
    assert.match(fs.readFileSync(helloPath, 'utf8'), /ALPHA_123/);

    const updatedAfterTurn1 = store.getSession(agySession.id)!;
    const nativeSessionId = getSessionAntigravitySessionId(updatedAfterTurn1);
    assert.ok(nativeSessionId, 'expected native Antigravity sessionId to be persisted in BridgeSession');

    // 3. Cold-close ACP worker so Turn 2 forces a fresh `agy acp` spawn + `session/load`
    await closeAntigravityAcpSession(agySession.id);

    const turn2 = await processMessage(
      store.getChannelChat(address.channelType, address.chatId)!,
      `Update ${helloPath} to contain "BETA_456" instead. In your final reply, state both the old value you wrote earlier and the new value.`,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { isCurrentTask: () => true },
      runtimePort,
    );

    assert.equal(turn2.outcome, 'completed', `Turn 2 failed: ${JSON.stringify(turn2)}`);
    assert.equal(turn2.hasError, false);
    assert.match(fs.readFileSync(helloPath, 'utf8'), /BETA_456/);
    assert.match(turn2.responseText, /ALPHA_123/);
    assert.match(turn2.responseText, /BETA_456/);
    assert.equal(
      getSessionAntigravitySessionId(store.getSession(agySession.id)!),
      nativeSessionId,
      'expected session/load resume to keep the exact same native sessionId',
    );

    // 4. Verify `/t antigravity` and `/his` against the real Antigravity app data dir
    const prevHome = process.env.CODELARK_ANTIGRAVITY_HOME;
    process.env.CODELARK_ANTIGRAVITY_HOME = path.join(originalHome, '.gemini', 'antigravity-cli');
    try {
      const threadsReply = await runCommand('/t antigravity');
      assert.ok(threadsReply?.richCard || threadsReply?.text, 'expected /t antigravity to return a listing');

      const hisReply = await runCommand('/his 4');
      assert.match(
        `${hisReply?.text || ''} ${JSON.stringify(hisReply?.richCard || {})}`,
        /DONE_ALPHA|BETA_456/,
        'expected /his to include recent messages from the session',
      );
    } finally {
      if (prevHome === undefined) delete process.env.CODELARK_ANTIGRAVITY_HOME;
      else process.env.CODELARK_ANTIGRAVITY_HOME = prevHome;
    }
  });

  it('handles interactive permission prompts in default mode via PendingPermissions', { timeout: 90_000 }, async (t) => {
    const check = shouldRunLiveE2e();
    if (!check.ok) { t.skip(check.reason); return; }

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-agy-e2e-perm-'));
    tempDirs.push(workspace);

    const permissions = new PendingPermissions();
    const provider = new AntigravityAcpProvider(permissions, {
      executable: check.executable,
      env: realAgyEnv(),
    });
    const sessionId = `perm-${randomUUID()}`;
    const permissionRequests: Array<{ id: string; toolName: string }> = [];

    const stream = provider.streamChat({
      sessionId,
      runtime: 'antigravity',
      workingDirectory: workspace,
      antigravityMode: 'default',
      antigravityReasoningEffort: 'low',
      prompt: `Use your shell/command tool to run: touch "${path.join(workspace, 'perm_marker.txt')}" && echo PERM_OK. Then reply with PERM_OK.`,
    });

    const run = observeStream(stream, (event) => {
      if (event.type === 'permission_request') {
        permissionRequests.push({
          id: event.data.permissionRequestId,
          toolName: event.data.toolName,
        });
        permissions.resolve(event.data.permissionRequestId, { behavior: 'allow' });
      }
    });

    await run.done;
    const result = run.events.find((e) => e.type === 'result')?.data;
    assert.equal(result?.outcome, 'completed', `Permission turn failed: ${JSON.stringify(run.events)}`);
    assert.ok(fs.existsSync(path.join(workspace, 'perm_marker.txt')), 'expected shell command to create perm_marker.txt');
    assert.match(joinedText(run.events), /PERM_OK/i);
    assert.equal(permissions.size, 0);
    console.log(`[antigravity-e2e] default-mode permission prompts intercepted & approved: ${permissionRequests.length}`, permissionRequests);
  });

  it('cancels an active turn mid-flight via interruptAntigravityAcpSession and accepts the next turn cleanly', { timeout: 90_000 }, async (t) => {
    const check = shouldRunLiveE2e();
    if (!check.ok) { t.skip(check.reason); return; }

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-agy-e2e-cancel-'));
    tempDirs.push(workspace);

    const provider = new AntigravityAcpProvider(new PendingPermissions(), {
      executable: check.executable,
      env: realAgyEnv(),
    });
    const sessionId = `cancel-${randomUUID()}`;

    let sawToolOrRunning = false;
    const startedAt = Date.now();
    const firstRun = observeStream(
      provider.streamChat({
        sessionId,
        runtime: 'antigravity',
        workingDirectory: workspace,
        antigravityMode: 'yolo',
        antigravityReasoningEffort: 'low',
        prompt: 'Use your shell command tool to run `sleep 25 && echo SHOULD_NOT_FINISH` and wait for it to finish.',
        onInputAccepted: () => { sawToolOrRunning = true; },
      }),
      (event) => {
        if (event.type === 'tool_use') sawToolOrRunning = true;
      },
    );

    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && !firstRun.events.some((e) => e.type === 'tool_use') && !firstRun.events.some((e) => e.type === 'done')) {
      await delay(50);
    }
    assert.ok(sawToolOrRunning, 'expected turn to start before cancellation');

    const interrupted = await interruptAntigravityAcpSession(sessionId);
    assert.equal(interrupted, true, 'expected interruptAntigravityAcpSession to return true for active turn');
    await firstRun.done;

    const cancelElapsedMs = Date.now() - startedAt;
    const firstResult = firstRun.events.find((e) => e.type === 'result')?.data;
    assert.equal(firstResult?.outcome, 'aborted', `expected aborted outcome, got: ${JSON.stringify(firstResult)}`);
    assert.ok(cancelElapsedMs < 22_000, `expected prompt cancellation well before 25s sleep, elapsed=${cancelElapsedMs}ms`);
    const nativeSessionId = firstResult?.session_id
      || firstRun.events.find((e) => e.type === 'status' && e.data?.session_id)?.data?.session_id;
    assert.ok(nativeSessionId, 'expected native sessionId even after aborted turn');

    // Follow-up turn on the same session must succeed without overlap errors
    const secondRun = observeStream(
      provider.streamChat({
        sessionId,
        runtime: 'antigravity',
        antigravitySessionId: nativeSessionId,
        workingDirectory: workspace,
        antigravityMode: 'yolo',
        antigravityReasoningEffort: 'low',
        prompt: 'Reply with only the word AFTER_CANCEL.',
      }),
    );
    await secondRun.done;
    const secondResult = secondRun.events.find((e) => e.type === 'result')?.data;
    assert.equal(secondResult?.outcome, 'completed', `Follow-up turn failed: ${JSON.stringify(secondRun.events)}`);
    assert.match(joinedText(secondRun.events), /AFTER_CANCEL/i);
  });
});
