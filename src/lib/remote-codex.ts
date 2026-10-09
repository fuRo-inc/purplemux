import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
import { getRemoteHost } from '@/lib/remote-host-store';
import { parseCodexContent } from '@/lib/session-parser-codex';
import type { IWorkspace, ITab } from '@/types/terminal';
import type { ITimelineEntry } from '@/types/timeline';

const execFile = promisify(execFileCallback);
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

// Executed on the selected SSH host with Python 3 (Ubuntu 22.04 ships Python 3).
// Locates the Codex process belonging to THIS remote tmux pane, then retrieves
// only its matching Codex JSONL. It never uses NUC's local ~/.codex directory.
const REMOTE_SNAPSHOT_PYTHON = "import os\nimport sys\nimport glob\nimport json\nimport time\nimport re\nimport subprocess\nfrom datetime import date, timedelta\n\nname = sys.argv[1]\ncwd_hint = sys.argv[2]\nsocket = ['tmux', '-L', 'purplemux_remote']\n\ndef tmux(*args):\n    try:\n        result = subprocess.run(socket + list(args), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,\n                                text=True, timeout=3, check=False)\n        return result.stdout.strip() if result.returncode == 0 else ''\n    except Exception:\n        return ''\n\ndef descendants(pid):\n    seen = set()\n    stack = [pid]\n    while stack and len(seen) < 300:\n        current = stack.pop()\n        if current in seen:\n            continue\n        seen.add(current)\n        try:\n            with open('/proc/%d/task/%d/children' % (current, current)) as f:\n                stack.extend(int(item) for item in f.read().split() if item.isdigit())\n        except (OSError, ValueError):\n            pass\n    return seen\n\ndef process_info(pid):\n    try:\n        with open('/proc/%d/cmdline' % pid, 'rb') as f:\n            parts = [p.decode(errors='replace') for p in f.read().split(b'\\0') if p]\n        if not parts:\n            return None\n        command = os.path.basename(parts[0]).lower()\n        is_codex = command == 'codex' or command.startswith('codex-')\n        if command in ('node', 'nodejs'):\n            is_codex = any('codex' in p.lower() for p in parts[1:4])\n        if not is_codex:\n            return None\n        with open('/proc/%d/stat' % pid) as f:\n            suffix = f.read().rsplit(')', 1)[1].split()\n        ticks = int(suffix[19])\n        uptime = float(open('/proc/uptime').read().split()[0])\n        started = time.time() - uptime + ticks / os.sysconf('SC_CLK_TCK')\n        return {'pid': pid, 'started': started, 'args': ' '.join(parts)}\n    except (OSError, ValueError, IndexError):\n        return None\n\ndef read_meta(path):\n    try:\n        with open(path, 'rb') as f:\n            raw = f.readline(65536)\n        item = json.loads(raw)\n        if item.get('type') != 'session_meta':\n            return None\n        payload = item.get('payload') or {}\n        sid = payload.get('id')\n        if not isinstance(sid, str) or not re.fullmatch(r'[0-9a-fA-F-]{36}', sid):\n            return None\n        cwd = payload.get('cwd')\n        when = payload.get('timestamp') or item.get('timestamp')\n        try:\n            from datetime import datetime\n            created = datetime.fromisoformat(when.replace('Z', '+00:00')).timestamp() if isinstance(when, str) else 0\n        except (ValueError, TypeError):\n            created = 0\n        return {'id': sid, 'cwd': cwd, 'created': created, 'path': path}\n    except (OSError, ValueError, TypeError):\n        return None\n\npane = tmux('display-message', '-p', '-t', name, '#{pane_pid}')\nif not pane.isdigit():\n    print(json.dumps({'running': False, 'sessionId': None, 'jsonl': '', 'error': 'Remote tmux pane not found'}))\n    sys.exit(0)\n\npane_cwd = tmux('display-message', '-p', '-t', name, '#{pane_current_path}') or cwd_hint\nprocesses = [p for p in (process_info(p) for p in descendants(int(pane))) if p]\nactive = sorted(processes, key=lambda p: p['started'])[-1] if processes else None\nstored = tmux('show-options', '-p', '-v', '-t', name, '@purplemuxCodexSessionId')\nsessions_root = os.path.join(os.path.expanduser('~'), '.codex', 'sessions')\nfiles = []\nfor n in range(35):\n    d = date.today() - timedelta(days=n)\n    files += glob.glob(os.path.join(sessions_root, d.strftime('%Y'), d.strftime('%m'), d.strftime('%d'), '*.jsonl'))\nfiles.sort(key=lambda p: os.path.getmtime(p) if os.path.isfile(p) else 0, reverse=True)\n\nselected = None\nfor path in files[:160]:\n    if stored and stored not in os.path.basename(path):\n        continue\n    meta = read_meta(path)\n    if meta and meta['id'] == stored:\n        selected = meta\n        break\n\nif not selected and active:\n    for path in files[:160]:\n        meta = read_meta(path)\n        if not meta or meta['cwd'] != pane_cwd:\n            continue\n        if meta['created'] >= active['started'] - 90:\n            selected = meta\n            break\n    if not selected:\n        # If the process resumed an older session, prefer its explicit UUID.\n        match = re.search(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', active['args'])\n        if match:\n            for path in files[:160]:\n                if match.group(0) in os.path.basename(path):\n                    selected = read_meta(path)\n                    break\n\nif selected and active:\n    tmux('set-option', '-p', '-t', name, '@purplemuxCodexSessionId', selected['id'])\n\ncontent = ''\nif selected:\n    try:\n        with open(selected['path'], 'rb') as f:\n            f.seek(0, 2)\n            size = f.tell()\n            start = max(0, size - 1600000)\n            f.seek(start)\n            blob = f.read(1600000)\n        if start:\n            blob = blob.partition(b'\\n')[2]\n        if blob and not blob.endswith(b'\\n'):\n            blob = blob.rpartition(b'\\n')[0]\n        content = blob.decode('utf-8', errors='replace')\n    except OSError:\n        pass\n\nprint(json.dumps({\n    'running': bool(active),\n    'sessionId': selected['id'] if selected else None,\n    'jsonl': content,\n    'cwd': pane_cwd,\n}))\n";

export interface IRemoteCodexSnapshot {
  running: boolean;
  sessionId: string | null;
  cwd: string | null;
  entries: ITimelineEntry[];
  warning?: string;
}

export const readRemoteCodexSnapshot = async (
  workspace: IWorkspace,
  tab: ITab,
): Promise<IRemoteCodexSnapshot> => {
  if (!workspace.hostId || !workspace.remoteDirectory) throw new Error('Not a remote workspace');
  if (!/^pt-[a-zA-Z0-9-]+$/.test(tab.sessionName)) throw new Error('Invalid terminal session');
  const host = await getRemoteHost(workspace.hostId);
  if (!host) throw new Error('Remote host is not registered');
  if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(host.username) ||
      !/^[a-zA-Z0-9.:-]+$/.test(host.address) ||
      !Number.isInteger(host.port) || host.port < 1 || host.port > 65535) {
    throw new Error('Invalid SSH host configuration');
  }

  // SSH runs its remote command via a shell. Every argument is quoted, and
  // the Python source is a fixed, base64-encoded program, not user input.
  const source = Buffer.from(REMOTE_SNAPSHOT_PYTHON, 'utf8').toString('base64');
  const bootstrap = `import base64; exec(base64.b64decode('${source}'))`;
  const remoteCommand = `python3 -c ${quote(bootstrap)} ${quote(tab.sessionName)} ${quote(workspace.remoteDirectory)}`;
  const { stdout } = await execFile('ssh', [
    '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    '-p', String(host.port), `${host.username}@${host.address}`, remoteCommand,
  ], { timeout: 18000, maxBuffer: 4 * 1024 * 1024 });

  let response: { running?: boolean; sessionId?: string | null; jsonl?: string; cwd?: string; error?: string };
  try {
    response = JSON.parse(stdout) as typeof response;
  } catch {
    throw new Error('Invalid response from remote Codex');
  }
  if (response.error) throw new Error(response.error);
  const entries = response.jsonl ? parseCodexContent(response.jsonl) : [];
  return {
    running: response.running === true,
    sessionId: response.sessionId ?? null,
    cwd: response.cwd ?? null,
    entries: entries.slice(-300),
  };
};
