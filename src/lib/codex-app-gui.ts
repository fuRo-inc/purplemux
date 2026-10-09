import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import readline from 'readline';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { getRemoteHost } from '@/lib/remote-host-store';
import type { IWorkspace, ITab } from '@/types/terminal';

type Json = Record<string, unknown>;
type PendingCall = { resolve: (value: Json) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> };
export type CodexGuiItem = {
  id: string;
  type: string;
  text: string;
  title?: string;
  status?: string;
};
export type CodexGuiModel = {
  id: string;
  model: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
};
export type CodexGuiApproval = { requestId: string | number; method: string; command: string; reason: string };
export type CodexGuiState = {
  ready: boolean;
  running: boolean;
  busy: boolean;
  threadId: string | null;
  turnId: string | null;
  model: string | null;
  effort: string | null;
  models: CodexGuiModel[];
  items: CodexGuiItem[];
  approvals: CodexGuiApproval[];
  error: string | null;
};

const sessions = globalThis as unknown as { __purplemuxCodexApps?: Map<string, Promise<CodexGuiRuntime>> };
if (!sessions.__purplemuxCodexApps) sessions.__purplemuxCodexApps = new Map();
const runtimes = sessions.__purplemuxCodexApps!;
const KEY_RE = /^[a-zA-Z0-9_-]{1,120}$/;
const MAX_ITEMS = 160;
const MAX_TEXT = 48000;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const RETAINED_DIR = path.join(os.homedir(), '.purplemux', 'codex-app-sessions');

const asRecord = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const asString = (value: unknown): string =>
  typeof value === 'string' ? value : '';
const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

export class CodexGuiRuntime {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, PendingCall>();
  private listeners = new Set<(state: CodexGuiState) => void>();
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private closed = false;
  private state: CodexGuiState = {
    ready: false, running: false, busy: false, threadId: null, turnId: null,
    model: null, effort: null, models: [], items: [], approvals: [], error: null,
  };

  constructor(
    private readonly workspace: IWorkspace,
    private readonly tab: ITab,
  ) {}

  snapshot(): CodexGuiState {
    return {
      ...this.state,
      models: [...this.state.models],
      items: this.state.items.map((item) => ({ ...item })),
      approvals: [...this.state.approvals],
    };
  }

  subscribe(send: (state: CodexGuiState) => void): () => void {
    this.listeners.add(send);
    send(this.snapshot());
    return () => this.listeners.delete(send);
  }

  private publish(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      const snapshot = this.snapshot();
      for (const listener of this.listeners) {
        try { listener(snapshot); } catch { this.listeners.delete(listener); }
      }
    }, 90);
  }

  private sessionFile(): string {
    return path.join(RETAINED_DIR, this.workspace.id + '__' + this.tab.id + '.json');
  }

  private async readStored(): Promise<void> {
    try {
      const stored = asRecord(JSON.parse(await fs.readFile(this.sessionFile(), 'utf8')));
      this.state.threadId = asString(stored.threadId) || null;
      this.state.model = asString(stored.model) || null;
      this.state.effort = asString(stored.effort) || null;
    } catch {
      // A new tab may have no prior App Server thread.
    }
  }

  private async store(): Promise<void> {
    await fs.mkdir(RETAINED_DIR, { recursive: true, mode: 0o700 });
    const filename = this.sessionFile();
    const temporary = filename + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temporary, JSON.stringify({
      threadId: this.state.threadId, model: this.state.model, effort: this.state.effort,
    }), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, filename);
  }

  private sendMessage(message: Json): void {
    if (!this.child || !this.child.stdin.writable || this.closed) {
      throw new Error('Codex App Server is not connected');
    }
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  private request(method: string, params: Json, timeoutMs = 30000): Promise<Json> {
    const id = ++this.seq;
    return new Promise<Json>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex request timed out: ' + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.sendMessage({ id, method, params }); } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error('Codex request failed'));
      }
    });
  }

  private upsert(id: string, type: string, patch: Partial<CodexGuiItem>): void {
    const existing = this.state.items.find((item) => item.id === id);
    if (existing) {
      Object.assign(existing, patch);
    } else {
      this.state.items.push({ id, type, text: '', ...patch });
      if (this.state.items.length > MAX_ITEMS) {
        this.state.items.splice(0, this.state.items.length - MAX_ITEMS);
      }
    }
    this.publish();
  }

  private handleNotification(method: string, params: Json): void {
    const item = asRecord(params.item);
    const itemId = asString(params.itemId) || asString(item.id);
    const type = asString(item.type);
    if (method === 'turn/started') {
      const turn = asRecord(params.turn);
      this.state.turnId = asString(turn.id) || null;
      this.state.busy = true;
    } else if (method === 'turn/completed') {
      const turn = asRecord(params.turn);
      this.state.busy = false;
      this.state.turnId = null;
      if (asString(turn.status) === 'failed') {
        this.state.error = asString(asRecord(turn.error).message) || 'Codex turn failed';
      }
      this.state.approvals = [];
    } else if (method === 'item/started' && itemId) {
      if (type === 'commandExecution') {
        this.upsert(itemId, 'command', {
          title: asString(item.command), status: 'running',
        });
      } else if (type === 'fileChange') {
        this.upsert(itemId, 'file-change', { title: 'ファイル変更', status: 'running' });
      } else if (type === 'agentMessage') {
        this.upsert(itemId, 'assistant', { status: 'streaming' });
      }
    } else if (method === 'item/agentMessage/delta') {
      const id = itemId || 'assistant-' + (this.state.turnId || 'current');
      const existing = this.state.items.find((entry) => entry.id === id);
      const delta = asString(params.delta);
      this.upsert(id, 'assistant', { text: ((existing?.text ?? '') + delta).slice(-MAX_TEXT), status: 'streaming' });
    } else if (method === 'item/completed' && itemId) {
      if (type === 'agentMessage') {
        this.upsert(itemId, 'assistant', {
          text: asString(item.text) || this.state.items.find((entry) => entry.id === itemId)?.text || '',
          status: 'completed',
        });
      } else if (type === 'commandExecution') {
        this.upsert(itemId, 'command', {
          title: asString(item.command),
          text: (asString(item.aggregatedOutput) || asString(item.output)).slice(-MAX_TEXT),
          status: asString(item.status) || 'completed',
        });
      } else if (type === 'fileChange') {
        this.upsert(itemId, 'file-change', { status: asString(item.status) || 'completed' });
      }
    } else if (method === 'turn/plan/updated') {
      const steps = Array.isArray(params.plan) ? params.plan : [];
      const description = steps.map((entry) => {
        const step = asRecord(entry);
        return '- ' + asString(step.step) + ' (' + asString(step.status) + ')';
      }).join('\n');
      this.upsert('plan-' + (this.state.turnId || 'current'), 'plan', { text: description });
    } else if (method === 'serverRequest/resolved') {
      const requestId = params.requestId;
      this.state.approvals = this.state.approvals.filter((approval) => String(approval.requestId) !== String(requestId));
    } else if (method === 'error') {
      this.state.error = asString(params.message) || 'Codex App Server error';
    }
    this.publish();
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line) > MAX_JSON_BYTES) return;
    let message: Json;
    try { message = asRecord(JSON.parse(line)); } catch { return; }
    const method = asString(message.method);
    const id = message.id;
    if ((typeof id === 'number' || typeof id === 'string') && method) {
      // Requests from the App Server are approval prompts. Never approve automatically.
      const params = asRecord(message.params);
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        this.state.approvals.push({
          requestId: id, method,
          command: asString(params.command) || asString(params.reason) || 'ファイル変更',
          reason: asString(params.reason),
        });
        this.publish();
      } else {
        this.state.error = '未対応のCodex確認要求: ' + method;
        this.publish();
      }
      return;
    }
    if (typeof id === 'number' && this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      if (message.error) {
        pending.reject(new Error(asString(asRecord(message.error).message) || 'Codex RPC error'));
      } else {
        pending.resolve(asRecord(message.result));
      }
      return;
    }
    if (method) this.handleNotification(method, asRecord(message.params));
  }

  terminate(): void {
    this.child?.kill();
    this.exit('Codex App Server terminated');
  }

  async start(): Promise<void> {
    if (!KEY_RE.test(this.workspace.id) || !KEY_RE.test(this.tab.id)) {
      throw new Error('Invalid workspace or tab identifier');
    }
    await this.readStored();
    const cwd = this.workspace.hostId ? this.workspace.remoteDirectory : this.tab.cwd || this.workspace.directories[0];
    if (!cwd || !cwd.startsWith('/') || cwd.includes('\n')) {
      throw new Error('Codex workspace directory must be absolute');
    }
    let command = 'codex';
    let args = ['app-server'];
    if (this.workspace.hostId) {
      const host = await getRemoteHost(this.workspace.hostId);
      if (!host) throw new Error('Remote host not found');
      if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(host.username) ||
          !/^[a-zA-Z0-9.:-]+$/.test(host.address) ||
          !Number.isInteger(host.port) || host.port < 1 || host.port > 65535) {
        throw new Error('Invalid remote SSH configuration');
      }
      command = 'ssh';
      // Interactive shell loads fnm/npm PATH; -T preserves clean JSON stdout.
      args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
        '-p', String(host.port), host.username + '@' + host.address,
        'bash -lic ' + shellQuote('exec codex app-server')];
    }
    const child = spawn(command, args, {
      cwd: this.workspace.hostId ? process.cwd() : cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    this.child = child;
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-1500);
    });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.handleLine(line));
    child.on('error', (error) => this.exit(error.message));
    child.on('exit', (code) => this.exit('Codex App Server exited (' + String(code) + ')' + (stderr ? ': ' + stderr.slice(-350) : '')));
    await this.request('initialize', {
      clientInfo: { name: 'purplemux', title: 'Purplemux', version: '0.1.0' },
    }, 25000);
    this.sendMessage({ method: 'initialized' });
    this.state.ready = true;
    this.state.running = true;
    try {
      const result = await this.request('model/list', { limit: 100, includeHidden: false }, 20000);
      this.state.models = (Array.isArray(result.data) ? result.data : []).map((raw) => {
        const value = asRecord(raw);
        return {
          id: asString(value.id),
          model: asString(value.model),
          displayName: asString(value.displayName) || asString(value.model),
          isDefault: value.isDefault === true,
          defaultReasoningEffort: asString(value.defaultReasoningEffort),
          supportedReasoningEfforts: (Array.isArray(value.supportedReasoningEfforts) ? value.supportedReasoningEfforts : [])
            .map((effort) => ({
              reasoningEffort: asString(asRecord(effort).reasoningEffort),
              description: asString(asRecord(effort).description),
            })),
        };
      }).filter((model) => model.model);
      if (this.state.model && !this.state.models.some((item) => item.model === this.state.model)) {
        this.state.model = null;
        this.state.effort = null;
        await this.store();
      }
    } catch (error) {
      this.state.error = 'モデル一覧を取得できません: ' + (error instanceof Error ? error.message : String(error));
    }
    if (this.state.threadId) {
      try {
        const result = await this.request('thread/resume', { threadId: this.state.threadId }, 40000);
        // thread/resume may return a summary rather than all messages.
        // Recover the transcript explicitly from the durable local/remote thread.
        try {
          const history = await this.request('thread/read', { threadId: this.state.threadId, includeTurns: true }, 35000);
          this.restore(asRecord(history.thread));
        } catch {
          this.restore(asRecord(result.thread));
        }
      } catch (error) {
        this.state.error = '以前の会話を再開できません: ' + (error instanceof Error ? error.message : String(error));
        this.state.threadId = null;
        await this.store();
      }
    }
    this.publish();
  }

  private restore(thread: Json): void {
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const items: CodexGuiItem[] = [];
    for (const rawTurn of turns.slice(-35)) {
      const turn = asRecord(rawTurn);
      for (const rawItem of (Array.isArray(turn.items) ? turn.items : [])) {
        const item = asRecord(rawItem);
        const type = asString(item.type);
        if (type === 'userMessage') {
          const content = Array.isArray(item.content) ? item.content : [];
          const text = content.map((part) => asString(asRecord(part).text)).filter(Boolean).join('\n');
          if (text) items.push({ id: asString(item.id) || 'user-' + items.length, type: 'user', text });
        } else if (type === 'agentMessage') {
          items.push({ id: asString(item.id) || 'assistant-' + items.length, type: 'assistant', text: asString(item.text) });
        } else if (type === 'commandExecution') {
          items.push({ id: asString(item.id) || 'command-' + items.length, type: 'command', text: asString(item.aggregatedOutput), title: asString(item.command), status: asString(item.status) });
        }
      }
    }
    this.state.items = items.slice(-MAX_ITEMS);
    this.publish();
  }

  private exit(message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.state.running = false;
    this.state.ready = false;
    this.state.busy = false;
    this.state.error = message;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.pending.clear();
    this.publish();
  }

  async action(
    action: 'new-thread' | 'send' | 'interrupt' | 'approve' | 'settings',
    args: { text?: string; model?: string; effort?: string; requestId?: string | number; decision?: string },
  ): Promise<CodexGuiState> {
    if (this.closed || !this.state.ready) throw new Error('Codex App Server is unavailable');
    if (action === 'approve') {
      const match = this.state.approvals.find((entry) => String(entry.requestId) === String(args.requestId));
      if (!match || (args.decision !== 'accept' && args.decision !== 'decline')) {
        throw new Error('Invalid or expired approval request');
      }
      this.sendMessage({ id: match.requestId, result: { decision: args.decision } });
      this.state.approvals = this.state.approvals.filter((entry) => entry !== match);
      this.publish();
      return this.snapshot();
    }
    if (action === 'interrupt') {
      if (this.state.threadId && this.state.turnId) {
        await this.request('turn/interrupt', { threadId: this.state.threadId, turnId: this.state.turnId });
      }
      return this.snapshot();
    }
    if (args.model !== undefined) {
      if (!this.state.models.some((m) => m.model === args.model)) throw new Error('Model is not available on this host');
      this.state.model = args.model;
      // Changing model resets the suggested effort unless client supplies one.
      if (args.effort === undefined) this.state.effort = null;
    }
    if (args.effort !== undefined) {
      const active = this.state.models.find((m) => m.model === (this.state.model || this.state.models.find((m) => m.isDefault)?.model));
      if (active && !active.supportedReasoningEfforts.some((e) => e.reasoningEffort === args.effort)) {
        throw new Error('Reasoning effort is not available for this model');
      }
      this.state.effort = args.effort;
    }
    await this.store();
    if (action === 'settings') { this.publish(); return this.snapshot(); }
    if (action === 'new-thread') {
      if (this.state.busy) throw new Error('Codex is working. Stop the current turn first.');
      this.state.threadId = null;
      this.state.items = [];
      this.state.error = null;
      await this.store();
      this.publish();
      return this.snapshot();
    }
    if (action === 'send') {
      const text = (args.text || '').trim();
      if (!text || text.length > 100000) throw new Error('Message must be 1–100000 characters');
      if (this.state.busy) throw new Error('Codex is already running a turn');
      // Lock before async thread/start so simultaneous desktop/mobile requests
      // cannot both create a new thread for the same tab.
      this.state.busy = true;
      this.state.error = null;
      this.publish();
      try {
        if (!this.state.threadId) {
          const cwd = this.workspace.hostId ? this.workspace.remoteDirectory : this.tab.cwd || this.workspace.directories[0];
          const result = await this.request('thread/start', {
            cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write',
            ...(this.state.model ? { model: this.state.model } : {}),
          }, 45000);
          const id = asString(asRecord(result.thread).id);
          if (!id) throw new Error('Codex did not return a thread ID');
          this.state.threadId = id;
          await this.store();
        }
        this.state.items.push({ id: 'user-' + Date.now(), type: 'user', text });
        if (this.state.items.length > MAX_ITEMS) this.state.items.shift();
        this.publish();
        const response = await this.request('turn/start', {
          threadId: this.state.threadId,
          input: [{ type: 'text', text, text_elements: [] }],
          ...(this.state.model ? { model: this.state.model } : {}),
          ...(this.state.effort ? { effort: this.state.effort } : {}),
        }, 45000);
        this.state.turnId = asString(asRecord(response.turn).id) || this.state.turnId;
      } catch (error) {
        this.state.busy = false;
        this.state.error = error instanceof Error ? error.message : String(error);
        this.publish();
        throw error;
      }
    }
    this.publish();
    return this.snapshot();
  }
}

export const getCodexGuiRuntime = async (workspace: IWorkspace, tab: ITab): Promise<CodexGuiRuntime> => {
  const key = workspace.id + ':' + tab.id;
  const existing = runtimes.get(key);
  if (existing) {
    const runtime = await existing;
    if (runtime.snapshot().running) return runtime;
    runtimes.delete(key);
  }
  if (runtimes.size >= 36) throw new Error('Too many Codex App Server sessions');
  const pending = (async () => {
    const runtime = new CodexGuiRuntime(workspace, tab);
    try {
      await runtime.start();
      return runtime;
    } catch (error) {
      runtime.terminate();
      throw error;
    }
  })();
  runtimes.set(key, pending);
  try { return await pending; } catch (error) {
    if (runtimes.get(key) === pending) runtimes.delete(key);
    throw error;
  }
};
