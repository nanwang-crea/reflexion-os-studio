# Run 错误与重试事件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every Run retry and final failure as independent session timeline events, display details immediately, and restore them after restart.

**Architecture:** Add a dedicated `run_events` store domain and include its session-scoped records in the existing session snapshot. Runtime writes retry/failure records at the same points it emits events; frontend maps records by `runId` and renders independent timeline cards while retaining live notices and RunActivity.

**Tech Stack:** TypeScript, Zod contracts, Node `node:sqlite`, React, existing runtime-client/Tauri transport, Vitest-style project tests.

---

### Task 1: Define the persisted run-event contract and storage schema

**Files:**

- Modify: `packages/contracts/src/entities.ts`
- Modify: `packages/contracts/src/events.ts`
- Modify: `apps/runtime/src/store/migrations.ts`
- Create: `apps/runtime/src/store/runEvents.ts`
- Modify: `apps/runtime/src/store/index.ts`
- Test: existing contracts/runtime store test locations discovered with `Glob` before implementation

- [ ] Add `RunEventTypeSchema` and `RunEventSchema` with `id`, `sessionId`, `runId`, `type`, `attempt`, `maxRetries`, `reason`, `errorCode`, `errorMessage`, and `createdAt`; use nullable fields for values not applicable to the event type.
- [ ] Add `runEvents` to the existing session snapshot response schema and event union only where required by transport validation.
- [ ] Add `run_events` DDL and session/run indexes to the current schema/migration version without modifying existing message semantics.
- [ ] Implement `RunEventsStore` with `createRetrying`, `createFailed`, and `listBySession`, using parameterized SQL and the existing `nowIso`/row conversion conventions.
- [ ] Expose the store through `Store`, preserving `store/index.ts` as the facade.
- [ ] Add failing tests for schema parsing, insertion, ordering, and session cascade; run the focused tests and confirm failure before implementation, then rerun to pass.
- [ ] Commit: `feat:持久化运行错误事件`

### Task 2: Return events in session snapshots and write them from the runner

**Files:**

- Modify: `apps/runtime/src/handlers.ts:session snapshot handler`
- Modify: `apps/runtime/src/agent/runner.ts:retry and failure paths`
- Modify: `apps/runtime/src/agent/index.ts:session data assembly if needed`
- Modify: `apps/runtime/test/*` relevant runner/handler tests

- [ ] Extend the existing session snapshot response with `runEvents: store.runEvents.listBySession(sessionId)`.
- [ ] At each `run.retrying` emission, persist one retrying record containing the exact attempt, maxRetries, and reason before/alongside emission.
- [ ] At final failure, persist one failed record containing normalized `error.code` and complete safe `error.message`; preserve existing finalization and notification behavior.
- [ ] Ensure persistence exceptions do not replace the original provider failure; use the existing runtime logging/error path and still emit `run.failed`.
- [ ] Add tests proving multiple retry records and one failure record survive a fresh store/session snapshot.
- [ ] Run focused runtime tests and commit: `feat:记录运行重试与失败`

### Task 3: Carry persisted events through frontend state and live notices

**Files:**

- Modify: `apps/desktop/frontend/hooks/useAppBootstrap.ts`
- Modify: `apps/desktop/frontend/App.tsx` or session-data types only if required
- Modify: `apps/desktop/frontend/features/chat/ChatView.tsx`
- Create: `apps/desktop/frontend/features/chat/RunEventCard.tsx`
- Modify: relevant frontend test files

- [ ] Add `runEvents` to the session data type/state loaded from the runtime snapshot, defaulting safely for older snapshots.
- [ ] On live `run.retrying`, preserve the existing RunActivity and show a non-blocking alert/notice with attempt, maxRetries, and reason.
- [ ] On live `run.failed`, call `setNotice` with code and full message, while retaining failed-session state and refresh behavior.
- [ ] Render `RunEventCard` as an independent timeline item keyed by event id, with distinct retry and failure content and accessible alert semantics for failures.
- [ ] Merge event cards into chronological chat blocks by run id without turning them into ordinary `Message` records; ensure restored snapshot events render identically to live events.
- [ ] Add frontend tests for live notice, retry/failure card rendering, and snapshot restoration.
- [ ] Run focused frontend tests and commit: `feat:展示运行错误事件`

### Task 4: Correct RunBlock and assistant failure presentation

**Files:**

- Modify: `apps/desktop/frontend/features/chat/RunBlock.tsx`
- Modify: `apps/desktop/frontend/features/chat/AssistantMessage.tsx`
- Modify: matching feature CSS file
- Modify: frontend component tests

- [ ] Extend RunBlock props with the final failed event/error data needed to distinguish failed, cancelled, active, and completed states.
- [ ] Render `运行失败` instead of `处理完成` for failed runs, while retaining active retry wording and duration for successful runs.
- [ ] Render assistant failure status as `错误码：<code>；<message>` and keep the retry action available.
- [ ] Keep existing interrupted status and completed usage display unchanged.
- [ ] Add regression tests covering failed RunBlock labels, detailed assistant errors, and retry button behavior.
- [ ] Run focused frontend tests and commit: `fix:完善运行失败提示`

### Task 5: Full verification

**Files:**

- No source changes unless verification reveals a defect

- [ ] Run `pnpm format:check`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm --filter @reflexion-os-studio/desktop typecheck`.
- [ ] Run `pnpm build:packages`.
- [ ] Run `cargo fmt --manifest-path crates/Cargo.toml -- --check`.
- [ ] Run `cargo test --manifest-path crates/Cargo.toml`.
- [ ] Run `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`.
- [ ] Report any unavailable or failing command accurately; do not claim completion without recorded output.
