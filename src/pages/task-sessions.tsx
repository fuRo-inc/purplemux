import { useEffect, useState } from 'react';
import { nanoid } from 'nanoid';
import Head from 'next/head';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import { requireAuth } from '@/lib/require-auth';
import type { TaskSession, TaskSessionAudit } from '@/types/task-session';

const labels = { pending: '承認待ち', approved: '承認済み', rejected: '拒否', revoked: '取消済み', expired: '期限切れ' };
export default function TaskSessionsPage() {
  const [offset, setOffset] = useState(0);
  const [records, setRecords] = useState<TaskSession[]>([]);
  const [selected, setSelected] = useState<{ record: TaskSession; audit: TaskSessionAudit[] } | null>(null);
  const [audit, setAudit] = useState<TaskSessionAudit[]>([]);
  const [csrf, setCsrf] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ purpose: '', hostId: 'local', workdir: '', scope: '', expiresAt: '', idempotencyKey: '' });

  async function request(url: string, body?: unknown) {
    const response = await fetch(url, { cache: 'no-store', ...(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-task-session-csrf': csrf }, body: JSON.stringify(body),
    }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '操作に失敗しました');
    return data;
  }
  async function refresh(pageOffset = offset) {
    const data = await request('/api/task-sessions?offset=' + pageOffset);
    setOffset(pageOffset);
    setRecords(data.records); setCsrf(data.csrfToken);
    const events = await request('/api/task-sessions?audit=1'); setAudit(events.audit);
  }
  useEffect(() => {
    setForm((f) => ({ ...f, expiresAt: new Date(Date.now() + 3600000).toISOString(), idempotencyKey: nanoid() }));
    void refresh().catch((e) => setError(e.message));

    // Refresh always uses GET; no CSRF-dependent mutation in this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = setInterval(() => { void refresh(offset).catch((e) => setError(e.message)); }, 30000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset]);

  async function detail(id: string) {
    setError('');
    try { setSelected(await request('/api/task-sessions?id=' + encodeURIComponent(id))); }
    catch (e) { setError(e instanceof Error ? e.message : '照会に失敗しました'); }
  }
  async function decide(action: 'approved' | 'rejected' | 'revoked') {
    if (!selected || busy) return;
    const record = selected.record;
    if (!window.confirm(`${labels[action]}を記録しますか？\n${record.purpose}\n${record.hostId}: ${record.workdir}\n期限: ${record.expiresAt}\n承認記録のみ、実行権限は未連携`)) return;
    setBusy(true); setError('');
    try {
      await request('/api/task-sessions/' + record.id, { action, confirm: true });
      await refresh(); await detail(record.id);
    } catch (e) { setError(e instanceof Error ? e.message : '操作に失敗しました'); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto max-w-4xl space-y-6 p-6">
    <Head><title>Task Sessions — Purplemux</title></Head>
    <Link href="/" className="underline">Workspaceへ戻る</Link>
    <h1 className="text-2xl font-bold">Task Sessions</h1>
    <p className="rounded border border-amber-500 p-3">承認記録のみ、実行権限は未連携。承認してもCodexの実行権限は変わりません。</p>
    <p>秘密・認証情報は入力しないでください。Host IDとworkdirは既存Workspaceの値を指定してください。期限は24時間以内です。</p>
    {error && <p role="alert" className="text-red-500">{error}</p>}
    <form className="grid gap-3 rounded border p-4" onSubmit={async (e) => {
      e.preventDefault(); if (busy) return; setBusy(true); setError('');
      try {
        const record = await request('/api/task-sessions', form);
        setForm((f) => ({ ...f, idempotencyKey: nanoid() }));
        await refresh(); await detail(record.id);
      } catch (err) { setError(err instanceof Error ? err.message : '申請に失敗しました'); }
      finally { setBusy(false); }
    }}>
      <h2 className="font-bold">新規申請</h2>
      {(['purpose', 'hostId', 'workdir', 'scope', 'expiresAt'] as const).map((field) => <label key={field} className="grid gap-1">
        {{ purpose: '目的', hostId: 'Host ID', workdir: 'workdir（絶対パス）', scope: '対象範囲の説明', expiresAt: '期限（ISO 8601、タイムゾーン必須）' }[field]}
        <input className="rounded border bg-background p-2" required maxLength={field === 'workdir' ? 4096 : field === 'purpose' || field === 'scope' ? 2000 : 120}
          disabled={busy} value={form[field]} onChange={(e) => setForm({ ...form, [field]: e.target.value, idempotencyKey: nanoid() })} />
      </label>)}
      <button disabled={busy || !csrf} className="rounded border p-2">申請する</button>
    </form>
    <section className="space-y-2">
      <h2 className="font-bold">申請一覧（100件ずつ）</h2>
      <button className="underline" disabled={busy} onClick={() => { void refresh().catch((e) => setError(e.message)); }}>更新</button>
      <div className="flex gap-4">
        <button className="underline" disabled={busy || offset === 0} onClick={() => { void refresh(Math.max(0, offset - 100)).catch((e) => setError(e.message)); }}>新しい100件</button>
        <button className="underline" disabled={busy || records.length < 100 || offset >= 4900} onClick={() => { void refresh(offset + 100).catch((e) => setError(e.message)); }}>古い100件</button>
      </div>
      {records.length === 0 && <p>申請はありません。</p>}
      {records.map((record) => <button className="block w-full rounded border p-3 text-left" key={record.id} onClick={() => void detail(record.id)}>
        {labels[record.status]} — {record.purpose}<br />{record.hostId}: {record.workdir}<br />期限: {record.expiresAt}
      </button>)}
    </section>
    {selected && <section className="space-y-3 rounded border p-4">
      <h2 className="font-bold">申請詳細 — {labels[selected.record.status]}</h2>
      <dl className="break-words">
        {Object.entries(selected.record).map(([key, value]) => <div key={key}><dt className="font-bold">{key}</dt><dd className="whitespace-pre-wrap">{value}</dd></div>)}
      </dl>
      <div className="flex gap-3">
        {selected.record.status === 'pending' && <>
          <button className="rounded border p-2" disabled={busy} onClick={() => void decide('approved')}>承認を記録</button>
          <button className="rounded border p-2" disabled={busy} onClick={() => void decide('rejected')}>拒否</button>
        </>}
        {['pending', 'approved'].includes(selected.record.status) && <button className="rounded border p-2" disabled={busy} onClick={() => void decide('revoked')}>取消</button>}
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
