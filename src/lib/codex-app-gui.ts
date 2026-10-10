import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import readline from 'readline';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { createHash, randomUUID } from 'crypto';
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
  serviceTiers: { id: string; name: string; description: string }[];
};
export type CodexGuiApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel' |
  { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } } |
  { applyNetworkPolicyAmendment: { network_policy_amendment: { host: string; action: 'allow' | 'deny' } } };
export type CodexGuiApproval = {
  requestId: string | number; method: string; command: string; reason: string;
  threadId?: string; turnId?: string;
  availableDecisions?: CodexGuiApprovalDecision[];
  proposedExecpolicyAmendment?: string[];
  proposedNetworkPolicyAmendments?: { host: string; action: 'allow' | 'deny' }[];
};
export type CodexGuiSessionSummary = {
  id: string;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  model: string | null;
  source: string;
  status: string;
};
export type CodexGuiSessionPage = {
  sessions: CodexGuiSessionSummary[];
  nextCursor: string | null;
  currentThreadId: string | null;
  workspaceCwd: string;
};
const isFastTier = (id: string): boolean => id === 'fast' || id === 'priority';
const THREAD_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export type CodexGuiSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';
// thread/start and thread/resume use kebab-case SandboxMode.
// Only sandboxPolicy.type (thread/settings/update) uses camelCase SandboxPolicy.
type CodexAppSandboxPolicyType = 'readOnly' | 'workspaceWrite' | 'dangerFullAccess';
const CODEX_APP_SANDBOX_POLICY_TYPES: Record<CodexGuiSandbox, CodexAppSandboxPolicyType> = {
  'read-only': 'readOnly',
  'workspace-write': 'workspaceWrite',
  'danger-full-access': 'dangerFullAccess',
};
const toCodexAppSandboxPolicyType = (mode: CodexGuiSandbox): CodexAppSandboxPolicyType =>
  CODEX_APP_SANDBOX_POLICY_TYPES[mode];
export type CodexGuiApprovalPolicy = 'on-request' | 'never';
export type CodexGuiState = {
  ready: boolean;
  running: boolean;
  busy: boolean;
  threadId: string | null;
  cwd: string | null;
  turnId: string | null;
  lastTurnId: string | null;
  lastTurnStatus: string | null;
  model: string | null;
  effort: string | null;
  sandboxMode: CodexGuiSandbox;
  approvalPolicy: CodexGuiApprovalPolicy;
  fastMode: boolean;
  taskPermissionsActive?: boolean;
  taskSessionId?: string;
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

const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry);
const decisionsEqual = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

export class CodexGuiRuntime {
  // Serialize asynchronous actions, including the entire MCP setup/send transaction.
  private actions: Promise<unknown> = Promise.resolve();
  private taskTurnId: string | null = null;
  private earlyTaskCompletions = new Map<string, Json>();
  private executionTargetFingerprint = createHash('sha256').update('local').digest('hex');
  private sessionLease: {
    sessionId: string; expiresAt: string; threadId: string | null;
    validate: () => Promise<void>; onLost: () => void; timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private temporaryPermissions: { sandboxMode: CodexGuiSandbox; approvalPolicy: CodexGuiApprovalPolicy } | null = null;
  // thread/settings/update acknowledges with {}, while effective values arrive
  // asynchronously in thread/settings/updated (and in thread/start).
  private effectiveThreadSettings: { threadId: string; sandboxPolicyType: string; approvalPolicy: string } | null = null;
  private settingsConfirmation: {
    threadId: string; sandboxPolicyType: string; approvalPolicy: string; resolve: () => void;
  } | null = null;

  private noteEffectiveThreadSettings(threadId: string, sandboxPolicyType: string, approvalPolicy: string): void {
    if (!threadId || !sandboxPolicyType || !approvalPolicy) return;
    this.effectiveThreadSettings = { threadId, sandboxPolicyType, approvalPolicy };
    const pending = this.settingsConfirmation;
    if (pending && pending.threadId === threadId && pending.sandboxPolicyType === sandboxPolicyType &&
        pending.approvalPolicy === approvalPolicy) pending.resolve();
  }

  private async updateSessionThreadSettings(sandboxMode: CodexGuiSandbox, approvalPolicy: CodexGuiApprovalPolicy): Promise<void> {
    const threadId = this.state.threadId;
    if (!threadId || this.settingsConfirmation) throw new Error('Thread settings confirmation unavailable');
    const sandboxPolicyType = toCodexAppSandboxPolicyType(sandboxMode);
    const confirmed = () => this.effectiveThreadSettings?.threadId === threadId &&
      this.effectiveThreadSettings.sandboxPolicyType === sandboxPolicyType &&
      this.effectiveThreadSettings.approvalPolicy === approvalPolicy;
    let signal!: () => void;
    const notification = new Promise<void>((resolve) => { signal = resolve; });
    const waiter = { threadId, sandboxPolicyType, approvalPolicy, resolve: signal };
    this.settingsConfirmation = waiter;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      // The RPC acknowledgement itself does NOT contain the new settings.
      await this.request('thread/settings/update', {
        threadId, sandboxPolicy: { type: sandboxPolicyType }, approvalPolicy,
      }, 30000);
      // A no-op update produces no notification; accept only a previously
      // server-confirmed effective state (thread/start or a prior notification).
      if (!confirmed()) {
        await Promise.race([notification, new Promise<void>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Thread settings notification not confirmed')), 10000);
        })]);
      }
      if (!confirmed() || !this.state.running || this.closed) throw new Error('Thread settings were not confirmed by Codex');
    } finally {
      if (timeout) clearTimeout(timeout);
      if (this.settingsConfirmation === waiter) this.settingsConfirmation = null;
    }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.actions.catch(() => {}).then(operation);
    this.actions = next;
    return next;
  }
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, PendingCall>();
  private listeners = new Set<(state: CodexGuiState) => void>();
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private closed = false;
  private lastTurnDiff: { turnId: string; diff: string } | null = null;
  private state: CodexGuiState = {
    ready: false, running: false, busy: false, threadId: null, cwd: null, turnId: null,
    lastTurnId: null, lastTurnStatus: null,
    model: null, effort: null, sandboxMode: 'workspace-write', approvalPolicy: 'on-request',
    fastMode: false, models: [], items: [], approvals: [], error: null,
  };

  private readonly executionHostId: string;

  constructor(
    private readonly workspace: IWorkspace,
    private readonly tab: ITab,
  ) { this.executionHostId = workspace.hostId || 'local'; }

  snapshot(): CodexGuiState {
    return {
      ...this.state,
      models: [...this.state.models],
      items: this.state.items.map((item) => ({ ...item })),
      approvals: structuredClone(this.state.approvals),
      taskPermissionsActive: this.temporaryPermissions !== null,
      ...(this.sessionLease ? { taskSessionId: this.sessionLease.sessionId } : {}),
    };
  }

  getTurnDiff(turnId: string): string | null {
    return this.lastTurnDiff?.turnId === turnId ? this.lastTurnDiff.diff : null;
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
      if (stored.sandboxMode === 'read-only' || stored.sandboxMode === 'workspace-write' ||
          stored.sandboxMode === 'danger-full-access') {
        this.state.sandboxMode = stored.sandboxMode;
      }
      if (stored.approvalPolicy === 'on-request' || stored.approvalPolicy === 'never') {
        this.state.approvalPolicy = stored.approvalPolicy;
      }
      this.state.fastMode = stored.fastMode === true;
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
      sandboxMode: this.temporaryPermissions?.sandboxMode ?? this.state.sandboxMode,
      approvalPolicy: this.temporaryPermissions?.approvalPolicy ?? this.state.approvalPolicy,
      fastMode: this.state.fastMode,
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
    // A single App Server can have several loaded Codex threads. Only render
    // events from the thread currently attached to this Purplemux tab.
    if (typeof params.threadId === 'string' && params.threadId !== this.state.threadId) return;
    if (method === 'thread/settings/updated') {
      const settings = asRecord(params.threadSettings);
      this.noteEffectiveThreadSettings(asString(params.threadId),
        asString(asRecord(settings.sandboxPolicy).type), asString(settings.approvalPolicy));
      this.publish();
      return;
    }
    const item = asRecord(params.item);
    const itemId = asString(params.itemId) || asString(item.id);
    const type = asString(item.type);
    if (method === 'turn/started') {
      const turn = asRecord(params.turn);
      this.state.turnId = asString(turn.id) || null;
      if (this.temporaryPermissions && this.state.busy) this.taskTurnId = this.state.turnId;
      this.state.busy = true;
      this.lastTurnDiff = null;
    } else if (method === 'turn/completed') {
      const turn = asRecord(params.turn);
      const completedId = asString(turn.id) || this.state.turnId;
      if (this.temporaryPermissions && !this.taskTurnId) {
        // turn/start can answer after completion. Match its returned ID before
        // restoring permissions; a delayed completion from an older turn cannot release the lease.
        if (completedId && this.earlyTaskCompletions.size < 10) this.earlyTaskCompletions.set(completedId, params);
        return;
      }
      if (this.state.turnId && completedId !== this.state.turnId) return;
      if (this.temporaryPermissions && completedId !== this.taskTurnId) return;
      this.state.lastTurnId = completedId;
      this.state.lastTurnStatus = asString(turn.status) || 'unknown';
      this.state.busy = false;
      this.state.turnId = null;
      if (asString(turn.status) === 'failed') {
        this.state.error = asString(asRecord(turn.error).message) || 'Codex turn failed';
      }
      this.state.approvals = [];
      if (this.sessionLease) {
        if (this.state.lastTurnStatus !== 'completed') this.terminate();
      } else if (this.temporaryPermissions) {
        void this.serialize(() => this.restoreTaskPermissions()).catch(() => {});
      }
    } else if (method === 'turn/diff/updated') {
      const diff = asString(params.diff);
      const turnId = asString(params.turnId) || this.state.turnId;
      if (turnId) this.lastTurnDiff = { turnId, diff: diff.slice(0, 128000) };
    } else if (method === 'item/started' && itemId) {
      if (type === 'commandExecution') {
        this.upsert(itemId, 'command', {
          title: asString(item.command), status: 'running',
        });
      } else if (type === 'fileChange') {
        const paths = (Array.isArray(item.changes) ? item.changes : [])
          .map((entry) => asString(asRecord(entry).path)).filter(Boolean).slice(0, 20);
        this.upsert(itemId, 'file-change', {
          title: paths.join(', ') || 'ファイル変更', status: 'running',
        });
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
        const paths = (Array.isArray(item.changes) ? item.changes : [])
          .map((entry) => asString(asRecord(entry).path)).filter(Boolean).slice(0, 20);
        this.upsert(itemId, 'file-change', {
          ...(paths.length ? { title: paths.join(', ') } : {}),
          status: asString(item.status) || 'completed',
        });
      }
    } else if (method === 'item/fileChange/patchUpdated' && itemId) {
      const paths = (Array.isArray(params.changes) ? params.changes : [])
        .map((entry) => asString(asRecord(entry).path)).filter(Boolean).slice(0, 20);
      if (paths.length) this.upsert(itemId, 'file-change', { title: paths.join(', ') });
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
      if (method === 'item/permissions/requestApproval') {
        // The protocol grants a subset via { permissions, scope }, not a decision.
        // Until a subset editor is supported, explicitly grant nothing; never hang.
        this.sendMessage({ id, result: { permissions: {}, scope: 'turn' } });
        this.state.error = '追加権限要求は未対応のため拒否しました（権限は付与していません）';
        this.publish();
      } else if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        const wrongScope = (params.threadId !== undefined && params.threadId !== this.state.threadId) ||
          (params.turnId !== undefined && params.turnId !== this.state.turnId);
        if (wrongScope || this.state.approvalPolicy === 'never') {
          this.sendMessage({ id, result: { decision: 'decline' } });
          return;
        }
        const commandApproval = method === 'item/commandExecution/requestApproval';
        const proposed = params.proposedExecpolicyAmendment;
        const exec = commandApproval && Array.isArray(proposed) && proposed.length > 0 &&
          proposed.every((part) => typeof part === 'string' && part.length > 0)
          ? proposed as string[] : undefined;
        const network = commandApproval && Array.isArray(params.proposedNetworkPolicyAmendments)
          ? params.proposedNetworkPolicyAmendments.filter((raw): raw is { host: string; action: 'allow' | 'deny' } => {
            const rule = asRecord(raw);
            return Object.keys(rule).length === 2 && typeof rule.host === 'string' && rule.host.length > 0 &&
              (rule.action === 'allow' || rule.action === 'deny');
          }) : [];
        const candidates: CodexGuiApprovalDecision[] = ['accept', 'acceptForSession', 'decline', 'cancel'];
        if (exec) candidates.push({ acceptWithExecpolicyAmendment: { execpolicy_amendment: exec } });
        for (const rule of network) candidates.push({ applyNetworkPolicyAmendment: { network_policy_amendment: rule } });
        // An explicit list is authoritative. Unknown/malformed candidates grant nothing.
        const offered = params.availableDecisions;
        const available = offered === undefined || offered === null ? candidates
          : Array.isArray(offered) ? candidates.filter((candidate) =>
            offered.some((value) => decisionsEqual(value, candidate))) : [];
        if (!available.length) {
          this.sendMessage({ id, result: { decision: 'decline' } });
          this.state.error = '対応可能な承認候補がないため拒否しました';
        } else {
          const context = asRecord(params.networkApprovalContext);
          this.state.approvals.push({
            requestId: id, method,
            threadId: asString(params.threadId), turnId: asString(params.turnId),
            command: asString(context.host) ? 'Network: ' + asString(context.protocol) + ' ' + asString(context.host)
              : asString(params.command) || asString(params.reason) || 'ファイル変更',
            reason: asString(params.reason), availableDecisions: available,
            proposedExecpolicyAmendment: exec, proposedNetworkPolicyAmendments: network,
          });
        }
        this.publish();
      } else {
        // Unsupported RPCs must receive an error so the server can fail closed.
        this.sendMessage({ id, error: { code: -32601, message: 'Unsupported Codex request: ' + method } });
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
      const { connectionFingerprint } = await import('@/lib/task-session-store');
      this.executionTargetFingerprint = connectionFingerprint(host);
      command = 'ssh';
      // Interactive shell loads fnm/npm PATH; -T preserves clean JSON stdout.
      args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
        '-p', String(host.port), host.username + '@' + host.address,
        'bash -lic ' + shellQuote('exec codex app-server')];
    }
    // Never forward Purplemux's internal MCP or browser-auth credentials to
    // Codex (or SSH). Codex can execute workspace commands, and those child
    // processes inherit the App Server environment.
    const childEnv: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
    for (const key of [
      '__PMUX_MCP_INTERNAL_TOKEN', '__PMUX_MCP_INTERNAL_PORT',
      '__NEXT_PRIVATE_STANDALONE_CONFIG',
      'NEXTAUTH_SECRET', 'AUTH_PASSWORD', 'CONTROL_PLANE_API_KEY', 'OPENAI_ADMIN_KEY',
    ]) delete childEnv[key];
    const child = spawn(command, args, {
      cwd: this.workspace.hostId ? process.cwd() : cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
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
      // thread/settings/update is experimental and required for fail-closed sandbox switching.
      capabilities: { experimentalApi: true },
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
          serviceTiers: [
            ...(Array.isArray(value.serviceTiers) ? value.serviceTiers : [])
              .map((tier) => ({
                id: asString(asRecord(tier).id),
                name: asString(asRecord(tier).name),
                description: asString(asRecord(tier).description),
              })),
            // Older model catalogs advertise "priority" instead of "fast".
            // The deprecated additionalSpeedTiers field is a fallback only.
            ...(
              !(Array.isArray(value.serviceTiers) &&
                value.serviceTiers.some((tier) => isFastTier(asString(asRecord(tier).id)))) &&
              Array.isArray(value.additionalSpeedTiers)
                ? value.additionalSpeedTiers
                    .filter((tier) => typeof tier === 'string' && isFastTier(tier))
                    .map((tier) => ({ id: tier as string, name: 'Fast', description: '' }))
                : []
            ),
          ],
        };
      }).filter((model) => model.model);
      if (this.state.model && !this.state.models.some((item) => item.model === this.state.model)) {
        this.state.model = null;
        this.state.effort = null;
        this.state.fastMode = false;
        await this.store();
      }
      // Missing catalog metadata does not establish that Fast is unsupported.
      // Preserve an explicit opt-in; the App Server remains authoritative when
      // the next turn is started. "priority" is the canonical request tier.
    } catch (error) {
      this.state.error = 'モデル一覧を取得できません: ' + (error instanceof Error ? error.message : String(error));
    }
    this.state.cwd = this.getWorkspaceCwd();
    if (this.state.threadId) {
      try {
        const result = await this.request('thread/resume', {
          threadId: this.state.threadId,
          approvalPolicy: this.state.approvalPolicy,
          sandbox: this.state.sandboxMode,
        }, 40000);
        this.state.cwd = asString(result.cwd) || asString(asRecord(result.thread).cwd) || this.state.cwd;
        this.noteEffectiveThreadSettings(this.state.threadId!,
          asString(asRecord(result.sandbox).type), asString(result.approvalPolicy));
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


  getWorkspaceCwd(): string {
    return this.workspace.hostId
      ? this.workspace.remoteDirectory || ''
      : this.tab.cwd || this.workspace.directories[0] || '';
  }

  async listThreads(options: {
    cursor?: string;
    search?: string;
    scope?: 'workspace' | 'host';
  }): Promise<CodexGuiSessionPage> {
    if (!this.state.ready || this.closed) throw new Error('Codex App Server is unavailable');
    let cursor = options.cursor || '';
    if (cursor.length > 3000) throw new Error('Invalid history cursor');
    const search = (options.search || '').trim().toLocaleLowerCase();
    if (search.length > 160) throw new Error('Search text is too long');
    const workspaceCwd = this.getWorkspaceCwd();
    const sessions: CodexGuiSessionSummary[] = [];
    // Search preview, cwd, model and ID using the same filter, independently
    // of whether the installed Codex version supports thread/list.searchTerm.
    // Bound each response so older histories cannot block the UI indefinitely.
    const maxPages = search ? 4 : 1;
    for (let page = 0; page < maxPages; page++) {
      const params: Json = {
        limit: search ? 75 : 50,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        ...(cursor ? { cursor } : {}),
        ...(options.scope === 'workspace' && workspaceCwd ? { cwd: workspaceCwd } : {}),
      };
      const result = await this.request('thread/list', params, 45000);
      for (const raw of (Array.isArray(result.data) ? result.data : [])) {
        const thread = asRecord(raw);
        const id = asString(thread.id);
        if (!THREAD_ID_RE.test(id) || thread.ephemeral === true || thread.parentThreadId) continue;
        const source = thread.source;
        const sourceKind = typeof source === 'string' ? source : asString(asRecord(source).type);
        const status = thread.status;
        const item: CodexGuiSessionSummary = {
          id,
          preview: asString(thread.preview).slice(0, 2400),
          cwd: asString(thread.cwd),
          createdAt: typeof thread.createdAt === 'number' ? thread.createdAt : 0,
          updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt : 0,
          model: asString(thread.model) || null,
          source: sourceKind || 'cli',
          status: typeof status === 'string' ? status : asString(asRecord(status).type),
        };
        if (search && ![item.preview, item.cwd, item.id, item.model || ''].join(' ').toLocaleLowerCase().includes(search)) continue;
        sessions.push(item);
      }
      const next = asString(result.nextCursor);
      if (!next || next === cursor) {
        cursor = '';
        break;
      }
      cursor = next;
    }
    return { sessions, nextCursor: cursor || null, currentThreadId: this.state.threadId, workspaceCwd };
  }

  async resumeThread(threadId: string): Promise<CodexGuiState> {
    return this.serialize(async () => {
      if (this.temporaryPermissions) throw new Error('MCP task permissions are active');
      return this.resumeThreadInternal(threadId);
    });
  }

  private async resumeThreadInternal(threadId: string): Promise<CodexGuiState> {
    if (!this.state.ready || this.closed) throw new Error('Codex App Server is unavailable');
    if (!THREAD_ID_RE.test(threadId)) throw new Error('Invalid Codex session ID');
    if (this.state.busy || this.state.approvals.length > 0) {
      throw new Error('実行中または承認待ちのため、会話を切り替えられません');
    }
    if (threadId === this.state.threadId) return this.snapshot();

    // The existing tab's previous thread is retained in Codex history.
    // Only replace its pointer after resume and transcript loading succeed.
    this.state.busy = true;
    this.state.error = null;
    this.publish();
    try {
      const result = await this.request('thread/resume', {
        threadId,
        approvalPolicy: this.state.approvalPolicy,
        sandbox: this.state.sandboxMode,
      }, 45000);
      const summary = asRecord(result.thread);
      let history = summary;
      try {
        const read = await this.request('thread/read', { threadId, includeTurns: true }, 45000);
        history = asRecord(read.thread);
      } catch {
        // Older servers can include the transcript in thread/resume directly.
      }
      const previousThreadId = this.state.threadId;
      const previousItems = this.state.items;
      const previousModel = this.state.model;
      const previousEffort = this.state.effort;
      const previousFastMode = this.state.fastMode;
      const previousCwd = this.state.cwd;
      try {
        this.state.threadId = threadId;
        this.state.items = [];
        this.state.turnId = null;
        this.state.lastTurnId = null;
        this.state.lastTurnStatus = null;
        this.lastTurnDiff = null;
        this.state.approvals = [];
        this.state.cwd = asString(result.cwd) || asString(history.cwd) || this.getWorkspaceCwd();
        const resumedModel = asString(result.model) || asString(history.model);
        if (resumedModel && this.state.models.some((model) => model.model === resumedModel)) {
          this.state.model = resumedModel;
          this.state.effort = asString(result.reasoningEffort) ||
            asString(history.reasoningEffort) || null;
        }
        // A thread may have been created on an older CLI where model/list
        // did not advertise service tiers. Keep the user's explicit setting.
        this.restore(history);
        await this.store();
      } catch (error) {
        this.state.threadId = previousThreadId;
        this.state.items = previousItems;
        this.state.model = previousModel;
        this.state.effort = previousEffort;
        this.state.fastMode = previousFastMode;
        this.state.cwd = previousCwd;
        throw error;
      }
      this.state.error = null;
      return this.snapshot();
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : '履歴を再開できませんでした';
      throw error;
    } finally {
      this.state.busy = false;
      this.publish();
    }
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
    this.effectiveThreadSettings = null;
    if (this.sessionLease) {
      const lease = this.sessionLease;
      clearTimeout(lease.timer); this.sessionLease = null;
      lease.onLost();
    }
    if (this.temporaryPermissions) {
      Object.assign(this.state, this.temporaryPermissions);
      this.temporaryPermissions = null;
      this.taskTurnId = null;
      this.earlyTaskCompletions.clear();
    }
    this.state.approvals = [];
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.pending.clear();
    this.publish();
  }

  /** MCP permissions are ephemeral and exclusively own this tab until restoration. */
  async runTask(options: {
    text: string; mode: 'new' | 'continue'; sandboxMode: 'read-only' | 'workspace-write'; directory: string; hostId: string;
  }): Promise<CodexGuiState> {
    return this.serialize(async () => {
      if (this.closed || !this.state.ready || this.state.busy || this.temporaryPermissions || this.state.approvals.length) {
        throw new Error('Codex is already working or unavailable');
      }
      if (options.hostId !== this.executionHostId) throw new Error('Codex runtime host differs from the confirmed target');
      if (!['read-only', 'workspace-write'].includes(options.sandboxMode)) throw new Error('Invalid task sandbox');
      const normalize = (cwd: string) => cwd.replace(/\/+$/, '') || '/';
      if (normalize(this.getWorkspaceCwd()) !== options.directory ||
          (options.mode === 'continue' && this.state.threadId && normalize(this.state.cwd || '') !== options.directory)) {
        throw new Error('Codex thread working directory differs from the confirmed target');
      }
      this.taskTurnId = null;
      this.earlyTaskCompletions.clear();
      this.temporaryPermissions = {
        sandboxMode: this.state.sandboxMode, approvalPolicy: this.state.approvalPolicy,
      };
      try {
        // New tasks must not change the old thread's permissions.
        if (options.mode === 'new') await this.actionInternal('new-thread', {});
        if (this.state.threadId) {
          // Acknowledgement is mandatory even when the local values already match.
          await this.request('thread/settings/update', {
            threadId: this.state.threadId,
            sandboxPolicy: { type: toCodexAppSandboxPolicyType(options.sandboxMode) },
            approvalPolicy: 'on-request',
          }, 30000);
        }
        this.state.sandboxMode = options.sandboxMode;
        this.state.approvalPolicy = 'on-request';
        return await this.actionInternal('send', { text: options.text });
      } catch (error) {
        // A timed-out turn/start may still be running remotely. Disconnect rather
        // than restoring broader GUI permissions to an unobserved active task.
        if (this.state.error) this.terminate();
        else await this.restoreTaskPermissions();
        throw error;
      }
    });
  }

  /** Only the durable, GUI-approved Task Session coordinator calls this entry point. */
  async runTaskSessionTurn(options: {
    targetFingerprint: string; sessionId: string; expiresAt: string; text: string; directory: string; hostId: string;
    workspaceId: string; tabId: string; pinnedThreadId?: string;
    validate: () => Promise<void>; onLost: () => void;
  }): Promise<CodexGuiState> {
    return this.serialize(async () => {
      if (process.env.PURPLEMUX_MCP_ALLOW_WRITES !== '1' || process.env.PURPLEMUX_MCP_ALLOW_FULL_ACCESS !== '1') throw new Error('Full Access execution disabled');
      await options.validate();
      if (options.targetFingerprint !== this.executionTargetFingerprint) throw new Error('Runtime target connection changed; new App Server required');
      if (this.closed || !this.state.ready || this.state.busy || this.state.approvals.length ||
          options.workspaceId !== this.workspace.id || options.tabId !== this.tab.id ||
          options.hostId !== this.executionHostId || this.getWorkspaceCwd() !== options.directory ||
          Date.parse(options.expiresAt) <= Date.now()) throw new Error('Session target expired, changed or unavailable');
      if (this.sessionLease && (this.sessionLease.sessionId !== options.sessionId || this.state.threadId !== this.sessionLease.threadId ||
          this.state.threadId !== options.pinnedThreadId || this.state.cwd !== options.directory)) throw new Error('Session lease or pinned thread mismatch');
      if (!this.sessionLease && (this.temporaryPermissions || options.pinnedThreadId)) throw new Error('Session lease lost; GUI reapproval required');
      try {
        if (!this.sessionLease) {
          this.temporaryPermissions = { sandboxMode: this.state.sandboxMode, approvalPolicy: this.state.approvalPolicy };
          const timer = setTimeout(() => this.expireTaskSession(), Math.max(1, Date.parse(options.expiresAt) - Date.now()));
          timer.unref();
          this.sessionLease = { sessionId: options.sessionId, expiresAt: options.expiresAt, threadId: null,
            validate: options.validate, onLost: options.onLost, timer };
          // A new session gets a dedicated thread; never alter an earlier GUI thread.
          await this.actionInternal('new-thread', {});
        } else {
          this.sessionLease.validate = options.validate;
          this.sessionLease.onLost = options.onLost;
        }
        this.taskTurnId = null; this.earlyTaskCompletions.clear();
        this.state.sandboxMode = 'danger-full-access'; this.state.approvalPolicy = 'never';
        return await this.actionInternal('send', { text: options.text });
      } catch (error) {
        // Includes uncertain RPC timeout: no subsequent turn may reuse this grant.
        this.terminate();
        throw error;
      }
    });
  }

  private expireTaskSession(): void {
    const lease = this.sessionLease;
    if (!lease) return;
    if (this.state.busy && this.state.threadId && this.state.turnId) {
      // Interrupt on the wire before disconnecting; bounded even if Codex hangs.
      void this.request('turn/interrupt', { threadId: this.state.threadId, turnId: this.state.turnId }, 5000)
        .catch(() => {}).finally(() => this.terminate());
    } else if (this.state.busy || this.pending.size) {
      this.terminate();
    } else {
      void this.finishTaskSession(lease.sessionId).then(() => lease.onLost()).catch(() => this.terminate());
    }
  }

  async finishTaskSession(sessionId: string): Promise<void> {
    // Break an in-flight setup immediately; it must never start after revocation.
    if (this.sessionLease?.sessionId === sessionId && this.state.busy && (!this.state.turnId || this.pending.size > 0)) {
      try {
        if (this.state.threadId && this.state.turnId) {
          await this.request('turn/interrupt', { threadId: this.state.threadId, turnId: this.state.turnId }, 5000);
        }
      } catch { /* An uncertain setup cannot retain Full Access. */ }
      finally { this.terminate(); }
    }
    return this.serialize(async () => {
      const lease = this.sessionLease;
      if (!lease) return;
      if (lease.sessionId !== sessionId) throw new Error('Refusing to release another session lease');
      try {
        if (this.state.busy) {
          await this.actionInternal('interrupt', {});
          // Interrupt acknowledgement need not mean completion. Disconnect any
          // still-active process rather than changing its permissions mid-turn.
          if (this.state.busy) { this.terminate(); return; }
        }
        await this.restoreTaskPermissions();
        clearTimeout(lease.timer); this.sessionLease = null;
      } catch (error) { this.terminate(); throw error; }
    });
  }

  private async restoreTaskPermissions(): Promise<void> {
    const saved = this.temporaryPermissions;
    if (!saved) return;
    try {
      // Always send a restoration even if local rollback made values equal.
      if (this.state.threadId && !this.closed) {
        if (this.sessionLease) {
          await this.updateSessionThreadSettings(saved.sandboxMode, saved.approvalPolicy);
        } else {
          await this.request('thread/settings/update', {
            threadId: this.state.threadId,
            sandboxPolicy: { type: toCodexAppSandboxPolicyType(saved.sandboxMode) },
            approvalPolicy: saved.approvalPolicy,
          }, 30000);
        }
      }
      Object.assign(this.state, saved);
      this.temporaryPermissions = null;
      this.taskTurnId = null;
      this.earlyTaskCompletions.clear();
      this.publish();
    } catch (error) {
      this.terminate();
      this.state.error = 'MCP task permission restoration failed; disconnected: ' + String(error);
      this.publish();
      throw error;
    }
  }

  action(...args: Parameters<CodexGuiRuntime['actionInternal']>): Promise<CodexGuiState> {
    return this.serialize(async () => {
      if (this.temporaryPermissions && args[0] !== 'approve' && args[0] !== 'interrupt') {
        throw new Error('MCP task permissions are active');
      }
      return this.actionInternal(...args);
    });
  }

  private async actionInternal(
    action: 'new-thread' | 'send' | 'interrupt' | 'approve' | 'settings' | 'resume-thread',
    args: { text?: string; model?: string; effort?: string; requestId?: string | number; decision?: unknown; threadId?: string;
      sandboxMode?: CodexGuiSandbox; approvalPolicy?: CodexGuiApprovalPolicy; fastMode?: boolean },
  ): Promise<CodexGuiState> {
    if (this.closed || !this.state.ready) throw new Error('Codex App Server is unavailable');
    if (action === 'resume-thread') return this.resumeThreadInternal(args.threadId || '');
    if (action === 'approve') {
      const match = this.state.approvals.find((entry) => String(entry.requestId) === String(args.requestId));
      if (!match || !match.availableDecisions?.some((candidate) => decisionsEqual(candidate, args.decision)) ||
          (match.threadId && match.threadId !== this.state.threadId) ||
          (match.turnId && match.turnId !== this.state.turnId)) {
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
    if (this.state.busy) throw new Error('実行中は設定を変更できません');
    const previous = {
      model: this.state.model, effort: this.state.effort, fastMode: this.state.fastMode,
      sandboxMode: this.state.sandboxMode, approvalPolicy: this.state.approvalPolicy,
    };
    if (args.model !== undefined) {
      if (!this.state.models.some((m) => m.model === args.model)) throw new Error('Model is not available on this host');
      const modelChanged = this.state.model !== args.model;
      this.state.model = args.model;
      if (args.effort === undefined) this.state.effort = null;
      if (modelChanged && args.fastMode === undefined) this.state.fastMode = false;
    }
    if (args.effort !== undefined) {
      const active = this.state.models.find((m) => m.model === (this.state.model || this.state.models.find((m) => m.isDefault)?.model));
      if (active && !active.supportedReasoningEfforts.some((e) => e.reasoningEffort === args.effort)) {
        throw new Error('Reasoning effort is not available for this model');
      }
      this.state.effort = args.effort;
    }
    if (args.sandboxMode !== undefined) {
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(args.sandboxMode)) {
        throw new Error('Invalid Sandbox setting');
      }
      this.state.sandboxMode = args.sandboxMode;
    }
    if (args.approvalPolicy !== undefined) {
      if (!['on-request', 'never'].includes(args.approvalPolicy)) throw new Error('Invalid approval policy');
      this.state.approvalPolicy = args.approvalPolicy;
    }
    const activeModel = this.state.models.find((m) =>
      m.model === (this.state.model || this.state.models.find((x) => x.isDefault)?.model));
    // Some Codex App Server model catalogs omit speed-tier metadata entirely.
    // Allow an explicit Fast request (never automatic); Codex validates whether
    // the selected model/account actually supports the priority tier.
    const requestedFastTier = activeModel?.serviceTiers.find((tier) => isFastTier(tier.id))?.id ?? 'priority';
    if (args.fastMode !== undefined) this.state.fastMode = args.fastMode;

    try {
      if (this.state.threadId &&
          (previous.sandboxMode !== this.state.sandboxMode || previous.approvalPolicy !== this.state.approvalPolicy)) {
        await this.request('thread/settings/update', {
          threadId: this.state.threadId,
          sandboxPolicy: { type: toCodexAppSandboxPolicyType(this.state.sandboxMode) },
          approvalPolicy: this.state.approvalPolicy,
        }, 30000);
      }
      await this.store();
    } catch (error) {
      Object.assign(this.state, previous);
      this.publish();
      throw error;
    }
    if (action === 'settings') { this.publish(); return this.snapshot(); }
    if (action === 'new-thread') {
      if (this.state.busy) throw new Error('Codex is working. Stop the current turn first.');
      this.state.threadId = null;
      this.effectiveThreadSettings = null;
      this.state.cwd = this.getWorkspaceCwd();
      this.state.lastTurnId = null;
      this.state.lastTurnStatus = null;
      this.lastTurnDiff = null;
      this.state.fastMode = false;
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
          const cwd = this.getWorkspaceCwd();
          if (!cwd.startsWith('/')) throw new Error('Codex workspace directory must be absolute');
          const result = await this.request('thread/start', {
            cwd, approvalPolicy: this.state.approvalPolicy, sandbox: this.state.sandboxMode,
            serviceTier: this.state.fastMode ? requestedFastTier : 'default',
            ...(this.state.model ? { model: this.state.model } : {}),
          }, 45000);
          const id = asString(asRecord(result.thread).id);
          if (!id) throw new Error('Codex did not return a thread ID');
          this.state.threadId = id;
          this.state.cwd = asString(result.cwd) || asString(asRecord(result.thread).cwd) || cwd;
          if (this.sessionLease) {
            // thread/start is authoritative for the first turn; it also covers
            // a no-op settings/update that emits no follow-up notification.
            const sandboxPolicyType = asString(asRecord(result.sandbox).type);
            const approvalPolicy = asString(result.approvalPolicy);
            if (sandboxPolicyType !== 'dangerFullAccess' || approvalPolicy !== 'never') {
              throw new Error('Full Access thread/start settings not confirmed by Codex');
            }
            this.noteEffectiveThreadSettings(id, sandboxPolicyType, approvalPolicy);
          }
          if (this.temporaryPermissions && this.state.cwd.replace(/\/+$/, '') !== cwd.replace(/\/+$/, '')) {
            throw new Error('Codex working directory changed before task submission');
          }
          await this.store();
        }
        if (this.sessionLease) {
          await this.sessionLease.validate();
          if (Date.parse(this.sessionLease.expiresAt) <= Date.now() || this.state.cwd !== this.getWorkspaceCwd()) throw new Error('Session expired or cwd changed');
          if (this.sessionLease.threadId && this.sessionLease.threadId !== this.state.threadId) throw new Error('Pinned session thread changed');
          // The effective settings are confirmed via thread/start or
          // thread/settings/updated; the immediate RPC reply is always {}.
          await this.updateSessionThreadSettings('danger-full-access', 'never');
          await this.sessionLease.validate();
          if (Date.parse(this.sessionLease.expiresAt) <= Date.now()) throw new Error('Session expired');
          this.sessionLease.threadId = this.state.threadId;
        }
        this.state.items.push({ id: 'user-' + Date.now(), type: 'user', text });
        if (this.state.items.length > MAX_ITEMS) this.state.items.shift();
        this.publish();
        const response = await this.request('turn/start', {
          threadId: this.state.threadId,
          input: [{ type: 'text', text, text_elements: [] }],
          ...(this.state.model ? { model: this.state.model } : {}),
          ...(this.state.effort ? { effort: this.state.effort } : {}),
          serviceTierForTurn: this.state.fastMode ? requestedFastTier : 'default',
        }, 45000);
        if (this.temporaryPermissions) {
          this.taskTurnId = asString(asRecord(response.turn).id) || this.taskTurnId;
          if (!this.taskTurnId) throw new Error('Codex did not return a task turn ID');
          const completed = this.earlyTaskCompletions.get(this.taskTurnId);
          this.earlyTaskCompletions.clear();
          if (completed) this.handleNotification('turn/completed', completed);
        }
        // A very short turn can complete before turn/start responds.
        // Do not resurrect its active turn ID after turn/completed.
        if (this.state.busy) this.state.turnId = asString(asRecord(response.turn).id) || this.state.turnId;
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
  const { taskSessions } = await import('@/lib/task-session-store');
  return taskSessions.withTabAccess(workspace.id, tab.id, true, () => loadCodexGuiRuntime(workspace, tab));
};

const loadCodexGuiRuntime = async (workspace: IWorkspace, tab: ITab): Promise<CodexGuiRuntime> => {
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

/**
 * Observe an already-running App Server without starting Codex, attaching a
 * new thread or modifying the workspace. Used only by the read-only MCP bridge.
 */
export const getLoadedCodexGuiRuntime = async (
  workspaceId: string,
  tabId: string,
): Promise<CodexGuiRuntime | null> => {
  const pending = runtimes.get(workspaceId + ':' + tabId);
  if (!pending) return null;
  try { return await pending; } catch { return null; }
};

export const peekCodexGuiRuntime = async (
  workspaceId: string,
  tabId: string,
): Promise<CodexGuiState | null> => {
  const runtime = await getLoadedCodexGuiRuntime(workspaceId, tabId);
  return runtime ? runtime.snapshot() : null;
};
