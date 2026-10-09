# ChatGPT ↔ Purplemux MCP Bridge（Phase 1: 読み取り専用）

## 目的と範囲

ChatGPTからNUC上のPurplemuxが管理するHost、Workspace、Codex Chatの現在の状態を確認する。

**現在のMCPツールは読み取り専用**。シェル実行・Codexへの指示送信・会話変更・ファイル操作・権限承認・SSH実行のツールは実装しない。指示送信と結果取得の自動化は別フェーズで追加する。

- `list_hosts`: Local NUCと登録済みSSH Hostの一覧。SSH接続テストはしない。
- `list_workspaces`: HostごとのWorkspace名と作業ディレクトリ、現在の選択。
- `list_codex_tabs`: Workspace内のCodex Chatと従来Codex TUIタブ。
- `get_codex_status`: 既存Codex Chatの実行中／待機中、thread ID、モデル、承認待ち件数等。オプション `includeRecentItems: true` のときのみ、直近10イベントの短いテキストも返す。

**重要:** Codex ChatがPurplemuxの同一Nodeプロセスで起動・接続されていない場合、保存済みthread IDは取得できてもライブ状態は `not_loaded` となる。従来TUIのライブ状態は本APIから取得できない。MCP呼び出しによって新しいCodex／SSHセッションを起動しない。

## 安全な通信構成

```text
ChatGPT （カスタムMCPアプリ）
    │
    │ Secure MCP Tunnel（OpenAIの認可／アウトバウンドHTTPS）
    ▼
tunnel-client （Intel NUC）
    │ stdio / JSON-RPC
    ▼
src/mcp-stdio.ts  （非公開／ローカルプロセス）
    │ Authorization: Bearer <自動生成トークン>
    ▼
127.0.0.1:18223/mcp （src/lib/mcp-bridge.ts）
    │
    ▼
Purplemux Nodeプロセス / Workspace・Codex状態
```

- MCP HTTPポートは**127.0.0.1のみ**で待ち受け。Tailscaleへも公開しない。
- HTTPは認証必須。初回のMCP起動時に `~/.purplemux/mcp-bridge-token` を0600権限で作成する。値はGitやログへ記録しない。
- `tunnel-client` はスタンドアロンのstdioブリッジを起動する。stdioブリッジがローカルトークンを読み取り、同一ホストのMCPエンドポイントへリクエストを転送する。
- ブラウザUIの認証Cookie、Codexログイン情報、SSH秘密鍵をMCPへ公開しない。
- 公開MCPエンドポイントやポート転送は不要。ブラウザは従来どおり `100.64.0.4:8022` へアクセスする。
- MCPから取得したHost名、ファイルパス等の情報は、利用者がChatGPTからツールを呼ぶときにChatGPTへ渡される。プロンプトへの混入や情報公開範囲に注意する。

## NUCでの導入

```bash
cd ~/purplemux
git switch feat/remote-hosts
git pull --ff-only origin feat/remote-hosts

pnpm exec tsc --noEmit
pnpm exec vitest run tests/mcp-bridge.test.ts

# MCP Bridgeを明示的に有効化してPurplemuxを起動
PURPLEMUX_MCP_ENABLED=1 pnpm dev
```

ログに `Read-only MCP bridge enabled on 127.0.0.1:18223` と出れば、ローカルMCPサーバーが起動している。
Web UIは従来どおり8022番を使用する。

必要に応じて別ポートを指定できる：
```bash
PURPLEMUX_MCP_ENABLED=1 PURPLEMUX_MCP_PORT=18224 pnpm dev
```
stdio側を実行するプロセスにも同じ `PURPLEMUX_MCP_PORT` を指定すること。

### ローカル動作確認（ChatGPT接続前）

別ターミナルから：
```bash
cd ~/purplemux

# 登録済みMCPツールの一覧（トークンの表示は不要）
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"local-test","version":"1"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | pnpm exec tsx src/mcp-stdio.ts

# 登録済みHost名を読み取る
printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_hosts","arguments":{}}}' | pnpm exec tsx src/mcp-stdio.ts

# トークンなしではHTTPからアクセスできないことも確認
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:18223/mcp -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# 期待：401
```

## Secure MCP Tunnel（ユーザー操作が必要）

前提：PlatformのTunnels権限、Tunnel用のRuntime APIキー、対象ChatGPT WorkspaceでのカスタムMCPアプリ作成権限。これらはPurplemuxから自動的には付与・作成されない。

1. [OpenAI Platform Tunnels](https://platform.openai.com/settings/organization/tunnels) でトンネルを作成し、`tunnel_id` を得る。対象ChatGPT Workspaceへの関連付けを確認する。
2. [openai/tunnel-client](https://github.com/openai/tunnel-client) の公式手順でNUCへ `tunnel-client` を導入する。ダウンロードURLを推測して実行しない。
3. **NUCのローカルシェルで**Runtime APIキーを環境変数 `CONTROL_PLANE_API_KEY` に設定する。キーはChatGPTのメッセージ・GitHub・スクリーンショットに書かない。
4. NUC側で次のようにstdioプロファイルを構成する：

```bash
tunnel-client help quickstart

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile purplemux-readonly \
  --tunnel-id '<実際のtunnel_id>' \
  --mcp-command '/home/wataru/purplemux/node_modules/.bin/tsx /home/wataru/purplemux/src/mcp-stdio.ts'

tunnel-client doctor --profile purplemux-readonly --explain
tunnel-client run --profile purplemux-readonly
```

5. ChatGPT Webの Plugins → `+` → Add custom MCP server → Connectionで`Tunnel`を選び、対象トンネルを指定する。ツール一覧を確認し、自分のWorkspaceに追加する。UIや提供条件は変更される可能性がある。
6. ChatGPTで「PurplemuxのHostとWorkspaceを一覧にして」と依頼し、`list_hosts`／`list_workspaces` が呼び出されるか確認する。

接続に失敗する場合、`tunnel-client doctor --profile purplemux-readonly --explain`、 `/readyz`、MCP Bridgeのログ、ChatGPT Workspace関連付けを順に確認する。

公式資料：
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [ChatGPT custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server)
- [tunnel-client onboarding](https://github.com/openai/tunnel-client/blob/main/docs/onboarding.md)

## テストと境界

- `tests/mcp-bridge.test.ts`: 初期化、2026年版discovery、ツール一覧、読み取り実行、書き込みツール不在、未対応メソッド、通知・プロトコル不整合を確認。
- **NUC上のNode.jsでの型チェック、テスト、実際のtunnel-client連携は別途実機確認が必要**。
- 新しいツールの公開範囲を増やす場合はレビューが必要。Phase 2の「Codexへのタスク送信」には操作権限・確認・タスクID・再取得API・監査ログを追加する。

## Phase 2（Codexへのタスク送信）の実装

Codexタスクの開始・進捗／結果取得・中断・承認応答は `docs/chatgpt-mcp-phase2.md` に説明があります。**初期状態では書き込みツールは無効**です。NUCでユーザーが明示的に `PURPLEMUX_MCP_ALLOW_WRITES=1` を設定し、Purplemuxを再起動した場合にだけ利用可能になります。

MCP経由のCodex操作は、Next.jsの既存Codex Chat runtimeへ認証付き内部RPCで委譲します。Phase 1のHost/Workspace取得は維持し、Codexタブのライブ状態はブラウザと同一runtimeから読み取ります。従来CLIの操作には対応していません。
