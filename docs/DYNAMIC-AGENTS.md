# Dynamic Agent Instances

## Decision

Delegation creates an **Agent instance**, never selects a pre-created worker
identity. An optional template can contribute instructions and narrower defaults,
but the instance remains a run-scoped, persisted snapshot.

Template selection order is:

1. an explicit user/API selection;
2. a template selected by the parent model from the advertised catalogue;
3. no template, using only the task and the runtime child prompt.

The Composer exposes the first option as a per-message default. That choice is
stored on the root Run, survives queued send/retry/resume, and overrides every
template suggestion made by the model in that delegation tree. Returning from
the Agent settings page refreshes the catalogue so disabled or edited templates
are not offered from stale UI state.

Templates cannot elevate authority. The effective child boundary is the
intersection of the parent Run boundary, the template restrictions, and Runtime
hard-deny policy. One-time approvals, Danger leases, approval overrides and
credential access are never inherited.

## Runtime model

- `AgentTemplate`: reusable, editable metadata. Built-in and user templates use
  the same read model; built-ins cannot be deleted.
- `AgentInstance`: immutable creation snapshot containing its generated id,
  optional template id, effective prompt, tools, permission preset and root
  permission domain.
- `Delegation`: points at an instance and freezes the execution boundary used by
  the child Run.
- `permissionDomainId`: shared by a root Run and descendants only for reusable
  workspace-path/shell-prefix rules. Pending approvals and once grants remain
  bound to the concrete child Run/tool call.
- `RootMutationCoordinator`: serializes mutating tool calls across one Agent
  tree. Completed mutations produce attribution receipts from canonical
  `ToolOutput.changedFiles`.

Serial execution is paired with exact file revisions (`mtime + size + sha256`).
A sibling write based on an older read is rejected as
`file_revision_conflict`; the Agent must read the latest file and re-apply its
intent. Runtime does not silently auto-merge because textual success does not
prove semantic ownership. Mutation receipts identify the responsible dynamic
instance, but are not advertised as universal undo records: destructive and
whole-file operations need bounded preimage snapshots before safe one-click
rollback can be offered.

The maximum recursion depth remains four. Runtime management tools, Provider
secrets, plugin administration, Agent settings and Danger controls are excluded
from child inheritance even when visible to the parent application.

## Cross-platform behavior

Coordination and persistence are implemented in TypeScript/SQLite and are
platform-neutral. File and shell execution still cross the existing Rust system
runtime boundary, so macOS Seatbelt, Linux bwrap and Windows restricted-token
enforcement continue to define the real OS boundary.
