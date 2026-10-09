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

## 2026-10-09: App Server Chat の初期実装（未検証）

- NUC: `codex-cli 0.160.1`、GMKtec: `codex-cli 0.162.0` で `codex app-server --help` が使用できることをユーザーが確認。
- `src/lib/codex-app-gui.ts` で JSON-RPC の初期化、`model/list`、`thread/start`／`thread/resume`／`thread/read`、`turn/start`／`turn/interrupt`、イベント受信、command/file-change承認を試作。
- Local は `codex app-server`、Remote は登録済みSSH認証を利用した `ssh -T ... bash -lic 'exec codex app-server'` で起動。SSH先へTCPポートを追加公開しない。
- `/api/codex-app/events` で状態をSSE配信、`/api/codex-app/action` で操作。PC／iPhoneは同じ `CodexAppChatPanel` を使用。
- 新規Codexタブは `codex-chat`。従来 `codex-cli` は引き続きTUI互換として残す。
- `~/.purplemux/codex-app-sessions` にtab単位でthread IDとモデル設定を保存する。Nextサーバー再起動後にthread/readによる会話履歴復元を試行する。
- Codexの実行中にブラウザを閉じても、PurplemuxのNodeプロセスが稼働している限りChildProcessは維持される。ただしNodeプロセス自体の再起動中に実行中turnを維持する保証はまだない。
- モデル選択、Thinking選択、Chat送信、逐次メッセージ表示、コマンド表示、承認・拒否の初期UIを実装。詳細diff表示、context/statusの全面統合、画像添付、履歴のページング、変更前後の構成比較は未実装。
- **現時点ではNUC／GMKtec上のビルド・動作テストは未実施。**

### スモークテスト

1. NUCで `git pull --ff-only origin feat/remote-hosts`、`pnpm exec tsc --noEmit` を実行しエラーがないことを確認。
2. `pnpm dev` で起動し、Local Workspaceの新規Codex Chatでモデル一覧、Thinking、送信、回答のストリーミングを確認。
3. GMKtecのRemote Workspaceでも同じ操作を実行し、CodexがGMKtec側の作業ディレクトリで動くことを確認。
4. ファイル変更・権限承認を伴う依頼を試し、承認カードと拒否・許可を検証。
5. PCで新規Chat→ブラウザ再読み込み→同じthreadIdと履歴を確認。iPhoneから同じタブへアクセスした場合も表示が同期することを確認。
6. 既存のCodex TUIタブと通常Terminalが従来どおり動くことを確認。
