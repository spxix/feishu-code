import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  AntigravityAcpProvider,
  closeAllAntigravityAcpSessions,
  closeAntigravityAcpSession,
  getAntigravityAcpSessionActivity,
  interruptAntigravityAcpSession,
} from '../../../../runtime/antigravity/acp-provider.js';
import type { AntigravityAcpMessage } from '../../../../runtime/antigravity/acp-client.js';
import { PendingPermissions } from '../../../../runtime/permission-gateway.js';
import { buildToolProgressBlocks } from '../../../../shared/progress/tool-rendering.js';

class FakeAntigravityAcp {
  connected = true;
  nativeId = `agy-${randomUUID()}`;
  calls: Array<{ method: string; params: any }> = [];
  responses: Array<{ id: string | number; result: any }> = [];
  listeners = new Set<(message: AntigravityAcpMessage) => void>();
  disconnectListeners = new Set<(error: Error) => void>();
  pending?: { resolve(value: any): void; reject(error: Error): void };
  onPrompt?: (params: any, index: number) => void;
  onCancel?: () => void;
  count = 0;
  startArgs?: string[];
  startCwd?: string;
  configOptions: Array<Record<string, any>> = [
    {
      id: 'model',
      category: 'model',
      currentValue: 'gemini-3.1-pro',
      options: [{ value: 'gemini-3.1-pro' }, { value: 'claude-sonnet-4-6' }],
    },
    {
      id: 'thought_level',
      category: 'thought_level',
      currentValue: 'medium',
      options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
    },
    {
      id: 'mode',
      category: 'mode',
      currentValue: 'default',
      options: [{ value: 'default' }, { value: 'accept-edits' }, { value: 'auto' }, { value: 'plan' }],
    },
  ];

  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'initialize') {
      return Promise.resolve({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
      } as T);
    }
    if (method === 'session/new') {
      return Promise.resolve({
        sessionId: this.nativeId,
        models: {
          currentModelId: 'gemini-3.1-pro',
          availableModels: [{ modelId: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' }],
        },
        configOptions: this.configOptions,
      } as T);
    }
    if (method === 'session/load') {
      this.nativeId = (params as any).sessionId;
      // Historical replay during session/load must be suppressed.
      this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STALE HISTORY' } });
      this.update({ sessionUpdate: 'tool_call', toolCallId: 'old-tool', kind: 'execute' });
      return Promise.resolve({ configOptions: this.configOptions } as T);
    }
    if (method === 'session/set_config_option') {
      const { configId, value } = params as any;
      const option = this.configOptions.find((item) => item.id === configId);
      if (option) option.currentValue = value;
      return Promise.resolve({ configOptions: this.configOptions } as T);
    }
    if (method === 'session/prompt') {
      assert.equal(this.pending, undefined, 'only one native prompt at a time');
      const promise = new Promise<T>((resolve, reject) => {
        this.pending = { resolve, reject };
      });
      const count = ++this.count;
      queueMicrotask(() => this.onPrompt?.(params, count));
      return promise;
    }
    return Promise.resolve({} as T);
  }

  notify(method: string, params: unknown = {}): void {
    this.calls.push({ method, params });
    if (method === 'session/cancel') this.onCancel?.();
  }

  respond(id: string | number, result: unknown): void {
    this.responses.push({ id, result });
  }

  reject(id: string | number, code: number, message: string): void {
    this.responses.push({ id, result: { error: { code, message } } });
  }

  onMessage(listener: (message: AntigravityAcpMessage) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => { this.disconnectListeners.delete(listener); };
  }

  send(message: AntigravityAcpMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  update(update: unknown): void {
    this.send({ method: 'session/update', params: { sessionId: this.nativeId, update } });
  }

  end(stopReason = 'end_turn', usage?: Record<string, number>): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve({ stopReason, ...(usage ? { usage } : {}) });
  }

  close(): void {
    this.disconnect(new Error('test process exited'));
  }

  disconnect(error: Error): void {
    if (!this.connected) return;
    this.connected = false;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
    for (const listener of this.disconnectListeners) listener(error);
  }
}

interface Event { type: string; data: any }

async function collect(stream: ReadableStream<string>, onEvent?: (event: Event) => void): Promise<Event[]> {
  const reader = stream.getReader();
  const events: Event[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const raw = JSON.parse(next.value.slice(6));
    let data: unknown = raw.data;
    try { data = JSON.parse(raw.data); } catch {}
    const event = { type: raw.type, data };
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function setup(perms?: PendingPermissions) {
  const client = new FakeAntigravityAcp();
  const provider = new AntigravityAcpProvider(perms, {
    clientFactory: async (options) => {
      client.startArgs = options.args;
      client.startCwd = options.cwd;
      return client;
    },
    cancelTimeoutMs: 100,
  });
  const sessionId = `bridge-${randomUUID()}`;
  return { client, provider, sessionId };
}

afterEach(async () => {
  await closeAllAntigravityAcpSessions();
});

describe('Antigravity ACP provider', () => {
  it('streams thinking, text, tools, diffs, plan, and usage for a new session', async () => {
    const { client, provider, sessionId } = setup();
    client.onPrompt = () => {
      client.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'checking files' } });
      client.update({
        sessionUpdate: 'plan',
        entries: [
          { content: 'Inspect repo', status: 'completed' },
          { content: 'Run tests', status: 'in_progress' },
        ],
      });
      client.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-1',
        kind: 'execute',
        rawInput: { command: 'echo hello' },
      });
      client.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'cmd-1',
        status: 'completed',
        rawOutput: { exitCode: 0, stdout: 'hello', stderr: '' },
      });
      client.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'edit-1',
        kind: 'edit',
        rawInput: { path: '/repo/a.ts' },
      });
      client.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'edit-1',
        status: 'completed',
        content: [{ type: 'diff', path: '/repo/a.ts', oldText: 'const a = 1;\n', newText: 'const a = 2;\n' }],
      });
      client.update({ sessionUpdate: 'usage_update', used: 1200, size: 100000 });
      client.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'All done!' } });
      client.end('end_turn', { inputTokens: 800, outputTokens: 200, cachedReadTokens: 100 });
    };

    const events = await collect(provider.streamChat({
      sessionId,
      runtime: 'antigravity',
      prompt: 'say hello',
      workingDirectory: '/repo',
      model: 'claude-sonnet-4-6',
      antigravityMode: 'auto',
      antigravityReasoningEffort: 'high',
    }));

    assert.equal(events.filter((e) => e.type === 'text').map((e) => e.data).join(''), 'All done!');
    assert.ok(events.some((e) => e.type === 'status' && /checking files/.test(e.data.thinking || '')));
    assert.deepEqual(events.find((e) => e.type === 'task_update')?.data.tasks, [
      { text: 'Inspect repo', status: 'completed' },
      { text: 'Run tests', status: 'in_progress' },
    ]);

    const editResult = events.find((e) => e.type === 'tool_result' && e.data.tool_use_id === 'edit-1')?.data;
    assert.equal(editResult?.name, 'apply_patch');
    const [block] = buildToolProgressBlocks([{
      id: 'edit-1',
      name: editResult.name,
      input: JSON.stringify(editResult.input),
      output: editResult.content,
      status: 'complete',
      showOutput: editResult.show_output,
    }]);
    assert.match(block!.detail, /-const a = 1;\n\+const a = 2;/);

    const result = events.find((e) => e.type === 'result')?.data;
    assert.equal(result?.outcome, 'completed');
    assert.equal(result?.session_id, client.nativeId);
    assert.equal(result?.usage?.input_tokens, 800);
    assert.equal(result?.usage?.output_tokens, 200);
    assert.equal(result?.usage?.cache_read_input_tokens, 100);

    const setConfigs = client.calls.filter((c) => c.method === 'session/set_config_option').map((c) => [c.params.configId, c.params.value]);
    assert.deepEqual(setConfigs, [
      ['model', 'claude-sonnet-4-6'],
      ['thought_level', 'high'],
      ['mode', 'auto'],
    ]);
  });

  it('loads an existing native session without replaying historical chunks', async () => {
    const { client, provider, sessionId } = setup();
    client.onPrompt = () => {
      client.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Resumed reply' } });
      client.end();
    };
    const events = await collect(provider.streamChat({
      sessionId,
      runtime: 'antigravity',
      antigravitySessionId: 'existing-conv-123',
      prompt: 'continue',
    }));
    assert.equal(client.calls.filter((c) => c.method === 'session/load').length, 1);
    assert.equal(client.calls.filter((c) => c.method === 'session/new').length, 0);
    assert.equal(events.filter((e) => e.type === 'text').map((e) => e.data).join(''), 'Resumed reply');
    assert.equal(events.some((e) => e.type === 'tool_use'), false);
  });

  it('passes public yolo and sandbox CLI flags and reconnects when cwd or flags change', async () => {
    const launches: Array<{ args?: string[]; cwd?: string }> = [];
    const clients: FakeAntigravityAcp[] = [];
    const provider = new AntigravityAcpProvider(undefined, {
      clientFactory: async (options) => {
        launches.push({ args: options.args, cwd: options.cwd });
        const client = new FakeAntigravityAcp();
        client.onPrompt = () => client.end();
        clients.push(client);
        return client;
      },
    });
    const sessionId = `bridge-${randomUUID()}`;
    await collect(provider.streamChat({
      sessionId,
      runtime: 'antigravity',
      prompt: 'first',
      workingDirectory: '/tmp',
      antigravityMode: 'default',
      antigravitySandbox: false,
    }));
    const nativeId = clients[0]!.nativeId;
    await collect(provider.streamChat({
      sessionId,
      runtime: 'antigravity',
      antigravitySessionId: nativeId,
      prompt: 'second',
      workingDirectory: '/',
      antigravityMode: 'yolo',
      antigravitySandbox: true,
    }));

    assert.equal(clients.length, 2);
    assert.equal(clients[0]!.connected, false);
    assert.deepEqual(launches[0]?.args, ['acp']);
    assert.equal(launches[1]?.cwd, path.resolve('/'));
    assert.deepEqual(launches[1]?.args, ['acp', '--dangerously-skip-permissions', '--sandbox']);
    assert.equal(clients[1]!.calls.find((c) => c.method === 'session/load')?.params.sessionId, nativeId);
  });

  it('routes session/request_permission through PendingPermissions', async () => {
    const perms = new PendingPermissions();
    const { client, provider, sessionId } = setup(perms);
    const run = collect(provider.streamChat({
      sessionId,
      runtime: 'antigravity',
      prompt: 'run shell',
    }), (event) => {
      if (event.type === 'permission_request') {
        perms.resolve(event.data.permissionRequestId, { behavior: 'allow' });
      }
    });
    await until(() => client.count === 1);
    client.send({
      id: 42,
      method: 'session/request_permission',
      params: {
        sessionId: client.nativeId,
        toolCall: { title: 'Run rm' },
        options: [
          { optionId: 'allow_1', kind: 'allow_once', name: 'Allow' },
          { optionId: 'deny_1', kind: 'reject_once', name: 'Deny' },
        ],
      },
    });
    await until(() => client.responses.some((r) => r.id === 42));
    assert.deepEqual(client.responses[0]?.result, { outcome: { outcome: 'selected', optionId: 'allow_1' } });
    client.end();
    await run;
    assert.equal(perms.size, 0);
  });

  it('cancels an active turn cleanly and closes session on closeAntigravityAcpSession', async () => {
    const { client, provider, sessionId } = setup();
    client.onCancel = () => client.end('cancelled');
    const first = collect(provider.streamChat({
      sessionId,
      runtime: 'antigravity',
      prompt: 'long task',
    }));
    await until(() => client.count === 1);
    assert.equal(getAntigravityAcpSessionActivity(sessionId), 'active');
    assert.equal(await interruptAntigravityAcpSession(sessionId), true);
    const events = await first;
    assert.equal(events.find((e) => e.type === 'result')?.data.outcome, 'aborted');
    assert.equal(getAntigravityAcpSessionActivity(sessionId), 'idle');

    await closeAntigravityAcpSession(sessionId);
    assert.equal(client.calls.some((c) => c.method === 'session/close'), true);
    assert.equal(client.connected, false);
  });
});
