# ChatGPT ↔ Purplemux Phase 2 — Codexタスク操作

Phase 1の読み取り専用Bridgeを拡張し、ChatGPTから既存のCodex Chatタブへ作業を依頼して、結果を後から取得する。

> **重要:** コードをpullするだけではCodex操作は有効にならない。NUCで `PURPLEMUX_MCP_ALLOW_WRITES=1` を明示して起動した場合に限り、ChatGPTから実行・中断・承認のツールを公開する。十分に確認するまではOFFのままにする。

## 実装と安全境界

- **ブラウザとMCPは同一のCodex App Server runtimeを使用する。** `src/pages/api/mcp-internal.ts` を介し、ブラウザを提供するNext.jsプロセスの既存タブにアクセスする。Next standaloneの別プロセスにも対応。
- 内部APIはNUCループバックと起動ごとに生成するトークンで認証し、外側のブラウザ用8022番ではルーティングしない。通常のWebセッションCookie・CLI汎用トークンから内部APIを利用できない。
- MCP自体のアクセス経路は既存の `127.0.0.1:18223/mcp` かつ独立した0600トークンのstdio Bridgeのみ。
- タスク送信には **Workspace ID・CodexタブID・Host ID・作業ディレクトリ・明示的な確認**がすべて必要。Hostまたはcwdが変わったら送信拒否。
- CodexのSandboxは `workspace-write`、承認方式は `on-request` に強制する。既存のGUIがFull AccessだったとしてもMCP送信前に安全な設定へ変更。
- 実際のファイル変更・シェルコマンドはCodex App Serverの実行機能に依存。MCP自体に任意のシェルツールは置かない。承認要求は自動許可しない。
- ChatGPTのMCPツールには `readOnlyHint`／`destructiveHint` を適切に付与。書き込み系の操作はChatGPT画面で内容を確認して許可する。
- タスク記録は `~/.purplemux/mcp-tasks/<taskId>.json` に0600権限で保存。実際のprompt全文は保存せず、短い冒頭文とSHA256を保存する。結果要約・変更ファイル・差分冒頭（最大32KB）・承認の時刻とコマンドハッシュを記録。
- タスクIDは応答後の進捗確認に使用し、同期的に作業完了を待たない。ChatGPT側のセッションを開いたまま維持する必要はない。

## 利用できるツール

| ツール名 | 初期状態 | 概要 |
|---|---|---|
| `list_hosts`／`list_workspaces`／`list_codex_tabs` | 読み取り | 実行先候補の確認 |
| `get_codex_status` | 読み取り | Codexタブの実行状況 |
| `list_codex_tasks` | 読み取り | MCPから起動したタスクの一覧 |
| `get_codex_task` | 読み取り | 状態・結果・差分・承認待ちを取得 |
| `start_codex_task` | **明示有効化** | 既存Codex Chatで作業を開始 |
| `interrupt_codex_task` | **明示有効化** | 対象タスクの実行中のturnのみを中断 |
| `respond_codex_approval` | **明示有効化** | 正確なrequestIdとコマンドを再検証し承認／拒否 |

`list_codex_tabs` と `get_codex_status` は内部RPCでNext.jsプロセスから取得するため、ブラウザUIに読み込まれたCodexの現在の状態を反映する。MCPの読み取りリクエストだけで新しいCodexプロセスを起動しない。

## 1. 読み取り互換性・コード確認

```bash
cd ~/purplemux
git pull --ff-only origin feat/remote-hosts
pnpm exec tsc --noEmit
pnpm exec vitest run tests/mcp-bridge.test.ts tests/mcp-codex-tasks.test.ts
```

テストではCodex・SSHの実行をすべてモックする。GitHub Actionsを起動する必要はない。

Phase 1のまま起動した場合、新たに2つの読み取りツール（`get_codex_task`, `list_codex_tasks`）が追加される一方、書き込みツールは非公開。

## 2. 明示的にMCP経由のCodex操作を有効化する

一度ユーザーがコードをレビューし、テスト環境で有効化を認めた段階で、Purplemuxを停止して次の環境変数で再起動する。

```bash
cd ~/purplemux
PURPLEMUX_MCP_ENABLED=1 PURPLEMUX_MCP_ALLOW_WRITES=1 pnpm dev
```

既存のMCPローカルトークンはそのまま利用できる。別のトンネルを作り直す必要はないが、ChatGPTのカスタムアプリの**ツールを再検出**する。反映しない場合、単一の `tunnel-client run` を停止→再起動し、再接続する。stdioで同一トンネルIDの複数同時実行は禁止。

無効化するには停止後、 `PURPLEMUX_MCP_ENABLED=1 pnpm dev` で再起動する。書き込みツールは再び非公開になる。ブラウザGUIは従来どおり利用可能。

## 3. ChatGPT経由のテスト（最初は読み取りだけ依頼）

1. 「PurplemuxのWorkspaceとCodex Chatを列挙して」と依頼し、実行先のHost ID、Workspace ID、タブID、実際のcwdを確認。
2. 変更しても問題ない開発／シミュレーションのWorkspaceで「このタブの現在の状態を確認」と依頼。
3. 操作ツール有効化後、最初は「作業ディレクトリとGit状態を調べ、ファイルの変更はしない」という**読み取りのみの指示**をCodexへ出す。MCP自身のツールは変更可能なため、送信先と権限を画面で確認する。
4. `start_codex_task` が返した `taskId` を使い、`get_codex_task` で進行状況を確認する。結果本文は `includeOutput:true`、差分は `includeDiff:true` で明示的に要求する。
5. 実行中に承認が必要になったら `get_codex_task(includeOutput=true)` で requestId / command を確認し、人間が判断した後だけ `respond_codex_approval` で応答する。人間の指示のない承認を自動で行わない。
6. キャンセルは `interrupt_codex_task`。完了したかは `get_codex_task` で再確認する。

## タスクの状態

- `queued`：要求を受け付け、処理開始待ち。
- `starting`：Host側のCodex起動・設定中。
- `running`：実行中。進捗は `get_codex_task(includeOutput=true)` で確認。
- `awaiting_approval`：人間の承認要求がある。自動承認しない。
- `completed`：Codexのturn完了を観測。
- `failed`／`interrupted`：Codexが失敗／中断を通知。
- `unknown`：Purplemuxの再起動やセッション切替等で状態の継続追跡ができない。**完了したとも中断したとも断定しない。**

Codexの `turn/diff/updated` が提供する差分のみ保存する。差分がないときは空文字と `diffAvailable:false` とし、変更がなかったと断定しない。

## 既知の制約とフォローアップ

- 初期版では**既存のCodex Chatタブのみ**が対象。旧Codex TUIやタブ自体の新規作成は対象外。
- `mode:new` は既存タブを新しいthreadへ切り替えるため、明示的に新規threadを要求した場合のみ使う。既定は既存threadの継続。
- 異なるHostから別プロセスが同じタブを実行するような構成は未サポート。通常のブラウザUIとMCPが一つのNext runtimeを共有することが前提。
- すでに実行中のGUI作業に対してタスク送信は拒否する。既存のGUIから設定を変える操作との完全な競合制御は今後の強化対象。
- ChatGPT側は自動プッシュ通知ではなく、必要なタイミングで `get_codex_task` を呼び直す。
- `unknown` になった古いタスクの再関連付けや永続的なジョブキューは未対応。
- NUC／GMKtec実機での実行とTypeScript検査はまだ行っていない。まずコード検証→NUC型チェック→シミュレーションWorkspaceで非変更タスクの順に検証する。
