import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TaskSessionStore, validateTaskSessionTarget, type TaskSessionTargetValidator, TASK_SESSION_LEASE_MS, taskSessionConnection } from '@/lib/task-session-store';

let directory: string;
let store: TaskSessionStore;
let now: number;
let validate: ReturnType<typeof vi.fn<TaskSessionTargetValidator>>;
const capability = 'A'.repeat(43);
const input = (key = 'retry-1') => ({ purpose: 'Implement tests', hostId: 'local', workdir: '/tmp/workspace',
  scope: 'Only management API', expiresAt: new Date(now + 3600000).toISOString(), idempotencyKey: key });
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-task-test-'));
  now = Date.now(); validate = vi.fn(async () => {});
  store = new TaskSessionStore(directory, validate, () => now);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

describe('Task Session management store', () => {
  it.each([
    { purpose: '' }, { scope: ' ' }, { hostId: '-bad!' }, { workdir: '../foo' }, { workdir: '/tmp/../secret' },
    { workdir: '/tmp/\nsecret' }, { expiresAt: 'forever' }, { approved: true }, { confirmApproval: true },
    { sessionId: 'anything' }, { status: 'approved' }, { source: 'gui' }, { sandboxMode: 'danger-full-access' },
    { purpose: 'token=very-secret' }, { purpose: 'Bearer abcdef' }, { purpose: 'a'.repeat(2001) },
    { idempotencyKey: '__proto__\n' },
  ])('rejects invalid input without writing records: %j', async (bad) => {
    await expect(store.propose({ ...input(), ...bad }, 'mcp')).rejects.toThrow('Invalid task session input');
    expect(await store.list()).toEqual([]); expect(validate).not.toHaveBeenCalled();
  });
  it('rejects missing/too long TTL and unknown target', async () => {
    await expect(store.propose({ ...input(), expiresAt: new Date(now).toISOString() }, 'mcp')).rejects.toThrow('expiresAt');
    await expect(store.propose({ ...input(), expiresAt: new Date(now + 86400001).toISOString() }, 'mcp')).rejects.toThrow('expiresAt');
    validate.mockRejectedValueOnce(new Error('Invalid target'));
    await expect(store.propose(input(), 'mcp')).rejects.toThrow('Invalid target');
    expect(await store.list()).toEqual([]);
  });
  it('persists records and audit atomically with private permissions', async () => {
    const record = await store.propose(input(), 'mcp');
    expect(record.status).toBe('pending'); expect(record.sessionId).toBeUndefined();
    const reopened = new TaskSessionStore(directory, validate, () => now);
    expect((await reopened.detail(record.id)).audit).toMatchObject([{ event: 'pending', actor: 'mcp' }]);
    expect((await fs.stat(path.join(directory, 'records.json'))).mode & 0o777).toBe(0o600);
    const raw = await fs.readFile(path.join(directory, 'records.json'), 'utf8');
    expect(raw).not.toContain('retry-1');
  });
  it('deduplicates concurrent retries across store instances', async () => {
    const other = new TaskSessionStore(directory, validate, () => now);
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? other : store).propose(input(), 'mcp')));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await store.audit()).toHaveLength(1); expect(await store.list()).toHaveLength(1);
  });
  it('serializes writers in separate Node processes', async () => {
    const args = input();
    const code = `const { TaskSessionStore } = require('./src/lib/task-session-store');
      const store = new TaskSessionStore(${JSON.stringify(directory)}, async () => {});
      store.propose(${JSON.stringify(args)}, 'mcp').then(r => process.stdout.write(r.id)).catch(() => process.exit(1));`;
    const run = promisify(execFile);
    const results = await Promise.all(Array.from({ length: 3 }, () => run(
      process.execPath, ['--import', 'tsx', '-e', code], { cwd: process.cwd() })));
    expect(new Set(results.map((r) => r.stdout)).size).toBe(1);
    expect(await store.audit()).toHaveLength(1);
  });
  it('deduplicates simultaneous submissions with distinct keys', async () => {
    const records = await Promise.all(Array.from({ length: 8 }, (_, i) => store.propose(input('key-' + i), 'mcp')));
    expect(new Set(records.map((r) => r.id)).size).toBe(1);
    expect(await store.audit()).toHaveLength(1);
  });
  it('does not persist proposal state or audit after an atomic rename failure', async () => {
    const record = await store.propose(input(), 'mcp');
    const before = await fs.readFile(path.join(directory, 'records.json'), 'utf8');
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(store.decide(record.id, 'approved')).rejects.toThrow('disk unavailable');
    rename.mockRestore();
    expect(await fs.readFile(path.join(directory, 'records.json'), 'utf8')).toBe(before);
    expect((await store.detail(record.id)).record.status).toBe('pending');
  });
  it('rejects a proposal that expires during target validation', async () => {
    validate.mockImplementationOnce(async () => { now += 3600001; });
    await expect(store.propose(input(), 'mcp')).rejects.toThrow('expired');
    expect(await store.list()).toEqual([]);
  });
  it('paginates without allowing unbounded offsets', async () => {
    await store.propose(input(), 'mcp');
    expect(await store.list(1)).toEqual([]);
    await expect(store.list(-1)).rejects.toThrow('Invalid list offset');
    await expect(store.list(5001)).rejects.toThrow('Invalid list offset');
  });
  it('deduplicates identical active proposals with different keys, and rejects key reuse with different payload', async () => {
    const record = await store.propose(input(), 'mcp');
    expect((await store.propose(input('another-key'), 'mcp')).id).toBe(record.id);
    await expect(store.propose({ ...input(), scope: 'Different scope' }, 'mcp')).rejects.toThrow('conflicts');
    expect(await store.audit()).toHaveLength(1);
  });
  it('records approval once, supports revocation and forbids reapproval', async () => {
    const record = await store.propose(input(), 'mcp');
    const approved = await Promise.all([store.decide(record.id, 'approved'), store.decide(record.id, 'approved')]);
    expect(approved[0].sessionId).toBeTruthy(); expect(approved[0].sessionId).toBe(approved[1].sessionId);
    await store.decide(record.id, 'revoked');
    await expect(store.decide(record.id, 'approved')).rejects.toThrow('transition');
    expect((await store.detail(record.id)).audit.map((e) => e.event)).toEqual(['pending', 'approved', 'revoked']);
  });
  it('rejects stale GUI status under the transaction lock, including duplicate decisions', async () => {
    const record = await store.propose(input(), 'gui');
    await store.decide(record.id, 'approved', 'pending');
    await expect(store.decide(record.id, 'revoked', 'pending')).rejects.toMatchObject({ status: 409 });
    await expect(store.decide(record.id, 'approved', 'pending')).rejects.toMatchObject({ status: 409 });
    expect((await store.detail(record.id)).record.status).toBe('approved');
    await store.decide(record.id, 'revoked', 'approved');
    await expect(store.decide(record.id, 'revoked', 'approved')).rejects.toMatchObject({ status: 409 });
    expect((await store.detail(record.id)).audit.map((e) => e.event)).toEqual(['pending', 'approved', 'revoked']);
  });
  it('rejects stale GUI confirmation after expiry', async () => {
    const record = await store.propose(input(), 'gui');
    now += 3600000;
    await expect(store.decide(record.id, 'approved', 'pending')).rejects.toMatchObject({ status: 409 });
    expect((await store.detail(record.id)).record.status).toBe('expired');
  });
  it('accepts maximum-length Japanese fields but retains schema length limits', async () => {
    const fields = { purpose: '目'.repeat(2000), scope: '範'.repeat(2000), workdir: '/' + '道'.repeat(4095) };
    expect(await store.propose({ ...input(), ...fields }, 'gui')).toMatchObject(fields);
    for (const field of ['purpose', 'scope', 'workdir'] as const) {
      await expect(store.propose({ ...input('long-' + field), ...fields, [field]: fields[field] + '字' }, 'gui'))
        .rejects.toThrow('Invalid task session input');
    }
  });
  it('allows exactly one outcome in an approve/reject race', async () => {
    const record = await store.propose(input(), 'gui');
    const outcomes = await Promise.allSettled([store.decide(record.id, 'approved'), store.decide(record.id, 'rejected')]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await store.audit()).toHaveLength(2);
  });
  it.each(['pending', 'approved'] as const)('expires %s records and never revives on retry', async (status) => {
    const args = input(); const record = await store.propose(args, 'mcp');
    if (status === 'approved') await store.decide(record.id, 'approved');
    now += 3600000;
    await expect(store.decide(record.id, 'approved')).rejects.toThrow('transition');
    expect((await store.propose(args, 'mcp')).status).toBe('expired');
    expect((await store.detail(record.id)).audit.filter((e) => e.event === 'expired')).toHaveLength(1);
  });
  it('revalidates target before approval and checks expiry after validation', async () => {
    const record = await store.propose(input(), 'mcp');
    validate.mockRejectedValueOnce(new Error('Host removed'));
    await expect(store.decide(record.id, 'approved')).rejects.toThrow('Host removed');
    expect((await store.detail(record.id)).record.status).toBe('pending');
    validate.mockImplementationOnce(async () => { now += 3600001; });
    await expect(store.decide(record.id, 'approved')).rejects.toThrow('expired');
    expect((await store.detail(record.id)).record.status).toBe('expired');
  });
  it('fails closed on corrupt storage and preserves bytes', async () => {
    await fs.writeFile(path.join(directory, 'records.json'), 'not-json');
    await expect(store.list()).rejects.toThrow('Storage unavailable');
    expect(await fs.readFile(path.join(directory, 'records.json'), 'utf8')).toBe('not-json');
  });
  it('rejects a symlinked records file', async () => {
    const external = path.join(directory, 'external'); await fs.writeFile(external, 'secret');
    await fs.symlink(external, path.join(directory, 'records.json'));
    await expect(store.list()).rejects.toThrow('Storage unavailable');
    expect(await fs.readFile(external, 'utf8')).toBe('secret');
  });
  it('rejects unknown record IDs and unsupported decisions', async () => {
    await expect(store.detail('bad')).rejects.toThrow('Invalid task ID');
    await expect(store.decide(crypto.randomUUID(), 'full-access')).rejects.toThrow('Invalid decision');
    await expect(store.detail(crypto.randomUUID())).rejects.toThrow('not found');
  });
});

describe('passive host/workdir validation', () => {
  it('checks configured local cwd and remote host/cwd without SSH', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    await fs.mkdir(path.join(directory, '.purplemux'));
    const base = path.join(directory, '.purplemux');
    await fs.writeFile(path.join(base, 'hosts.json'), JSON.stringify({ hosts: [{ id: 'host-test' }] }));
    await fs.writeFile(path.join(base, 'workspaces.json'), JSON.stringify({ workspaces: [
      { directories: [directory] }, { hostId: 'host-test', remoteDirectory: '/srv/project', directories: [] },
    ] }));
    await expect(validateTaskSessionTarget('local', directory)).resolves.toBeUndefined();
    await expect(validateTaskSessionTarget('host-test', '/srv/project')).resolves.toBeUndefined();
    await expect(validateTaskSessionTarget('host-missing', '/srv/project')).rejects.toThrow('Host/workdir');
    await expect(validateTaskSessionTarget('host-test', '/srv/other')).rejects.toThrow('Host/workdir');
    await expect(validateTaskSessionTarget('local', '/not-configured')).rejects.toThrow('Host/workdir');
    const before = await fs.readFile(path.join(base, 'workspaces.json'), 'utf8');
    await validateTaskSessionTarget('host-test', '/srv/project');
    expect(await fs.readFile(path.join(base, 'workspaces.json'), 'utf8')).toBe(before);
  });
});

describe('durable Task Session execution authority', () => {
  const target = { hostId: 'local', workdir: '/tmp/workspace', workspaceId: 'ws', tabId: 'tab' };
  const proposal = (key = 'exec') => ({ ...input(key), ...target, requestedPermissions: 'full-access' });
  beforeEach(() => { vi.stubEnv('PURPLEMUX_MCP_ALLOW_WRITES', '1'); vi.stubEnv('PURPLEMUX_MCP_ALLOW_FULL_ACCESS', '1'); });
  afterEach(() => vi.unstubAllEnvs());
  const approved = async () => {
    const r = await store.propose(proposal(), 'mcp', capability);
    await store.decide(r.id, 'approved', 'pending', true); return r;
  };
  it('does not execute before authenticated GUI warning approval', async () => {
    const r = await store.propose(proposal(), 'mcp', capability);
    await expect(store.beginTurn(r.id, target, 'Build', 't1', capability)).rejects.toThrow('GUI-approved');
    await expect(store.decide(r.id, 'approved', 'pending')).rejects.toThrow('GUI warning');
    expect((await store.detail(r.id)).record.status).toBe('pending');
    await expect(store.propose({ ...proposal('forged'), confirmFullAccess: true }, 'mcp')).rejects.toThrow('Invalid');
  });
  it.each(['PURPLEMUX_MCP_ALLOW_WRITES', 'PURPLEMUX_MCP_ALLOW_FULL_ACCESS'])('requires administrator %s opt-in', async (flag) => {
    const r = await approved(); vi.stubEnv(flag, '0');
    await expect(store.beginTurn(r.id, target, 'Build', 't1', capability)).rejects.toThrow('disabled');
    expect((await store.detail(r.id)).record.turns).toBeUndefined();
  });
  it.each([{ hostId: 'other' }, { workdir: '/tmp/other' }, { workspaceId: 'other' }, { tabId: 'other' }])('rejects changed target %j', async (change) => {
    const r = await approved();
    await expect(store.beginTurn(r.id, { ...target, ...change }, 'Build', 't1', capability)).rejects.toThrow('mismatch');
  });
  it('revalidates registered targets on each continuation', async () => {
    const r = await approved(); const t = await store.beginTurn(r.id, target, 'Build', 't1', capability);
    validate.mockRejectedValueOnce(new Error('Tab deleted'));
    await expect(store.assertTurn(r.id, t.turn.id, target)).rejects.toThrow('binding changed');
  });
  it('never promotes old GUI-only approvals', async () => {
    const r = await store.propose(input('legacy'), 'gui'); await store.decide(r.id, 'approved');
    await expect(store.beginTurn(r.id, target, 'Build', 't1', capability)).rejects.toThrow('Legacy');
  });
  it('atomically reserves turns, prevents concurrent injection, and audits two turns without secrets/output', async () => {
    const r = await approved();
    const reservations = await Promise.all(Array.from({ length: 8 }, () => store.beginTurn(r.id, target, 'password=secret Build', 't1', capability)));
    expect(reservations.filter((v) => !v.existing)).toHaveLength(1);
    const t1 = reservations[0].turn;
    await expect(store.beginTurn(r.id, target, 'Build', 't2', capability)).rejects.toThrow('active');
    await expect(store.beginTurn(r.id, target, 'different', 't1', capability)).rejects.toThrow('conflict');
    await store.bindTurn(r.id, t1.id, 'thread1', 'codex-turn1'); await store.settleTurn(r.id, t1.id, 'completed');
    const t2 = await store.beginTurn(r.id, target, 'Fix then rebuild', 't2', capability);
    await expect(store.bindTurn(r.id, t2.turn.id, 'thread2', 'codex-turn2')).rejects.toThrow('Pinned');
    await store.bindTurn(r.id, t2.turn.id, 'thread1', 'codex-turn2'); await store.settleTurn(r.id, t2.turn.id, 'completed');
    const detail = await store.detail(r.id);
    expect(detail.record).toMatchObject({ status: 'approved', executionState: 'idle', pinnedThreadId: 'thread1' });
    expect(detail.record.turns?.map((t) => t.result)).toEqual(['completed', 'completed']);
    expect(detail.audit.filter((e) => e.event === 'turn-completed')).toHaveLength(2);
    expect(await fs.readFile(path.join(directory, 'records.json'), 'utf8')).not.toContain('password=secret');
    await store.finish(r.id);
    await expect(store.beginTurn(r.id, target, 'Build', 't3', capability)).rejects.toThrow('GUI-approved');
  });
  it('excludes a second session from a tab even between turns', async () => {
    const r = await approved(); const t = await store.beginTurn(r.id, target, 'Build', 't1', capability); await store.settleTurn(r.id, t.turn.id, 'completed');
    const other = await store.propose({ ...proposal('other'), purpose: 'Other task' }, 'mcp', capability); await store.decide(other.id, 'approved', 'pending', true);
    await expect(store.beginTurn(other.id, target, 'Build', 't2', capability)).rejects.toThrow('lease');
    await store.finish(r.id, true); await store.acknowledgeOwnerRelease(r.id);
    expect((await store.beginTurn(other.id, target, 'Build', 't2', capability)).existing).toBe(false);
  });
  it.each(['failed', 'unknown'] as const)('revokes on %s and requires a new GUI proposal', async (result) => {
    const r = await approved(); const t = await store.beginTurn(r.id, target, 'Build', 't1', capability); await store.settleTurn(r.id, t.turn.id, result);
    expect((await store.detail(r.id)).record.status).toBe('revoked');
    await expect(store.beginTurn(r.id, target, 'retry', 't2', capability)).rejects.toThrow('GUI-approved');
  });
  it('revokes both idle and running owned sessions after process restart', async () => {
    const r = await approved(); const t = await store.beginTurn(r.id, target, 'Build', 't1', capability);
    await store.settleTurn(r.id, t.turn.id, 'completed');
    now += TASK_SESSION_LEASE_MS;
    const restarted = new TaskSessionStore(directory, validate, () => now, 'new-process');
    expect((await restarted.detail(r.id)).record).toMatchObject({ status: 'revoked', executionState: 'unknown' });
    await store.acknowledgeOwnerRelease(r.id); // Simulated old process is still alive in this test.
    const r2 = await store.propose({ ...proposal('restart2'), purpose: 'Second task' }, 'mcp', capability); await store.decide(r2.id, 'approved', 'pending', true);
    await store.beginTurn(r2.id, target, 'Build', 't1', capability);
    now += TASK_SESSION_LEASE_MS;
    const detail = await restarted.detail(r2.id);
    expect(detail.record.status).toBe('revoked'); expect(detail.record.turns?.[0].result).toBe('unknown');
  });
  it('expires and rejects an already reserved turn before RPC', async () => {
    const r = await approved(); const t = await store.beginTurn(r.id, target, 'Build', 't1', capability); now += 3600001;
    await expect(store.assertTurn(r.id, t.turn.id, target)).rejects.toThrow('GUI-approved');
    expect((await store.detail(r.id)).record.status).toBe('expired');
    expect((await store.detail(r.id)).audit).toContainEqual(expect.objectContaining({ event: 'turn-failed', result: 'unknown', instructionHash: t.turn.instructionHash }));
  });
  it('deduplicates ttl proposal retries even as time passes', async () => {
    const { expiresAt: _expiresAt, ...p } = proposal();
    const first = await store.propose({ ...p, ttl: 3600 }, 'mcp'); now += 1000;
    expect((await store.propose({ ...p, ttl: 3600 }, 'mcp')).id).toBe(first.id);
  });
});

describe('cross-worker leases and execution capabilities', () => {
  const target = { hostId: 'local', workdir: '/tmp/workspace', workspaceId: 'ws', tabId: 'tab' };
  const proposal = () => ({ ...input(), ...target, requestedPermissions: 'full-access' });
  beforeEach(() => { vi.stubEnv('PURPLEMUX_MCP_ALLOW_WRITES', '1'); vi.stubEnv('PURPLEMUX_MCP_ALLOW_FULL_ACCESS', '1'); });
  afterEach(() => vi.unstubAllEnvs());
  const reserve = async () => {
    const r = await store.propose(proposal(), 'mcp', capability);
    await store.decide(r.id, 'approved', 'pending', true);
    return store.beginTurn(r.id, target, 'Build', 't1', capability);
  };
  it('preserves a live owner through another worker list/detail and blocks GUI mutation/runtime creation', async () => {
    const other = new TaskSessionStore(directory, validate, () => now, 'reader-worker');
    const r = await reserve();
    expect((await other.list())[0].status).toBe('approved');
    expect((await other.detail(r.record.id)).record.executionState).toBe('running');
    const operation = vi.fn(async () => 'started');
    await expect(other.withTabAccess('ws', 'tab', true, operation)).rejects.toThrow('active Task Session');
    await expect(store.withTabAccess('ws', 'tab', false, operation)).rejects.toThrow('active Task Session');
    await expect(other.beginTurn(r.record.id, target, 'Build', 't1', capability)).rejects.toThrow('another worker');
    expect(operation).not.toHaveBeenCalled();
    await store.settleTurn(r.record.id, r.turn.id, 'completed');
    now += 10000; await store.heartbeat(r.record.id); now += 10000;
    expect((await other.detail(r.record.id)).record).toMatchObject({ status: 'approved', executionState: 'idle' });
    await other.decide(r.record.id, 'revoked', 'approved');
    await expect(store.heartbeat(r.record.id)).rejects.toThrow('lease lost');
    expect((await store.detail(r.record.id)).record.status).toBe('revoked');
  });
  it('preserves a genuinely independent live Node owner and revokes after its process exits', async () => {
    const marker = path.join(directory, 'child-reserved');
    const proposalArgs = proposal();
    const code = `const fs = require('node:fs/promises');
      const { TaskSessionStore } = require('./src/lib/task-session-store');
      (async () => {
        const child = new TaskSessionStore(${JSON.stringify(directory)}, async () => {}, Date.now, 'independent-child');
        const r = await child.propose(${JSON.stringify(proposalArgs)}, 'mcp', ${JSON.stringify(capability)});
        await child.decide(r.id, 'approved', 'pending', true);
        await child.beginTurn(r.id, ${JSON.stringify(target)}, 'Build', 't1', ${JSON.stringify(capability)});
        await fs.writeFile(${JSON.stringify(marker)}, r.id);
        await new Promise(r => setTimeout(r, 1500));
      })().catch(e => { process.stderr.write(e.message); process.exitCode = 1; });`;
    const child = promisify(execFile)(process.execPath, ['--import', 'tsx', '-e', code], { cwd: process.cwd() });
    let taskId = '';
    for (let i = 0; i < 100; i++) {
      try { taskId = await fs.readFile(marker, 'utf8'); break; } catch { await new Promise(r => setTimeout(r, 20)); }
    }
    try {
      expect(taskId).toBeTruthy();
      const reader = new TaskSessionStore(directory, validate, () => now, 'parent-reader');
      expect((await reader.list())[0].status).toBe('approved');
      expect((await reader.detail(taskId)).record.ownerLease?.pid).not.toBe(process.pid);
      await child;
      expect((await reader.detail(taskId)).record).toMatchObject({ status: 'revoked', executionState: 'unknown' });
    } finally { await child; }
  }, 10000);
  it('does not let readers heartbeat or steal an idle lease; stale authority never resumes', async () => {
    const r = await reserve(); await store.settleTurn(r.record.id, r.turn.id, 'completed');
    const other = new TaskSessionStore(directory, validate, () => now, 'other-worker');
    await expect(other.heartbeat(r.record.id)).rejects.toThrow('lease lost');
    now += TASK_SESSION_LEASE_MS;
    expect((await other.detail(r.record.id)).record).toMatchObject({ status: 'revoked', executionState: 'unknown' });
    await expect(store.beginTurn(r.record.id, target, 'Build', 't2', capability)).rejects.toThrow('GUI-approved');
    await expect(other.beginTurn(r.record.id, target, 'Build', 't2', capability)).rejects.toThrow('GUI-approved');
  });
  it('blocks stale takeover until the live owner confirms that its runtime has stopped', async () => {
    const r = await reserve(); now += TASK_SESSION_LEASE_MS;
    const other = new TaskSessionStore(directory, validate, () => now, 'new-worker');
    expect((await other.detail(r.record.id)).record.status).toBe('revoked');
    const next = await other.propose({ ...proposal(), purpose: 'Replacement task', idempotencyKey: 'replacement' }, 'mcp', capability);
    await other.decide(next.id, 'approved', 'pending', true);
    await expect(other.beginTurn(next.id, target, 'Build', 't2', capability)).rejects.toThrow('active lease');
    await other.acknowledgeOwnerRelease(r.record.id); // Non-owner cannot clear the barrier.
    await expect(other.withTabAccess('ws', 'tab', true, async () => {})).rejects.toThrow('active Task Session');
    await store.acknowledgeOwnerRelease(r.record.id); // Runtime stop acknowledgement by the owner.
    expect((await other.beginTurn(next.id, target, 'Build', 't2', capability)).existing).toBe(false);
  });
  it('fails closed without permitting takeover when process identity becomes unobservable', async () => {
    const r = await reserve();
    const readFile = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === `/proc/${process.pid}/stat`) throw Object.assign(new Error('not readable'), { code: 'EACCES', path: args[0] });
      return readFile(...args);
    });
    const other = new TaskSessionStore(directory, validate, () => now, 'reader-worker');
    expect((await other.detail(r.record.id)).record.status).toBe('revoked');
    await expect(other.withTabAccess('ws', 'tab', true, async () => {})).rejects.toThrow('active Task Session');
    spy.mockRestore(); await store.acknowledgeOwnerRelease(r.record.id);
    await expect(other.withTabAccess('ws', 'tab', true, async () => 'safe')).resolves.toBe('safe');
  });
  it.each(['processStart', 'pid', 'missing'] as const)('rejects PID reuse/dead process/legacy lease: %s', async (change) => {
    const r = await reserve();
    const file = path.join(directory, 'records.json'); const state = JSON.parse(await fs.readFile(file, 'utf8'));
    if (change === 'missing') delete state.records[0].ownerLease;
    else if (change === 'pid') state.records[0].ownerLease.pid = 2147483647;
    else state.records[0].ownerLease.processStart = 'previous-boot:previous-process';
    await fs.writeFile(file, JSON.stringify(state));
    const detail = await store.detail(r.record.id);
    expect(detail.record.status).toBe('revoked'); expect(detail.record.turns?.[0].result).toBe('unknown');
  });
  it('converges a persisted reservation orphan after a partial fsync failure without executing again', async () => {
    const r = await store.propose(proposal(), 'mcp', capability); await store.decide(r.id, 'approved', 'pending', true);
    const open = fs.open.bind(fs);
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (args[0] === directory) vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('directory sync failed'));
      return handle;
    });
    await expect(store.beginTurn(r.id, target, 'Build', 't1', capability)).rejects.toThrow('directory sync failed');
    spy.mockRestore();
    expect((await store.detail(r.id)).record.executionState).toBe('running');
    now += TASK_SESSION_LEASE_MS;
    expect((await store.detail(r.id)).record).toMatchObject({ status: 'revoked', executionState: 'unknown' });
    await expect(store.beginTurn(r.id, target, 'Build', 't1', capability)).rejects.toThrow('GUI-approved');
  });
  it('requires a capability even when caller B knows task UUID, target and proposal key', async () => {
    const r = await store.propose(proposal(), 'mcp', capability); await store.decide(r.id, 'approved', 'pending', true);
    await expect(store.beginTurn(r.id, target, 'Build', 't1')).rejects.toThrow('capability required');
    await expect(store.beginTurn(r.id, target, 'Build', 't1', 'B'.repeat(43))).rejects.toThrow('capability required');
    await expect(store.requireCapability(r.id, 'B'.repeat(43))).rejects.toThrow('capability required');
    await expect(store.propose(proposal(), 'mcp', 'B'.repeat(43))).rejects.toThrow('capability required');
    expect((await store.propose(proposal(), 'mcp', capability)).id).toBe(r.id);
    expect(JSON.stringify(await store.list())).not.toContain(capability);
    expect(JSON.stringify(await store.detail(r.id))).not.toContain(capability);
    const raw = await fs.readFile(path.join(directory, 'records.json'), 'utf8');
    expect(raw).not.toContain(capability); expect(raw).toContain('capabilities');
  });
  it('rejects accidentally embedding the capability in persisted text or Codex instructions', async () => {
    await expect(store.propose({ ...proposal(), purpose: 'Use ' + capability }, 'mcp', capability)).rejects.toThrow('must not appear');
    const r = await reserve(); await store.settleTurn(r.record.id, r.turn.id, 'completed');
    await expect(store.beginTurn(r.record.id, target, 'Use ' + capability, 't2', capability)).rejects.toThrow('Invalid turn');
    expect(JSON.stringify((await store.detail(r.record.id)).audit)).not.toContain(capability);
  });
  it('fails closed for executable-looking legacy records without a stored capability', async () => {
    const r = await store.propose(proposal(), 'mcp'); await store.decide(r.id, 'approved', 'pending', true);
    await expect(store.beginTurn(r.id, target, 'Build', 't1', capability)).rejects.toThrow('capability required');
  });
});

describe('remote endpoint bindings', () => {
  const target = { hostId: 'remote', workdir: '/srv/project', workspaceId: 'ws', tabId: 'tab' };
  const endpoint = { id: 'remote', address: 'approved.example', username: 'dev', port: 22 };
  const hosts = () => path.join(directory, '.purplemux', 'hosts.json');
  const proposal = () => ({ ...input(), ...target, requestedPermissions: 'full-access' });
  beforeEach(async () => {
    vi.stubEnv('PURPLEMUX_MCP_ALLOW_WRITES', '1'); vi.stubEnv('PURPLEMUX_MCP_ALLOW_FULL_ACCESS', '1');
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    await fs.mkdir(path.dirname(hosts())); await fs.writeFile(hosts(), JSON.stringify({ hosts: [endpoint] }));
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each([{ address: 'unapproved.example' }, { username: 'root' }, { port: 2222 }])('rejects reassignment before GUI approval: %j', async (change) => {
    const r = await store.propose(proposal(), 'mcp', capability);
    expect(r.targetConnection).toEqual({ address: endpoint.address, username: endpoint.username, port: 22 });
    await fs.writeFile(hosts(), JSON.stringify({ hosts: [{ ...endpoint, ...change }] }));
    await expect(store.decide(r.id, 'approved', 'pending', true)).rejects.toThrow('connection changed');
    expect((await store.detail(r.id)).record.status).toBe('pending');
  });
  it.each(['before-turn', 'running', 'idle'] as const)('revokes reassignment %s without endpoint details in audit', async (phase) => {
    const r = await store.propose(proposal(), 'mcp', capability); await store.decide(r.id, 'approved', 'pending', true);
    if (phase !== 'before-turn') {
      const turn = await store.beginTurn(r.id, target, 'Build', 't1', capability);
      if (phase === 'idle') await store.settleTurn(r.id, turn.turn.id, 'completed');
    }
    await fs.writeFile(hosts(), JSON.stringify({ hosts: [{ ...endpoint, address: 'unapproved.example' }] }));
    if (phase === 'before-turn') await expect(store.beginTurn(r.id, target, 'Build', 't1', capability)).rejects.toThrow('binding changed');
    else await expect(store.heartbeat(r.id)).rejects.toThrow('connection changed');
    const detail = await store.detail(r.id); expect(detail.record.status).toBe('revoked');
    expect(JSON.stringify(detail.audit)).not.toContain('example');
  });
  it('revokes idle sessions when workspace/tab/workdir validation changes', async () => {
    const r = await store.propose(proposal(), 'mcp', capability); await store.decide(r.id, 'approved', 'pending', true);
    const turn = await store.beginTurn(r.id, target, 'Build', 't1', capability); await store.settleTurn(r.id, turn.turn.id, 'completed');
    validate.mockRejectedValueOnce(new Error('Workspace/tab removed or directory changed'));
    await expect(store.heartbeat(r.id)).rejects.toThrow('directory changed');
    expect((await store.detail(r.id)).record.status).toBe('revoked');
  });
  it('rejects legacy remote fingerprint', async () => {
    const r = await store.propose(proposal(), 'mcp', capability); await store.decide(r.id, 'approved', 'pending', true);
    const file = path.join(directory, 'records.json'); const state = JSON.parse(await fs.readFile(file, 'utf8'));
    delete state.records[0].targetFingerprint; await fs.writeFile(file, JSON.stringify(state));
    await expect(store.beginTurn(r.id, target, 'Build', 't1', capability)).rejects.toThrow('binding changed');
    expect((await store.detail(r.id)).record.status).toBe('revoked');
    expect(await taskSessionConnection('remote')).toHaveProperty('fingerprint');
  });
});
