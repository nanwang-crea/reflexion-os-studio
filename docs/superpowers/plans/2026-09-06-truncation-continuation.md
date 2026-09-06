# 截断结果可感知与分页续读 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Agent、Workspace UI 和开发搜索流程明确知道结果被截断，并能通过 offset/nextOffset 继续读取。

**Architecture:** Rust System Runtime 负责稳定排序、分页和截断元数据；contracts 定义跨进程结果；Runtime 工具透传分页并把续读指引暴露给模型；Workspace API/UI 保存分页状态并追加去重。保留所有安全上限，不自动返回无限结果。

**Tech Stack:** TypeScript strict、Zod contracts、React、Rust/Serde、Vitest/Node tests、Cargo tests。

---

## 文件边界

- Modify `crates/system-runtime/src/files.rs`, `handlers.rs`, `params.rs`：目录列表分页与元数据。
- Modify `packages/contracts/src/commands.ts`：workspace.list_dir 分页参数和结果。
- Modify `apps/runtime/src/agent/tools/files-query.ts`：file.list 参数、描述与截断续读提示。
- Modify `apps/runtime/src/handlers-workspace.ts`, `apps/desktop/frontend/api/workspace.ts`：分页透传。
- Modify `apps/desktop/frontend/features/workspace/FileTree.tsx` 及其类型/CSS：加载更多和截断提示。
- Add/modify focused tests under Rust tests, `apps/runtime/test`, `packages/contracts/test`。
- Do not alter the existing `update_plan` implementation; verify it through targeted search/tests.

### Task 1: Establish failing Rust pagination tests

**Files:**
- Modify `crates/system-runtime/src/files.rs`

- [ ] Add tests creating more than one page of files and assert the intended result shape: sorted `entries`, `returnedCount`, `truncated`, and `nextOffset`.
- [ ] Add recursive pagination test asserting stable path order and continuation.
- [ ] Run `cargo test --manifest-path crates/Cargo.toml files::tests` and confirm compile/test failure because the current list returns a bare vector.

### Task 2: Implement Rust list pagination and metadata

**Files:**
- Modify `crates/system-runtime/src/files.rs`
- Modify `crates/system-runtime/src/params.rs`
- Modify `crates/system-runtime/src/handlers.rs`

- [ ] Define serializable `ListResult` with `entries`, `returned_count`/camelCase, `returned_count`, `truncated`, and optional `next_offset`/camelCase.
- [ ] Add `offset` and `limit` request fields with default page size and server maximum.
- [ ] Sort non-recursive entries before slicing; recursively collect, sort, then slice while preserving the hard traversal cap.
- [ ] Mark `truncated` when another page exists or traversal hit the hard cap; calculate `nextOffset` only when continuation is meaningful.
- [ ] Update handler deserialization/serialization without changing workspace boundary checks.
- [ ] Run the focused Rust tests and full `cargo test --manifest-path crates/Cargo.toml`.

### Task 3: Update contracts and Runtime Agent tool

**Files:**
- Modify `packages/contracts/src/commands.ts`
- Modify `apps/runtime/src/agent/tools/files-query.ts`
- Add/modify `apps/runtime/test` focused tool test if an existing SystemRuntime mock is available

- [ ] Add optional `offset`/`limit` to `workspace.list_dir` params and `truncated`, `returnedCount`, optional `nextOffset` to its result.
- [ ] Add `offset`/`limit` to `file.list` tool parameters, normalize non-negative integers, and forward them.
- [ ] Update description to require another call with the same path/recursive and `offset=nextOffset` when truncated.
- [ ] Ensure model-visible structured output retains truncation metadata; do not hide it behind generic text truncation.
- [ ] Add test coverage for parameter forwarding and continuation wording/metadata.
- [ ] Run contracts and Runtime focused tests.

### Task 4: Propagate Workspace pagination

**Files:**
- Modify `apps/runtime/src/handlers-workspace.ts`
- Modify `apps/desktop/frontend/api/workspace.ts`
- Modify relevant workspace types

- [ ] Read `offset`/`limit` from the workspace command, normalize them consistently, and pass them to `file.list`.
- [ ] Return the Rust list metadata unchanged through the command result.
- [ ] Update frontend API signatures and inferred result types.
- [ ] Add handler/API tests proving `nextOffset` is preserved.

### Task 5: Add UI continuation for directory trees

**Files:**
- Modify `apps/desktop/frontend/features/workspace/FileTree.tsx`
- Modify its local types/CSS only if required

- [ ] Store per-directory `nextOffset` and loading state.
- [ ] Render a “加载更多” control when `truncated` and `nextOffset` exist.
- [ ] Request the same directory with `offset=nextOffset`, append entries in stable order, and deduplicate by path.
- [ ] Show an explicit incomplete-result message when truncation has no usable continuation.
- [ ] Add/update component tests if the repository’s frontend test setup supports them; otherwise validate through desktop typecheck and a focused API test.

### Task 6: Audit and test all other truncation boundaries

**Files:**
- Modify only files where a result is currently silently truncated; otherwise add tests in existing test locations.
- Review `crates/system-runtime/src/search.rs`, `shell.rs`, `git.rs`, `apps/runtime/src/agent/toolResults.ts`, workspace indexer and relevant UI consumers.

- [ ] Confirm glob/grep/shell/git/index results expose existing `truncated` fields end-to-end.
- [ ] Add model-visible continuation guidance for results that cannot use offset pagination: narrow glob/grep scope, split by directory/pattern, or rerun with filters.
- [ ] Ensure model result character capping says the response text was capped and does not falsely claim a searchable `nextOffset`.
- [ ] Fix any remaining silent truncation discovered by tests or code audit, with a regression test for each fix.

### Task 7: Verification

- [ ] Run `pnpm format:check`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm --filter @reflexion-os-studio/desktop typecheck`.
- [ ] Run `cargo fmt --manifest-path crates/Cargo.toml -- --check`.
- [ ] Run `cargo test --manifest-path crates/Cargo.toml`.
- [ ] Run focused Runtime/contracts tests and workspace smoke test if dependencies/build artifacts permit.
- [ ] Inspect `git diff` and verify no generated files or unrelated user changes are included.
