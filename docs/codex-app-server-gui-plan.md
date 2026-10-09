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

## 2026-10-09: 過去セッションの検索・再開

- `/api/codex-app/sessions`: ログイン済みの App Server から `thread/list` をページ単位で取得する。現在のWorkspaceに登録したHost内の履歴に限定され、別Hostの `~/.codex` を参照しない。
- 一覧は会話の冒頭文（`preview`）、作業ディレクトリ（`cwd`）、モデル、更新日時、セッションIDを表示する。
- 検索対象は「このHostの会話」または「この作業ディレクトリのみ」。検索対象は冒頭文／作業パス／モデル／IDであり、**現時点では全メッセージ本文の全文検索ではない**。
- 続きから開始するときは `thread/resume` → `thread/read` により既存スレッドの履歴を読み、タブの保持する `threadId` を更新する。失敗時には旧セッションを保持する。
- 既存セッションは削除しない。別ディレクトリのセッションを選んだ場合は、元の `cwd` で実行されることを確認してから再開する。
- PC・スマートフォンは共通の `CodexSessionPicker` を使用し、Chat上部の「以前の会話」から開く。
- 大量の履歴にはページングで対応する。会話の表示は直近35ターン（最大160項目）に限定されるが、Codexがresumeする会話コンテキストそのものはGUI表示件数で切り詰めない。
- 別プロセスで進行中のCodex TUIと同一スレッドを同時操作するケースは未検証。実行中／承認待ちの現在のChatからは履歴の切り替えを禁止する。

### 追加検証

1. `pnpm exec tsc --noEmit` を実行して型エラーがないことを確認する。
2. NUCのLocal Workspaceで「以前の会話」を開き、以前のTUI／Chatの履歴を探す。
3. 「この作業ディレクトリのみ」へ切り替え、ディレクトリの異なるセッションを除外できることを確認する。
4. 履歴を選択し、過去メッセージが表示された状態で `前回の内容を要約してください。ファイル変更はしないでください。` と送信し、同じ会話が継続することを確認する。
5. 別作業ディレクトリの会話選択で確認画面が出ることを確認する。
6. GMKtec Remote Workspaceでも同様に操作し、検索対象がGMKtec側の履歴であることを確認する。
7. ブラウザを再読み込みし、同じ `threadId` の会話に復帰できることを確認する。

## 2026-10-09: Codex標準ライクな履歴・Permissions・Fast

- 過去セッション検索を **cwdごとのグループ一覧** に変更し、Codex CLIのResume画面に近い Tasks / Status / Updated の密度で表示する。
- 各作業ディレクトリは直近6件を表示し、`Show more` で展開する。マウスクリックに加え、↑↓・Enterに対応。
- StatusはApp Serverの実データ（`thread.status`）から `idle→Ready`, `active→Running`, `notLoaded→Inactive`, `systemError→Error` に対応させる。推測で実行状態を生成しない。
- 検索・ページング、Hostとcwdの絞り込み、異なるcwdを再開するときの確認は従来どおり維持する。
- Chatヘッダに `Permissions` (read-only/workspace-write/danger-full-access) と `Approval` (on-request/never) を追加。標準は **workspace-write + on-request**。Full Access選択時には確認ダイアログを表示する。
- 既存スレッドの権限更新は `thread/settings/update` に `sandboxPolicy` と `approvalPolicy` を渡し、次の実行へ反映する。新規スレッドとresumeもGUI上の選択を適用する。
- モデル `model/list.serviceTiers` がfastを通知する場合のみFastを操作可能にする。**新規会話ではFast OFF**。Fast OFFの場合は `turn/start.serviceTierForTurn="default"`、ONの場合は `"fast"` として、過去セッションの速度設定を無意識に引き継がない。
- 保存設定は `~/.purplemux/codex-app-sessions` のタブごとのJSON。非対応のホストではFastのONを禁止する。
- App Server本体はNUC `0.160.1` / GMKtec `0.162.0` を想定。両リリースのv2プロトコル定義で上記フィールドを確認したが、**ビルド・実機検証は未実施**。

### 確認項目

1. `pnpm exec tsc --noEmit` がエラーなしで終了する。
2. 「以前の会話」でcwdごとのグループとStatus/Updated列が表示される。矢印キー・Enter・Show more・検索が正しく機能する。
3. LocalとGMKtecでPermissionとApprovalを変え、次のターンで選択が反映される。Full Accessには明示確認がある。
4. Fastは対応モデル以外では操作不可。新規会話でOFF、ONにしたときのみfast層をリクエストする。
5. 履歴から再開してもモデル・cwd・権限の状態がUIと実行に一致する。
