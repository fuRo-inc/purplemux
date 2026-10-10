import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TaskSessionStore, validateTaskSessionTarget, type TaskSessionTargetValidator } from '@/lib/task-session-store';

let directory: string;
let store: TaskSessionStore;
let now: number;
let validate: ReturnType<typeof vi.fn<TaskSessionTargetValidator>>;
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
