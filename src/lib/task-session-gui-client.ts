/** Browser management only. A failed mutation is never automatically replayed. */
export class TaskSessionGuiClient {
  private csrf = '';

  constructor(private readonly onCsrf: (token: string) => void) {}

  async request<T>(url: string, body?: unknown): Promise<T> {
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-task-session-csrf': this.csrf }, body: JSON.stringify(body),
    }) });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 403 && body !== undefined) {
        this.csrf = ''; this.onCsrf('');
        try {
          // The proxy may have refreshed the HttpOnly cookie on the failed POST.
          await this.request('/api/task-sessions');
        } catch {
          throw new Error('認証情報の更新に失敗しました。画面を更新して状態を確認してください。操作は自動再送していません。');
        }
        throw new Error('認証情報を更新しました。最新の状態を確認し、もう一度操作してください。操作は自動再送していません。');
      }
      const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error :
        response.status === 413 ? '入力サイズが上限を超えています（HTTP 413）。' : `操作に失敗しました（HTTP ${response.status}）。`;
      throw new Error(message);
    }
    if (!data || typeof data !== 'object') throw new Error('APIからの応答を読み取れませんでした。画面を更新して状態を確認してください。');
    if ('csrfToken' in data && typeof data.csrfToken === 'string') {
      this.csrf = data.csrfToken; this.onCsrf(this.csrf);
    }
    return data as T;
  }
}
