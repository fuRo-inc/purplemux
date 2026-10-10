# GUI-approved Task Session execution

An authenticated ChatGPT MCP client proposes a development task. The logged-in Purplemux user reviews its purpose, scope, Host, cwd, workspace/tab, Full Access warning and expiry, then approves or rejects it in `/task-sessions`. The normal UI has no manual proposal form. Sidebar Tasks shows a pending count, refreshed every 30 seconds. Session state, bounded turn metadata and audit history appear on the Tasks page, also polled every 30 seconds.

## MCP workflow

1. Use `list_workspaces` / `list_codex_tabs` to choose a registered Codex Chat tab and exact target.
2. Call `propose_task_session` with `purpose`, `scope`, `hostId`, `workdir`, `workspaceId`, `tabId`, `requestedPermissions: "full-access"`, `ttl` (seconds, 1–86400) **or** `expiresAt`, and `idempotencyKey`.
3. Wait for authenticated GUI approval. There is no MCP approval tool. `confirmFullAccess`, approval/source/status fields and other unknown proposal/turn fields are rejected.
4. Call `run_task_session_turn` with `taskId`, the same `hostId`, `workdir`, `workspaceId`, `tabId`, `instruction` (1–16000 characters), and a unique `idempotencyKey`. A durable reservation is saved before asynchronous Codex setup. Retry the identical request with the same key; it never injects another turn.
5. Poll `get_task_session`. `status: approved` plus `executionState: idle` means another turn may run. Reuse the target, with a new instruction and key for fixes/retraining/etc. The first turn gets a dedicated new thread; further turns pin that thread. Normal work within the approved development task continues without repeated permission requests.
6. `get_task_session(includeOutput: true)` optionally reads the last live assistant result, capped at 6000 characters, from the pinned idle leased thread. It never starts Codex, includes no command stdout/history from earlier turns, and persists no output. It returns null after lease release/restart or when the exact result is unavailable. Normal record queries include only hashes and execution metadata.
7. Use `finish_task_session` to finish, or `finish_task_session(revoke: true)` to cancel. GUI users can also finish or stop/revoke. Neither operation grants permissions. `list_task_sessions` provides pages of 100 records.

Existing `start_codex_task` read-only/workspace-write behavior and PR1 per-turn permission restoration remain supported. Its target/write confirmation requirements are unchanged.

## Execution authority

Full Access execution defaults OFF. Both administrator environment opt-ins must be set in the Next runtime:

```
PURPLEMUX_MCP_ALLOW_WRITES=1
PURPLEMUX_MCP_ALLOW_FULL_ACCESS=1
```

Proposal and GUI approval are permitted with these flags OFF, but execution is rejected; the GUI displays 「実行権限は未有効」. No MCP argument substitutes for either administrator opt-in or GUI approval.

GUI mutations require the existing login Cookie (sub=user), JSON, exact same Origin and session-bound HMAC CSRF header. MCP/CLI bearer authentication cannot call the decision route. The GUI sends warning confirmation only after displaying the Full Access risk and a user confirmation dialog. This authenticates a logged-in user's HTTP action; HTTP cannot prove a physical human click. Purplemux's existing single-user login model remains the trust boundary.

Approval is bound to purpose/scope and the registered Host/cwd/workspace/tab, with a TTL of at most 24 hours. The store checks approval, warning acknowledgement, target, registration, opt-ins and expiry on every reservation and immediately before each turn. Records from PR2 lacking workspace/tab/permissions/warning acknowledgement remain readable but never execute; they require a fresh proposal and GUI review.

The runtime's session lease saves GUI permissions, pins the thread and expires automatically. While leased, manual GUI submission, settings, thread changes and legacy MCP tasks are blocked. Existing GUI Codex approval choices (including acceptForSession) remain available. Successful `turn/completed` sets busy=false while retaining the lease. Before each `turn/start`, `thread/settings/update` must confirm effective `sandboxPolicy.type=dangerFullAccess` and `approvalPolicy=never`. Unsupported, missing or inconsistent confirmation fails closed; CLI versions must support this response shape.

Finish/revoke invalidates durable authority before releasing runtime permissions. An active turn receives an interrupt; if it has not completed when acknowledged, the app-server connection is terminated instead of restoring permissions during an uncertain running turn. Idle release restores settings by acknowledged RPC. Expiry interrupts an identifiable active turn with a bounded 5-second request, then disconnects; uncertain setup disconnects immediately. Failed/interrupted/unknown turns, failed RPC/setup/restoration, process exit and storage errors revoke execution. Restart makes previously owned idle/running sessions revoked/unknown. Resuming requires a fresh GUI-approved proposal. Codex child processes also omit `__NEXT_PRIVATE_STANDALONE_CONFIG` so their development builds do not inherit Purplemux's standalone Next configuration. Saved GUI settings never acquire the session's Full Access values; the existing deliberate GUI permissions are preserved.

## Durability and concurrency

The version=1 atomic JSON remains backward compatible with PR2 records. Optional fields add target, warning acknowledgement, execution state, process ownership, pinned thread and turn metadata. Approval status is separate from `idle/running/unknown/complete` execution state. A stable process identifier and runtime lease map are shared across Next API bundles. Restart changes the process identifier; old execution authority is not reused.

`~/.purplemux/task-sessions/records.json` uses private permissions, file and directory fsync, atomic rename and the existing filesystem directory lock. Proposal and turn keys are SHA-256 hashes. Reservations serialize across writers. Same-key/same-input retries return the existing turn; conflicting inputs fail. A running turn blocks another turn, and an idle owned session excludes another session from the same tab. The runtime separately enforces exclusive ownership against browser/legacy activity. No automatic retry executes an uncertain turn.

Audit events record actor, time, instruction hash, reservation/Codex turn IDs, thread ID and result. Raw turn instructions, command stdout, final assistant output and arbitrary exception messages are not saved. `instructionPreview` is an explicit omission marker to avoid persisting secrets. Purpose/scope are still plain text; common credential patterns are rejected but arbitrary secrets cannot be detected perfectly. Do not place secrets there.

Limits: 5000 records, 10000 proposal keys, 25000 audit events, 1000 turns/session; new turns stop before audit capacity is exhausted. No automatic archival/deletion. Corrupt/schema-invalid JSON and symlinked storage fail closed. A crash during a filesystem transaction may leave the existing lock directory. It is never stolen automatically: an administrator must first confirm all store writers are stopped before removing a stale lock. This is local filesystem storage, not a multi-server/NFS database or tamper-proof audit log.

## Technical boundaries and handoff

`danger-full-access` can access files and commands throughout the selected host's Linux user account. Host/cwd/scope checks bind the execution target and instructions; they do **not** enforce an OS boundary around the repo or prevent other devices from being contacted by commands. Each instruction includes purpose/scope/target and an explicit prohibition on unrelated deletion or substantial operations on other devices. The GUI states these limits before approval. Interrupting/killing the app-server is best effort; detached commands, SSH descendants or commands already completed cannot be undone or guaranteed terminated by this mechanism.

Implementation/tests run only in `/home/wataru/wataru_ws/purplemux-task-runtime`, branch `feat/mcp-task-session-execution`, based on `0640fd100791ce09b0c1f73a49956cb3c3fbf6a2`. No push, CI, production settings/service operations, real Codex execution or GPU/training commands are performed. Runtime tests use mocks and temporary test stores. Before deployment, manually verify the actual Codex settings response, browser workflow, restart/interrupt behavior and build in a normal terminal. This checkout is a reviewable development artifact, not a production installation.

## Local validation results

| Check | Result |
| --- | --- |
| `tsc --noEmit --incremental false` | Passed |
| `eslint` | Passed, 0 errors / 5 existing warnings |
| `vitest run` | 30 files / 295 tests passed (253 prior tests retained, 42 added) |
| `npm run build:server` | Passed (`tsup` server bundle) |
| `npm run build` with inherited standalone config removed | TypeScript passed; default Turbopack remained in optimization without progress for several minutes; this development build process was interrupted |
| `next build --webpack`, both inherited standalone config and `TURBOPACK` removed | TypeScript and compilation passed; page-data collection failed (`/tools-required` on one attempt, `/login` on the final attempt). Full Next build remains unverified |

No escalation, CI, push, service restart/stop, real Codex or GPU commands were used. Full production build, actual Codex effective-settings response, browser approval/continuation and process/SSH interruption require a separate human verification in a normal environment. The page-data failure's underlying cause has not been established; it is not claimed to be a compiler error or a confirmed bind EPERM.
