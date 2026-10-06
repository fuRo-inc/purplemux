import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { nanoid } from 'nanoid';
import type { IRemoteHost, IRemoteHostInput, IRemoteHostsData } from '@/types/remote-host';

const execFile = promisify(execFileCb);
const BASE_DIR = path.join(os.homedir(), '.purplemux');
const HOSTS_FILE = path.join(BASE_DIR, 'hosts.json');
const SSH_TIMEOUT_MS = 8000;

const g = globalThis as unknown as {
  __purplemuxRemoteHostLock?: Promise<void>;
};

if (!g.__purplemuxRemoteHostLock) g.__purplemuxRemoteHostLock = Promise.resolve();

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const prev = g.__purplemuxRemoteHostLock!;
  g.__purplemuxRemoteHostLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

const emptyState = (): IRemoteHostsData => ({
  hosts: [],
  updatedAt: new Date().toISOString(),
});

const readData = async (): Promise<IRemoteHostsData> => {
  try {
    const raw = await fs.readFile(HOSTS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as IRemoteHostsData;
    if (!Array.isArray(parsed.hosts)) return emptyState();
    return parsed;
  } catch {
    return emptyState();
  }
};

const writeData = async (data: IRemoteHostsData): Promise<void> => {
  await fs.mkdir(BASE_DIR, { recursive: true });
  data.updatedAt = new Date().toISOString();
  const tmp = HOSTS_FILE + '.tmp';
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, HOSTS_FILE);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
};

const normalizeInput = (input: IRemoteHostInput): Required<Pick<IRemoteHostInput, 'name' | 'address' | 'username' | 'port'>> & Pick<IRemoteHostInput, 'description'> => {
  const name = input.name?.trim();
  const address = input.address?.trim();
  const username = input.username?.trim();
  const port = Number(input.port ?? 22);

  if (!name) throw new Error('Host name is required');
  if (!address) throw new Error('Host address is required');
  if (!username) throw new Error('SSH username is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH port must be between 1 and 65535');

  return {
    name,
    address,
    username,
    port,
    description: input.description?.trim() || undefined,
  };
};

export const listRemoteHosts = async (): Promise<IRemoteHost[]> => {
  const data = await readData();
  return data.hosts;
};

export const getRemoteHost = async (id: string): Promise<IRemoteHost | undefined> => {
  const data = await readData();
  return data.hosts.find((host) => host.id === id);
};

export const createRemoteHost = async (input: IRemoteHostInput): Promise<IRemoteHost> =>
  withLock(async () => {
    const normalized = normalizeInput(input);
    const data = await readData();
    if (data.hosts.some((host) => host.name.toLowerCase() === normalized.name.toLowerCase())) {
      throw new Error('A host with this name already exists');
    }
    const now = new Date().toISOString();
    const host: IRemoteHost = {
      id: `host-${nanoid(8)}`,
      ...normalized,
      createdAt: now,
      updatedAt: now,
    };
    data.hosts.push(host);
    await writeData(data);
    return host;
  });

export const updateRemoteHost = async (id: string, input: IRemoteHostInput): Promise<IRemoteHost | null> =>
  withLock(async () => {
    const normalized = normalizeInput(input);
    const data = await readData();
    const host = data.hosts.find((item) => item.id === id);
    if (!host) return null;
    if (data.hosts.some((item) => item.id !== id && item.name.toLowerCase() === normalized.name.toLowerCase())) {
      throw new Error('A host with this name already exists');
    }
    Object.assign(host, normalized, { updatedAt: new Date().toISOString() });
    await writeData(data);
    return host;
  });

export const deleteRemoteHost = async (id: string): Promise<boolean> =>
  withLock(async () => {
    const data = await readData();
    const index = data.hosts.findIndex((host) => host.id === id);
    if (index < 0) return false;
    data.hosts.splice(index, 1);
    await writeData(data);
    return true;
  });

export interface IRemoteHostTestResult {
  ok: boolean;
  latencyMs: number;
  hostname?: string;
  error?: string;
}

export const testRemoteHost = async (host: IRemoteHost): Promise<IRemoteHostTestResult> => {
  const started = Date.now();
  const target = `${host.username}@${host.address}`;
  try {
    const { stdout } = await execFile(
      'ssh',
      [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=5',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-p', String(host.port),
        target,
        'hostname',
      ],
      { timeout: SSH_TIMEOUT_MS },
    );
    return {
      ok: true,
      latencyMs: Date.now() - started,
      hostname: stdout.trim() || host.address,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'SSH connection failed';
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: message,
    };
  }
};
