import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { TaskProgressInfo } from '../../domain/progress.js';
import type { AntigravityMode, AntigravityReasoningEffort } from '../../domain/session.js';
import type { LLMProvider, StreamChatParams, TokenUsage } from '../contracts.js';
import { BRIDGE_SHUTDOWN_REASON } from '../contracts.js';
import { prepareTextAttachmentPrompt } from '../local-attachments.js';
import type { PendingPermissions } from '../permission-gateway.js';
import { sseEvent } from '../sse.js';
import {
  AntigravityAcpClient,
  type AntigravityAcpClientOptions,
  type AntigravityAcpMessage,
} from './acp-client.js';

type Connection = Pick<
  AntigravityAcpClient,
  'request' | 'notify' | 'respond' | 'reject' | 'onMessage' | 'onDisconnect' | 'connected'
> & { close(): void | Promise<void> };

export interface AntigravityAcpProviderOptions {
  clientFactory?: (options: AntigravityAcpClientOptions) => Promise<Connection>;
  executable?: string;
  /** Extra CLI arguments passed after `acp`. */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  cancelTimeoutMs?: number;
}

interface Session {
  bridgeId: string;
  nativeId?: string;
  cwd: string;
  yolo: boolean;
  sandbox: boolean;
  configOptions: Array<Record<string, any>>;
  availableModels: Array<{ modelId: string; name?: string }>;
  disposalError?: Error;
  client?: Connection;
  ready: Promise<void>;
}

interface Turn {
  cancel(): Promise<void>;
  done: Promise<void>;
}

const sessions = new Map<string, Session>();
const turns = new Map<string, Turn>();

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function todoStatus(value: unknown): TaskProgressInfo['status'] | 'cancelled' {
  if (value === 'completed' || value === 3) return 'completed';
  if (value === 'in_progress' || value === 2) return 'in_progress';
  if (value === 'cancelled' || value === 4) return 'cancelled';
  return 'pending';
}

function planTasks(value: unknown): TaskProgressInfo[] {
  return (Array.isArray(value) ? value : []).flatMap(item => {
    const entry = record(item);
    const status = todoStatus(entry.status);
    return typeof entry.content === 'string' && entry.content.trim() && status !== 'cancelled'
      ? [{ text: entry.content.trim(), status }]
      : [];
  });
}

function sessionFor(id: string): Session | undefined {
  return sessions.get(id) || [...sessions.values()].find(session => session.nativeId === id);
}

async function disposeSession(session: Session): Promise<void> {
  try {
    if (session.client?.connected && session.nativeId) {
      await session.client.request('session/close', { sessionId: session.nativeId }, 3_000).catch(() => {});
    }
    await session.client?.close();
    session.disposalError = undefined;
  } catch (error) {
    session.disposalError = error instanceof Error ? error : new Error(String(error));
    throw session.disposalError;
  }
}

function forget(session: Session): void {
  if (sessions.get(session.bridgeId) === session) sessions.delete(session.bridgeId);
}

export async function interruptAntigravityAcpSession(sessionId: string): Promise<boolean> {
  const turn = turns.get(sessionFor(sessionId)?.bridgeId || sessionId);
  if (!turn) return false;
  try {
    await turn.cancel();
  } finally {
    await turn.done;
  }
  return true;
}

export async function closeAntigravityAcpSession(sessionId: string): Promise<void> {
  const session = sessionFor(sessionId);
  if (!session) return;
  try {
    await interruptAntigravityAcpSession(session.bridgeId);
  } finally {
    await session.ready.catch(() => {});
    await disposeSession(session);
    forget(session);
  }
}

export function getAntigravityAcpSessionActivity(sessionId: string): 'idle' | 'active' | 'unknown' {
  const session = sessionFor(sessionId);
  if (session?.disposalError) return 'unknown';
  if (!turns.has(session?.bridgeId || sessionId)) return 'idle';
  return session?.client?.connected ? 'active' : 'unknown';
}

export async function closeAllAntigravityAcpSessions(): Promise<void> {
  await Promise.all([...sessions.keys()].map(closeAntigravityAcpSession));
}

function buildAcpArgs(params: StreamChatParams, options: AntigravityAcpProviderOptions): string[] {
  const args = ['acp', ...(options.args || [])];
  if (params.antigravityMode === 'yolo') args.push('--dangerously-skip-permissions');
  if (params.antigravitySandbox === true) args.push('--sandbox');
  return args;
}

async function prepareSession(params: StreamChatParams, options: AntigravityAcpProviderOptions): Promise<Session> {
  const cwd = path.resolve(params.workingDirectory || process.cwd());
  const yolo = params.antigravityMode === 'yolo';
  const sandbox = params.antigravitySandbox === true;
  const existing = sessions.get(params.sessionId);
  if (existing) {
    await existing.ready;
    if (
      existing.cwd === cwd
      && existing.nativeId === params.antigravitySessionId
      && existing.yolo === yolo
      && existing.sandbox === sandbox
      && existing.client?.connected
    ) {
      return existing;
    }
    await disposeSession(existing);
    forget(existing);
  }
  if (params.antigravitySessionId && [...sessions.values()].some(s => s.nativeId === params.antigravitySessionId)) {
    throw new Error('这个 Antigravity ACP 会话已有执行者，未启动第二个进程。');
  }

  const session: Session = {
    bridgeId: params.sessionId,
    nativeId: params.antigravitySessionId,
    cwd,
    yolo,
    sandbox,
    configOptions: [],
    availableModels: [],
    ready: Promise.resolve(),
  };
  sessions.set(params.sessionId, session);
  session.ready = (async () => {
    const client = await (options.clientFactory || AntigravityAcpClient.start)({
      executable: options.executable,
      args: buildAcpArgs(params, options),
      cwd,
      env: options.env,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    session.client = client;
    const loadingRequests = client.onMessage(message => {
      if (message.id !== undefined && message.method) {
        client.reject(message.id, -32601, 'Client is loading the session');
      }
    });
    try {
      const initialized = await client.request<Record<string, unknown>>('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'codelark', version: '0.5.1' },
        clientCapabilities: {},
      });
      const caps = record(initialized.agentCapabilities);
      if (params.antigravitySessionId && caps.loadSession !== true && caps.load_session !== true) {
        throw new Error('此 Antigravity ACP 版本不支持恢复会话，未创建替代会话或重发输入。');
      }
      if (params.antigravitySessionId) {
        const loaded = await client.request<Record<string, any>>(
          'session/load',
          { sessionId: params.antigravitySessionId, cwd, mcpServers: [] },
          120_000,
        );
        session.configOptions = Array.isArray(loaded?.configOptions) ? loaded.configOptions : [];
        session.availableModels = Array.isArray(loaded?.models?.availableModels) ? loaded.models.availableModels : [];
      } else {
        const created = await client.request<Record<string, any>>(
          'session/new',
          { cwd, mcpServers: [] },
          120_000,
        );
        if (!created?.sessionId || typeof created.sessionId !== 'string') {
          throw new Error('Antigravity ACP 未返回原生会话 ID。');
        }
        session.nativeId = created.sessionId;
        session.configOptions = Array.isArray(created.configOptions) ? created.configOptions : [];
        session.availableModels = Array.isArray(created.models?.availableModels) ? created.models.availableModels : [];
      }
    } finally {
      loadingRequests();
    }
  })();

  try {
    await session.ready;
    return session;
  } catch (error) {
    await disposeSession(session);
    forget(session);
    throw error;
  }
}

async function applySessionConfigOptions(
  client: Connection,
  session: Session,
  params: StreamChatParams,
): Promise<void> {
  const setOption = async (category: string, desired: string): Promise<boolean> => {
    const option = session.configOptions.find(item => item.category === category || item.id === category);
    if (!option || option.currentValue === desired) return Boolean(option);
    const allowed = Array.isArray(option.options) ? option.options : [];
    if (allowed.length > 0 && !allowed.some((entry: any) => entry.value === desired)) return false;
    const response = await client.request<Record<string, any>>('session/set_config_option', {
      sessionId: session.nativeId,
      configId: option.id,
      value: desired,
    });
    if (Array.isArray(response?.configOptions)) session.configOptions = response.configOptions;
    return true;
  };

  const desiredModel = params.model?.trim();
  if (desiredModel) {
    const appliedAsConfig = await setOption('model', desiredModel);
    if (!appliedAsConfig) {
      // Fall back to matching an advertised model variant via session/set_model
      const matchingVariant = session.availableModels.find(m => m.modelId === desiredModel);
      if (matchingVariant) {
        await client.request('session/set_model', {
          sessionId: session.nativeId,
          modelId: matchingVariant.modelId,
        }).catch(() => {});
      }
    }
  }

  const desiredEffort: AntigravityReasoningEffort | undefined = params.antigravityReasoningEffort;
  if (desiredEffort) {
    await setOption('thought_level', desiredEffort);
  }

  const desiredMode: AntigravityMode | undefined = params.antigravityMode;
  if (desiredMode && desiredMode !== 'yolo') {
    await setOption('mode', desiredMode);
  }
}

function toolName(update: Record<string, any>): string {
  if (typeof update.kind === 'string') {
    const byKind: Record<string, string> = {
      execute: 'Shell',
      read: 'Read',
      edit: 'apply_patch',
      delete: 'apply_patch',
      search: 'Search',
      fetch: 'WebFetch',
    };
    if (byKind[update.kind]) return byKind[update.kind];
  }
  return (typeof update.name === 'string' && update.name)
    || (typeof update.title === 'string' && update.title)
    || 'Antigravity Tool';
}

function textLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function patchDiffLines(beforeText: string, afterText: string): string[] {
  if (beforeText === afterText) return [];
  const before = textLines(beforeText);
  const after = textLines(afterText);
  let prefix = 0;
  let suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) suffix++;
  if (prefix === before.length && prefix === after.length) prefix = Math.max(0, prefix - 1);
  const start = Math.max(0, prefix - 3);
  const tail = Math.min(3, suffix);
  const removed = before.slice(prefix, before.length - suffix).map(line => `-${line}`);
  const added = after.slice(prefix, after.length - suffix).map(line => `+${line}`);
  return [
    `@@ -${start + 1},${before.length - suffix + tail - start} +${start + 1},${after.length - suffix + tail - start} @@`,
    ...before.slice(start, prefix).map(line => ` ${line}`),
    ...removed,
    ...added,
    ...before.slice(before.length - suffix, before.length - suffix + tail).map(line => ` ${line}`),
  ];
}

function completedPatchInput(update: Record<string, any>, kind: string | undefined, cwd: string): { patch: string; workdir: string } | undefined {
  const diffs = (Array.isArray(update.content) ? update.content : [])
    .map(record)
    .filter(block => block.type === 'diff' && typeof block.path === 'string' && typeof block.newText === 'string'
      && (block.oldText === null || typeof block.oldText === 'string'));
  if (!diffs.length) return undefined;
  const lines = ['*** Begin Patch'];
  for (const diff of diffs) {
    const action = kind === 'delete' ? 'Delete' : diff.oldText === null ? 'Add' : 'Update';
    lines.push(`*** ${action} File: ${diff.path}`);
    if (action === 'Update') {
      lines.push(...patchDiffLines(diff.oldText, diff.newText));
    } else {
      lines.push(...textLines(action === 'Delete' ? diff.oldText || '' : diff.newText).map(line => `${action === 'Delete' ? '-' : '+'}${line}`));
    }
  }
  lines.push('*** End Patch');
  return { patch: lines.join('\n'), workdir: cwd };
}

function initialToolInput(update: Record<string, any>, cwd: string): unknown {
  const input = record(update.rawInput ?? update.args);
  if (update.kind === 'execute') {
    const command = input.CommandLine ?? input.command ?? update.title;
    if (typeof command === 'string' && command) return { ...input, command };
  }
  if (['edit', 'delete'].includes(update.kind)) {
    const filePath = input.path ?? input.Path ?? input.TargetFile;
    if (typeof filePath === 'string' && filePath) {
      return { ...input, patch: `*** Begin Patch\n*** ${update.kind === 'delete' ? 'Delete' : 'Update'} File: ${filePath}\n*** End Patch`, workdir: cwd };
    }
  }
  return Object.keys(input).length > 0 ? input : {};
}

function toolOutput(update: Record<string, any>, name: string): string {
  const content = Array.isArray(update.content)
    ? update.content.map((item: unknown) => {
        const block = record(item);
        if (block.type === 'content') return record(block.content).text || '';
        if (block.type === 'diff') return block.newText || '';
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        return '';
      }).filter(Boolean).join('\n')
    : '';
  const raw = record(update.rawOutput);
  if (name === 'Shell' && (typeof raw.stdout === 'string' || typeof raw.stderr === 'string' || Number.isInteger(raw.exitCode))) {
    const output = [raw.stdout, raw.stderr].filter(value => typeof value === 'string' && value.length > 0).join('\n') || content;
    return `${Number.isInteger(raw.exitCode) ? `Process exited with code ${raw.exitCode}\n` : ''}Output:\n${output}`;
  }
  if (content) return content;
  for (const key of ['output', 'content', 'markdown', 'text']) {
    if (typeof raw[key] === 'string') return raw[key];
  }
  return typeof update.rawOutput === 'string'
    ? update.rawOutput
    : update.rawOutput === undefined
      ? ''
      : JSON.stringify(update.rawOutput, null, 2);
}

function mapPromptUsage(rawUsage: unknown): TokenUsage | undefined {
  const usage = record(rawUsage);
  const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined;
  const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    input_tokens: inputTokens ?? 0,
    output_tokens: outputTokens ?? 0,
    ...(typeof usage.cachedReadTokens === 'number' ? { cache_read_input_tokens: usage.cachedReadTokens } : {}),
    ...(typeof usage.cachedWriteTokens === 'number' ? { cache_creation_input_tokens: usage.cachedWriteTokens } : {}),
    ...(typeof usage.thoughtTokens === 'number' ? { reasoning_output_tokens: usage.thoughtTokens } : {}),
  };
}

function buildPromptBlocks(params: StreamChatParams, promptText: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: promptText }];
  for (const file of params.files || []) {
    if (file.type?.startsWith('image/') && file.data) {
      blocks.push({ type: 'image', data: file.data, mimeType: file.type });
    }
  }
  return blocks;
}

/** Direct ACP provider for Google Antigravity CLI (`agy acp`). */
export class AntigravityAcpProvider implements LLMProvider {
  constructor(
    private pendingPerms?: PendingPermissions,
    private options: AntigravityAcpProviderOptions = {},
  ) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    let readerCanceled = false;
    let cancel = async () => {};
    const pendingPerms = this.pendingPerms;
    const options = this.options;

    return new ReadableStream<string>({
      async start(controller) {
        const emit = (type: string, data: unknown) => {
          if (!readerCanceled) controller.enqueue(sseEvent(type, data));
        };
        if (turns.has(params.sessionId)) {
          emit('error', 'Antigravity ACP 上一轮尚未确认结束，请等待中断确认后再提交。');
          emit('done', '');
          controller.close();
          return;
        }

        let resolveDone!: () => void;
        const done = new Promise<void>(resolve => { resolveDone = resolve; });
        let session: Session | undefined;
        let promptPromise: Promise<Record<string, any>> | undefined;
        let cancellation: Promise<void> | undefined;
        let cancelFailure: Error | undefined;
        let interrupted = false;
        let acceptingUpdates = false;
        let unsubscribe = () => {};
        let accepted = false;
        const waitingPermissions = new Set<string>();

        const cancelPermissions = () => {
          for (const id of waitingPermissions) {
            pendingPerms?.resolve(id, { behavior: 'deny', message: 'Antigravity 请求已中断。' });
          }
        };

        const cancelPrompt = async () => {
          if (!session?.client || !promptPromise) return;
          if (cancellation) return cancellation;
          const client = session.client;
          const pending = promptPromise;
          cancellation = (async () => {
            client.notify('session/cancel', { sessionId: session!.nativeId });
            cancelPermissions();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                pending,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error('Antigravity ACP 尚未确认中断，已关闭本连接防止重叠执行。')),
                    options.cancelTimeoutMs ?? 15_000,
                  );
                }),
              ]);
            } catch (error) {
              cancelFailure = error instanceof Error ? error : new Error(String(error));
              await disposeSession(session!);
              forget(session!);
              throw error;
            } finally {
              if (timer) clearTimeout(timer);
            }
          })();
          return cancellation;
        };

        cancel = async () => {
          interrupted = true;
          await cancelPrompt();
        };

        const turn: Turn = { cancel, done };
        turns.set(params.sessionId, turn);
        const onAbort = () => { void cancel().catch(() => {}); };
        params.abortController?.signal.addEventListener('abort', onAbort, { once: true });

        const markAccepted = () => {
          if (accepted) return;
          accepted = true;
          params.onInputAccepted?.();
          params.onRuntimeStatusChange?.('running');
          emit('status', { reasoning: 'Antigravity ACP 已接收消息，正在执行。' });
        };

        const waitPermission = async (message: AntigravityAcpMessage) => {
          const payload = record(message.params);
          const id = `antigravity-acp:${params.sessionId}:${randomUUID()}`;
          if (!pendingPerms) {
            throw new Error('Antigravity ACP 需要交互确认，但当前没有权限通道。');
          }
          waitingPermissions.add(id);
          const pending = pendingPerms.waitFor(id);
          emit('permission_request', {
            permissionRequestId: id,
            toolName: record(payload.toolCall).title || record(payload.toolCall).name || 'Antigravity Tool Permission',
            toolInput: { ...record(payload.toolCall), options: payload.options },
            suggestions: [],
          });
          params.onRuntimeStatusChange?.('waiting');
          try {
            return await pending;
          } finally {
            waitingPermissions.delete(id);
            params.onRuntimeStatusChange?.(interrupted ? 'interrupted' : 'running');
          }
        };

        try {
          if (params.abortController?.signal.aborted) interrupted = true;
          if (interrupted) return;

          session = await prepareSession(params, options);
          const client = session.client!;
          emit('status', { session_id: session.nativeId, cwd: session.cwd });

          await applySessionConfigOptions(client, session, params);

          const tools = new Map<string, { name: string; kind?: string; complete: boolean }>();
          let thinkingBuffer = '';

          const handleRequest = async (message: AntigravityAcpMessage) => {
            if (message.id === undefined) return;
            const payload = record(message.params);
            if (payload.sessionId && payload.sessionId !== session!.nativeId) {
              client.reject(message.id, -32602, 'Session does not belong to this connection');
              return;
            }
            if (!acceptingUpdates || interrupted) {
              client.respond(message.id, { outcome: { outcome: 'cancelled' } });
              return;
            }
            if (message.method === 'session/request_permission') {
              markAccepted();
              const resolution = await waitPermission(message);
              const choices = Array.isArray(payload.options) ? payload.options : [];
              const targetKinds = resolution.behavior === 'allow'
                ? ['allow_once', 'allow_always']
                : ['reject_once', 'reject_always'];
              const option = targetKinds
                .map(kind => choices.find((choice: any) => choice.kind === kind))
                .find(Boolean);
              client.respond(
                message.id,
                interrupted || !option
                  ? { outcome: { outcome: 'cancelled' } }
                  : { outcome: { outcome: 'selected', optionId: option.optionId } },
              );
            } else {
              client.reject(message.id, -32601, `Unsupported client method: ${message.method}`);
            }
          };

          unsubscribe = client.onMessage(message => {
            if (message.id !== undefined && message.method) {
              void handleRequest(message).catch(error => {
                if (client.connected) client.reject(message.id!, -32603, errorMessage(error));
                emit('status', { reasoning: errorMessage(error) });
              });
              return;
            }
            const payload = record(message.params);
            if (!acceptingUpdates || message.method !== 'session/update' || payload.sessionId !== session!.nativeId) return;
            const update = record(payload.update);

            if (update.sessionUpdate === 'plan') {
              const tasks = planTasks(update.entries);
              emit('task_update', { tasks, todos: tasks });
              return;
            }
            if (update.sessionUpdate === 'usage_update') {
              if (typeof update.used === 'number' && typeof update.size === 'number' && update.size > 0) {
                emit('context_usage', {
                  model_context_window: update.size,
                  last_token_usage: { input_tokens: update.used },
                });
              }
              return;
            }
            if (!['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
              return;
            }
            markAccepted();

            if (update.sessionUpdate === 'agent_message_chunk') {
              const content = record(update.content);
              if (content.type === 'text' && typeof content.text === 'string') {
                emit('text', content.text);
              }
            } else if (update.sessionUpdate === 'agent_thought_chunk') {
              const content = record(update.content);
              if (content.type === 'text' && typeof content.text === 'string') {
                thinkingBuffer = `${thinkingBuffer}${content.text}`.slice(-400);
                emit('status', { reasoning: 'Antigravity 正在思考。', thinking: thinkingBuffer.trim() });
              } else {
                emit('status', { reasoning: 'Antigravity 正在思考。' });
              }
            } else if (typeof update.toolCallId === 'string') {
              let tool = tools.get(update.toolCallId);
              if (!tool) {
                tool = { name: toolName(update), kind: update.kind, complete: false };
                tools.set(update.toolCallId, tool);
                emit('tool_use', {
                  id: update.toolCallId,
                  name: tool.name,
                  input: initialToolInput(update, session!.cwd),
                });
              }
              if (!tool.complete && ['completed', 'failed', 'cancelled'].includes(update.status)) {
                tool.complete = true;
                const exitCode = record(update.rawOutput).exitCode;
                const patch = completedPatchInput(update, tool.kind || update.kind, session!.cwd);
                const output = toolOutput(
                  patch && Array.isArray(update.content)
                    ? { ...update, content: update.content.filter((block: any) => block?.type !== 'diff') }
                    : update,
                  tool.name,
                );
                emit('tool_result', {
                  tool_use_id: update.toolCallId,
                  content: output,
                  ...(patch ? { name: 'apply_patch', input: patch } : {}),
                  is_error: update.status !== 'completed' || (tool.name === 'Shell' && Number.isInteger(exitCode) && exitCode !== 0),
                  show_output: !patch || Boolean(output),
                });
              }
            }
          });

          let promptText = prepareTextAttachmentPrompt(params);
          if (!params.antigravitySessionId && params.systemPrompt) {
            promptText = `${params.systemPrompt}\n\n${promptText}`;
          }

          acceptingUpdates = true;
          cancellation = undefined;
          promptPromise = client.request<Record<string, any>>(
            'session/prompt',
            { sessionId: session.nativeId, prompt: buildPromptBlocks(params, promptText) },
            0,
          );
          if (params.abortController?.signal.aborted) onAbort();

          let result: Record<string, any> | undefined;
          let failure: string | undefined;
          try {
            result = await promptPromise;
          } catch (error) {
            failure = errorMessage(error);
          }
          acceptingUpdates = false;
          if (cancellation) await cancellation;
          promptPromise = undefined;

          if (failure && !interrupted) {
            throw new Error(failure);
          }

          let stopReason = typeof result?.stopReason === 'string' ? result.stopReason : 'unknown';
          if (interrupted) stopReason = 'cancelled';
          if (stopReason !== 'cancelled') markAccepted();
          if (!['end_turn', 'cancelled'].includes(stopReason)) {
            emit('error', `Antigravity ACP 本轮未正常完成：${stopReason}`);
          }
          const usage = mapPromptUsage(result?.usage);
          emit('result', {
            session_id: session.nativeId,
            cwd: session.cwd,
            outcome: stopReason === 'cancelled' ? 'aborted' : stopReason === 'end_turn' ? 'completed' : 'failed',
            stop_reason: stopReason,
            ...(usage ? { usage } : {}),
          });
        } catch (error) {
          let failure = cancelFailure || error;
          if (session?.client && !session.client.connected) {
            try { await disposeSession(session); } catch (closeError) { failure = closeError; }
          }
          emit('error', errorMessage(failure));
          emit('result', {
            ...(session?.nativeId ? { session_id: session.nativeId, cwd: session.cwd } : {}),
            outcome: 'failed',
          });
        } finally {
          acceptingUpdates = false;
          unsubscribe();
          cancelPermissions();
          emit('status', { clear_pending_questions: true });
          params.abortController?.signal.removeEventListener('abort', onAbort);
          if (turns.get(params.sessionId) === turn) turns.delete(params.sessionId);
          if (params.abortController?.signal.reason === BRIDGE_SHUTDOWN_REASON && session) {
            try { await disposeSession(session); forget(session); } catch (error) { emit('error', errorMessage(error)); }
          }
          emit('done', '');
          if (!readerCanceled) controller.close();
          resolveDone();
        }
      },
      async cancel() {
        readerCanceled = true;
        await cancel();
      },
    });
  }
}
