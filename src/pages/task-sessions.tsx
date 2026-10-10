import { useCallback, useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import { requireAuth } from '@/lib/require-auth';
import { TaskSessionGuiClient } from '@/lib/task-session-gui-client';
import type { TaskSession, TaskSessionAudit } from '@/types/task-session';

const labels = { pending: '承認待ち', approved: '承認済み', rejected: '拒否', revoked: '取消済み', expired: '期限切れ', completed: '終了', 'turn-started': 'ターン開始', 'turn-completed': 'ターン完了', 'turn-failed': 'ターン失敗/不明' };
export default function TaskSessionsPage() {
  const [offset, setOffset] = useState(0);
  const [records, setRecords] = useState<TaskSession[]>([]);
  const [selected, setSelected] = useState<{ record: TaskSession; audit: TaskSessionAudit[] } | null>(null);
  const [audit, setAudit] = useState<TaskSessionAudit[]>([]);
  const [csrf, setCsrf] = useState('');
  const [client] = useState(() => new TaskSessionGuiClient(setCsrf));
  const [selectedId, setSelectedId] = useState('');
  const currentId = useRef('');
  const detailVersion = useRef(0);
  const mutationBusy = useRef(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [executionEnabled, setExecutionEnabled] = useState(false);

  async function refresh(pageOffset = offset) {
    const data = await client.request<{ records: TaskSession[]; fullAccessEnabled: boolean }>('/api/task-sessions?offset=' + pageOffset);
    setExecutionEnabled(data.fullAccessEnabled);
    setOffset(pageOffset);
    setRecords(data.records);
    const events = await client.request<{ audit: TaskSessionAudit[] }>('/api/task-sessions?audit=1'); setAudit(events.audit);
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));

    // Refresh always uses GET; no CSRF-dependent mutation in this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = setInterval(() => { void refresh(offset).catch((e) => setError(e.message)); }, 30000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset]);

  const loadDetail = useCallback(async (id: string) => {
    if (currentId.current !== id) return;
    const version = ++detailVersion.current;
    try {
      const data = await client.request<{ record: TaskSession; audit: TaskSessionAudit[] }>('/api/task-sessions?id=' + encodeURIComponent(id));
      if (currentId.current === id && detailVersion.current === version) setSelected(data);
    } catch (e) {
      if (currentId.current === id && detailVersion.current === version) {
        setSelected(null); // Never leave actionable stale details after a failed read.
        setError(e instanceof Error ? e.message : '照会に失敗しました');
      }
    }
  }, [client]);
  useEffect(() => {
    if (!selectedId) return;
    const versionRef = detailVersion;
    void loadDetail(selectedId);
    const timer = setInterval(() => { void loadDetail(selectedId); }, 30000);
    return () => { clearInterval(timer); versionRef.current++; };
  }, [selectedId, loadDetail]);

  function detail(id: string) {
    setError('');
    currentId.current = id;
    detailVersion.current++;
    setSelected(null);
    if (selectedId === id) void loadDetail(id);
    else setSelectedId(id);
  }
  async function decide(action: 'approved' | 'rejected' | 'revoked' | 'completed') {
    if (!selected || mutationBusy.current) return;
    const record = selected.record;
    if (!window.confirm(`${labels[action]}を記録しますか？\n${record.purpose}\n${record.hostId}: ${record.workdir}\n期限: ${record.expiresAt}\nFull AccessはLinuxユーザーの全ファイルにアクセスでき、repo外の操作をOSで防ぎません。目的・対象範囲は実行指示であり技術的な遮断ではありません。承認した通常作業は期限内に継続実行します。`)) return;
    mutationBusy.current = true; setBusy(true); setError('');
    try {
      await client.request('/api/task-sessions/' + record.id, { action, confirm: true, expectedStatus: record.status, ...(action === 'approved' && record.requestedPermissions === 'full-access' ? { fullAccessWarningAccepted: true } : {}) });
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : '操作に失敗しました'); }
    finally {
      await loadDetail(record.id);
      mutationBusy.current = false; setBusy(false);
    }
  }
  return <main className="mx-auto max-w-4xl space-y-6 p-6">
    <Head><title>Task Sessions — Purplemux</title></Head>
    <Link href="/" className="underline">Workspaceへ戻る</Link>
    <h1 className="text-2xl font-bold">Task Sessions</h1>
    <p className="rounded border border-amber-500 p-3">Full AccessはLinuxユーザーの全ファイルにアクセスでき、repo外への操作をOSレベルでは防ぎません。目的とscopeは実行指示であり、技術的な遮断ではありません。関係ない削除や別デバイスへの大きな操作はタスク外です。</p>
    <p>{executionEnabled ? '承認済みセッションの通常作業は期限内に継続して実行できます。' : '実行権限は未有効（管理者のWRITESとFULL_ACCESS両方のopt-inが必要）'}</p>
    <p>ChatGPTからの申請を確認し、対象とリスクを確認して承認または拒否してください。</p>
    {error && <p role="alert" className="text-red-500">{error}</p>}
    <section className="space-y-2">
      <h2 className="font-bold">承認待ちタスク・セッション（100件ずつ）</h2>
      <button className="underline" disabled={busy} onClick={() => { void refresh().catch((e) => setError(e.message)); }}>更新</button>
      <div className="flex gap-4">
        <button className="underline" disabled={busy || offset === 0} onClick={() => { void refresh(Math.max(0, offset - 100)).catch((e) => setError(e.message)); }}>新しい100件</button>
        <button className="underline" disabled={busy || records.length < 100 || offset >= 4900} onClick={() => { void refresh(offset + 100).catch((e) => setError(e.message)); }}>古い100件</button>
      </div>
      {records.length === 0 && <p>申請はありません。</p>}
      {records.map((record) => <button className="block w-full rounded border p-3 text-left" key={record.id} onClick={() => void detail(record.id)}>
        {labels[record.status]} — {record.purpose}<br />{record.hostId}: {record.workdir}<br />接続先: {record.targetConnection ? `${record.targetConnection.username}@${record.targetConnection.address}:${record.targetConnection.port}` : record.hostId === 'local' ? 'local' : '旧記録・実行不可'}<br />Workspace: {record.workspaceId || "旧記録"} / Tab: {record.tabId || "未指定"}<br />権限: {record.requestedPermissions || "実行不可"} / 実行: {record.executionState || "未開始"}<br />範囲: {record.scope}<br />期限: {record.expiresAt}
      </button>)}
    </section>
    {selected && <section className="space-y-3 rounded border p-4">
      <h2 className="font-bold">申請詳細 — {labels[selected.record.status]}</h2>
      <dl className="break-words">
        {Object.entries(selected.record).map(([key, value]) => <div key={key}><dt className="font-bold">{key}</dt><dd className="whitespace-pre-wrap">{typeof value === "object" ? JSON.stringify(value, null, 2) : value}</dd></div>)}
      </dl>
      <div className="flex gap-3">
        {selected.record.status === 'pending' && <>
          <button className="rounded border p-2" disabled={busy || !csrf} onClick={() => void decide('approved')}>リスクを確認して承認</button>
          <button className="rounded border p-2" disabled={busy || !csrf} onClick={() => void decide('rejected')}>拒否</button>
        </>}
        {selected.record.status === 'approved' && <button className="rounded border p-2" disabled={busy || !csrf} onClick={() => void decide('completed')}>終了</button>}
        {['pending', 'approved'].includes(selected.record.status) && <button className="rounded border p-2" disabled={busy || !csrf} onClick={() => void decide('revoked')}>停止・取消</button>}
      </div>
      <h3 className="font-bold">この申請の監査イベント</h3>
      <ul>{selected.audit.map((e) => <li key={e.id}>{e.at} — {labels[e.event]} — {e.actor}</li>)}</ul>
    </section>}
    <section><h2 className="font-bold">監査一覧（最新200件）</h2>
      <ul>{audit.map((e) => <li key={e.id}><button className="underline" onClick={() => void detail(e.taskId)}>{e.at} — {labels[e.event]} — {e.actor} — {e.taskId}</button></li>)}</ul>
    </section>
  </main>;
}
export const getServerSideProps: GetServerSideProps = (context) => {
  context.res.setHeader('Cache-Control', 'no-store');
  return requireAuth(context, undefined, { skipPreflight: true });
};
