# Codex GUI 統一方針（App Server ベース）

## 決定

Local / Remote を問わず、**Codexタブは Chat を主画面とする**。
既存の Terminal タブは bash / ROS / ビルド / デバッグ専用に残す。
Codex の実行中ログをターミナルエスケープシーケンスから解釈する実装は主経路としない。

既存の Codex TUI が起動しているタブを移行時に強制終了しない。
既存の Local / Remote tmux セッションと通常 Terminal の動作は維持する。

## 正式通信プロトコル

[openai/codex の App Server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) に記載された `codex app-server` の JSON-RPC 2.0（接続時の wire protocol は先頭ヘッダ省略）を利用する。

- 初期化: `initialize` / `initialized`
- スレッドの開始・継続: `thread/start`, `thread/resume`, `thread/list`, `thread/read`
- プロンプト: `turn/start`; 処理停止: `turn/interrupt`
- モデル選択: `model/list`（各ホストの実際の利用可能モデル・推論設定に従う）
- 設定と利用状況: `config/read`, `account/rateLimits/read`, `thread/tokenUsage/updated`
- ストリーミング: `turn/started`, `item/started`, `item/agentMessage/delta`, `item/completed`, `turn/completed`, `turn/diff/updated`, `turn/plan/updated`
- 承認: `item/commandExecution/requestApproval` などの *server-initiated request* を、ユーザーがGUIから承認・拒否できる形で返答する。自動承認は行わない。

型は導入時の `codex app-server generate-ts` から取得する。App Server のバージョン互換性をチェックし、未サポートのGUI項目は非表示にする。

## 構成

```
Browser (PC / iPhone)
  | WebSocket (Purplemux)
Intel NUC: Purplemux backend
  | JSON-RPC broker (per host + tab/thread)
  +-- local Codex app-server (stdio)
  +-- SSH -T -> GMKtec Codex app-server (stdio; initially)
  +-- SSH -T -> other registered hosts (same interface)
```

実行ホストの `cwd`、`threadId`、選択モデル、承認ポリシーをWorkspace/タブへ紐付ける。
モデル・設定はNUC共通値ではなく**ホストごとに検出**する。
SSHホストのポートを外部公開しない。既存の BatchMode SSH 認証を再利用。
stdin/stdoutの1行単位JSONをCLIのログ出力と混同しない。stderrは診断ログとして分離する。

## 画面

- Codex Chat: メッセージ、思考要約（公開される範囲）、計画、コマンド、ファイル差分、テスト結果を `item/*` から逐次描画する。
- 上部: Host / Workspace、モデル、reasoning effort、承認・sandbox設定、実行状態、context / token 利用状況、必要に応じてrate limits。
- 下部: テキスト・画像等の対応する入力、送信、停止、会話切替。PC / iPhone は同じイベント状態とUI設計を共有する。
- 操作途中の承認要求を「許可」「拒否」としてインライン表示し、返答が戻るまでCodexを待機させる。
- Terminal は別タブとして残す。CodexのTUIを日常の操作の前提にはしない。

## 実装順序・完了条件

1. **互換性検査**: NUC / GMKtec の `codex --version` と `codex app-server --help` を確認。JSON-RPC版の対応機能とCLI実行環境を調べる。
2. **Backend broker**: local/SSH双方で initialize, model/list, thread start/resume, turn/start, item stream, approval responseを共通APIにする。
3. **Desktop Chat**: 逐次表示、モデル/effort選択、送信/停止、承認・差分表示。従来TUIセッションは破壊しない。
4. **Mobile Chat**: 同じ状態ストア/イベントを使用し、入力・スクロール・承認・コピーに対応。
5. **持続性**: ブラウザ再接続時に同じthreadへ再参加。サービス再起動時にはthread/resume。処理中のturnを維持するにはリモート常駐App Serverと適切な接続維持を別途検証。
6. **移行**: 新規CodexタブはChat、既存TUI起動中タブはTerminalへのフォールバック。実機試験後に旧UIを整理。

### 注意

`~/.codex/sessions` のJSONLは履歴の補助手段にはなっても、**ライブUIや承認処理の正規APIとして扱わない**。
古い既存のCodex TUIプロセスは、別のApp Serverプロセスへ自動的に再接続できるとは限らない。
フォールバックを残して移行する。
