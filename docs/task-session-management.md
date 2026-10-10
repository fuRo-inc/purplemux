# Task Session 管理基盤

この実装は申請・承認記録・拒否・取消・期限切れ・監査のみを扱う。
UIには「承認記録のみ、実行権限は未連携」と表示する。
`sessionId` は承認記録の識別子であり、トークンや実行権限ではない。
Codex実行経路、sandbox/approval policy、既存MCP実行ツールの条件は変更していない。
Task Session storeはCodex/PTY/SSH実行APIを呼び出さない。

## データと状態

入力は `purpose`, `hostId`, `workdir`, `scope`, `expiresAt`, `idempotencyKey` のみ。
目的・scopeは空白を除いて1〜2000文字、ID/keyは英数字・ハイフン・アンダースコアで1〜120文字。
workdirは制御文字のない正規化されたPOSIX絶対パス（最大4096文字）。
expiresAtはタイムゾーン付きISO 8601で、申請時から最大24時間。
Host/cwdは既存 `.purplemux/hosts.json` と `workspaces.json` を読み取り、同じhostの既存Workspaceのdirectoryと完全一致することを要求する。
localはdirectoryの存在も確認し、承認直前に再検証する。
remoteは設定照合のみ。SSHによる実在確認やホストの操作はしない。

| 現在 | 可能な遷移 |
| --- | --- |
| pending | approved / rejected / revoked / expired |
| approved | revoked / expired |
| rejected / revoked / expired | なし |

同じ最終判断の再送は同じ記録を返し、監査イベントを増やさない。
pending/approvedは管理storeへのアクセス時に期限切れへ移行する。
バックグラウンド実行やタイマーによる仕事の開始はない。
APIアクセスがない間のファイル状態は遅延更新となるが、次回の照会・判断では期限を必ず評価する。

## 永続化・競合

保存先: `~/.purplemux/task-sessions/records.json`（0600）。新規directoryは0700。
version=1のファイルに申請、監査、source別idempotency keyのSHA-256対応表をまとめて保存する。
監査はtaskId、状態イベント、actor（mcp / gui:user / system）、日時のみ。入力本文や認証情報を監査に複製しない。
原子的renameとファイル・directoryのfsyncを使用する。
申請の追加と監査イベントが異なるファイルに分かれることはない。
JSON破損・schema不整合・シンボリックリンクのrecords.jsonは保存を拒否し、空の状態で上書きしない。

directory作成によるプロセス間ロックで読み取り/期限更新/状態判断/保存を直列化する。
5秒以内にロックを取得できなければ503で失敗し、再送を求める。
所有者の停止を安全に判断できないため、古いロックを自動で奪わない。
クラッシュでlockが残った場合は、全store利用プロセスの停止確認後に管理者によるlockの除去が必要。
ローカルファイルシステム向けであり、複数サーバー・NFS共有・耐改ざん監査にはDB等の設計が必要。

同じsource/key・同じ本文の再送は元の記録（失効後も含む）を返す。
同じkeyで本文を変えると409。本文全体が同じactive申請は別keyでも重複生成しない。
上限は申請5000件、key対応10000件。上限到達で新規申請を拒否し、監査を削除しない。
現在は削除・自動アーカイブ・監査署名はない。

## GUI/API

SidebarのTasksリンクまたは `/task-sessions` から管理画面を開く。
一覧は100件ごと、詳細には対象範囲・期限・申請元・監査を表示する。
明示操作後の確認ダイアログから承認・拒否・取消を記録する。

- `GET /api/task-sessions?offset=0`: 一覧とGUI用CSRFトークン。offsetは0〜5000。
- `GET /api/task-sessions?id=<taskId>`: 詳細と当該申請の全監査。
- `GET /api/task-sessions?audit=1`: 最新200件の監査。
- `POST /api/task-sessions`: 新規申請。
- `POST /api/task-sessions/<taskId>`: `{ "action": "approved" | "rejected" | "revoked", "confirm": true }`。

全GUI APIで既存の有効なlogin Cookie（sub=user）を検証する。
CLI tokenやMCP bearerのみでは利用不可。変更APIはJSON、同一Origin、session-bound HMAC CSRF header
`x-task-session-csrf` を要求する。未知のdecisionフィールドも拒否する。
OriginはHostとhttp/httpsを完全照合する。HTTPS ingressはtrusted proxyとして
`Host` と `X-Forwarded-Proto` を正しく設定し、利用者のforwarded headerを上書きする必要がある。
APIはno-storeで、予期しない例外内容・stack・保存パスをクライアントへ返さない。
現在のPurplemuxは単一ログインユーザーを前提とし、複数ユーザーの所有権/RBACは未実装。

## MCP

既存の認証済みloopback MCP → private runtime RPCに次の管理専用操作を追加。
既存Codex write opt-inが無効でも申請・照会できるが、実行は開始しない。

- `propose_task_session`: 検証済み入力をpendingとして記録。
- `get_task_session`: taskIdで記録と監査を照会。
- `list_task_sessions`: offset（任意）で100件ごとの記録を照会。

MCPのapproval/rejection/revocation操作は存在しない。
`approved`, `confirmApproval`, `status`, `source`, `sessionId`, `sandboxMode` 等の申請フィールドは拒否する。
申請元はサーバーで固定し、GUIのlogin/CSRFトークンをMCPへ公開しない。
GUIの操作境界を認証で分離しているが、login Cookieを持つ利用者の操作が人間のクリックであることを
HTTPレベルで証明する仕組みではない。

## 情報取り扱い

purpose/scopeは平文保存され、GUIと認証済みMCPから照会できる。秘密は入力しない。
代表的なprivate key、Bearer、API key/token/password代入パターンを入力で拒否するが、任意の秘密を
完全検知できるものではない。監査本文は最小化し、拒否入力をログに書かない。
MCPの既存private bearerが漏洩した場合の照会制限やユーザー別所有権は、既存認証モデルの課題として残る。
承認によるHost/cwdの固定は記録時点の照合であり、将来の実行先の安全性を保証するものではない。

## 開発基点と引き渡し

独立clone: `/home/wataru/wataru_ws/purplemux-task-sessions`。
ローカル実装ブランチ: `feat/mcp-task-session-full-access`。
利用可能なローカル基点: `682025e7d82354d5a6d0b73f2f3f4e55cae258ee`。
指定された `d5c83b8b74fd5272af0acad13d0f39e5e944980e` はローカルの両repoにobjectがなく、
GitHubの既存ブランチとのbase整合は未確認。ネットワーク取得・push・本番サービス操作はしていない。
clone元および別repoは編集していない。依存パッケージは独立clone内へコピーして使用する。

最終commitの変更だけを通常端末からGitHubの既存ブランチへcherry-pickし、基点を確認してテスト後にpushする。
本cloneの履歴を既存GitHubブランチへforce pushしない。
独立した新しいcheckoutでの手順例（`<commit>`は最終報告のcommit hash）:

```sh
git fetch origin
git switch -c task-session-review origin/feat/mcp-task-session-full-access
git merge-base --is-ancestor d5c83b8b74fd5272af0acad13d0f39e5e944980e HEAD
git fetch /home/wataru/wataru_ws/purplemux-task-sessions feat/mcp-task-session-full-access
git cherry-pick <commit>
pnpm exec tsc --noEmit --incremental false
pnpm test
git push origin HEAD:feat/mcp-task-session-full-access
```

基点チェック失敗やcherry-pick競合時には既存ブランチの内容を確認・解消してから進める。
他のマシンへ引き渡す場合は `git format-patch -1 --stdout <commit>` を移送して適用できる。
各commitメッセージ末尾に `[skip ci]` を付ける。

## 検証

`pnpm exec tsc --noEmit --incremental false`、対象Vitestと全Vitestを実行する。
新規境界テストは不正入力、Host/cwd、TTL、期限切れ、重複、並列store/別プロセス、
approve/reject競合、保存失敗、破損、symlink、unauth、Origin/CSRF、MCP自己承認拒否を扱う。
`tests/setup.ts` の共通logger mockで、既存unit testがユーザーのproductionログを開くことも防ぐ。
本番server・GUIブラウザーの起動検証は行っていない。
