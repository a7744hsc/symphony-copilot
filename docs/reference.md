# Reference

Details that the [README](../README.md) leaves out. Section numbers (§) refer to the [Symphony spec](https://github.com/openai/symphony/blob/main/SPEC.md).

## Source layout

| File | Responsibility (spec sections) |
|---|---|
| `src/workflow.ts` | Reads, parses and watches `WORKFLOW.md`; keeps the last valid config when an edit is invalid (§5, §6.2) |
| `src/config.ts` | Typed config with defaults, `$VAR`, `~` and relative paths (§6) |
| `src/template.ts` | Liquid in strict mode: unknown variables and filters are errors (§5.4, §12) |
| `src/orchestrator.ts` | The only scheduling state: polling, dispatch, reconciliation, stall detection, retries (§7, §8, §16) |
| `src/workspace.ts` | Workspace naming, root containment, the four hooks (§9) |
| `src/runner.ts` | Copilot SDK session and the multi-turn loop (§10, §16.5) |
| `src/policy.ts` | Permission decisions for agent tool calls (§10.5, §15) |
| `src/tracker/github-project.ts` | GitHub Project adapter and the agent tools (§11) |

## From Codex app-server to the Copilot SDK

| Spec concept | This implementation |
|---|---|
| `codex app-server` subprocess | One `CopilotClient` per worker, which starts the CLI bundled with the SDK (or `copilot.cli_path`) over stdio |
| Thread and turn | The `sessionId` from `createSession({ workingDirectory: workspace })`; one turn is one `send()` until the main agent's `session.idle` |
| `session_id` | `<sessionId>-<turn>` |
| Continuation | Another `send()` of `agent.continuation_prompt` in the same session |
| Turn failed or cancelled | `session.error`, or `session.idle` with `aborted` |
| `turn_timeout_ms` | Longest silence between two session events; the turn is aborted after it |
| Token accounting | Sum of `assistant.usage`, reported as session totals; the orchestrator only counts the increase |
| Rate limits | Snapshot from `account.getQuota` |
| `codex` config block | `copilot` config block |

When a session ends, the log line `session usage` reports `premium_requests` and `ai_credits` for that session.

## GitHub Project adapter (`tracker.kind: github_project`)

### Settings under `tracker.provider`

Required: `owner`, `project_number`, `repo` (as `owner/name`).

Optional, with defaults:

| Key | Default | Meaning |
|---|---|---|
| `owner_type` | `user` | Or `organization` |
| `token` | `$SYMPHONY_GITHUB_TOKEN` | Secret; an empty value counts as missing |
| `endpoint` | `https://api.github.com/graphql` | GraphQL endpoint |
| `status_field` | `Status` | Single-select field that holds the state |
| `priority_field` | `Priority` | Single-select or number field |
| `identifier_prefix` | `GH-` | Prefix for issue identifiers in logs and prompts |
| `branch_prefix` | `agent/` | Prefix for agent branches |
| `agent_states` | None | States the agent may set with `tracker_set_status`; without it, that tool is not offered |
| `handoff_state` | None | State set by `tracker_submit_for_review`; without it, the state is left alone |
| `blocked_state` | None | State the orchestrator moves a card to when its run reaches a [run limit](../README.md#run-limits); without it, the card stays where it is and is skipped until someone moves it |

A bad setting is reported as `invalid_tracker_config`, and a missing token as `missing_tracker_secret`.

### Scope

Only issues in this project that come from `repo` are considered. Drafts, pull requests and issues from other repositories are ignored. State queries fetch 100 items per page, up to 100 pages. ID queries fetch 100 items per batch.

### Field mapping

| Field | Value |
|---|---|
| `id` | Project item ID |
| `native_ref` | `project_item_id`, `issue_id`, `issue_number`, `repository` |
| `identifier` | `GH-<number>` |
| `branch_name` | `agent/<number>` |
| `state` | Name of the Status option; `No Status` if unset |
| `priority` | The number in a single-select name (`P2` becomes 2), or the integer value of a number field |
| `labels` | Lowercased, trimmed, deduplicated |
| `blocked_by` | GitHub issue dependencies |
| `dispatchable` | The issue is open, the project item is not archived, and every blocking issue is closed |

A malformed item is skipped with a log line during state queries. During ID queries it is an error, because a missing item would otherwise look like it is no longer visible.

### Error categories

| Category | Cause |
|---|---|
| `tracker_request` | Network failure |
| `tracker_status` | Non-2xx HTTP status |
| `tracker_rate_limited` | HTTP 429, HTTP 403 with no remaining quota, or GraphQL `RATE_LIMITED` |
| `tracker_response` | Other GraphQL errors, or a response that is not valid JSON |
| `tracker_pagination` | A next page without a cursor |

The orchestrator only distinguishes success from failure.

### Agent tools

Each tool acts only on the current issue and runs in the orchestrator process with its token.

| Tool | Changes the board | What it does |
|---|---|---|
| `tracker_get_issue` | No | Board status, body, labels, recent comments, and the open PR for the issue's branch with its reviews and review threads |
| `tracker_comment` | Yes | Comments on the issue |
| `tracker_set_status` | Yes | Moves the card, only to one of `agent_states` |
| `tracker_submit_for_review` | Yes | Requires a clean working tree. Pushes HEAD to `agent/<number>` with your git credentials, opens a PR with `Closes #<number>` (or comments on the existing PR), then moves the card to `handoff_state` |

If a tool fails, it returns a failure result and the session continues.

## Differences from the spec

- Run limits (`agent.max_sessions`, `copilot.max_ai_credits_per_issue`) are an addition. The spec keeps dispatching an active issue indefinitely; here a run that reaches a limit is halted until the issue leaves the active states. The per-run counts are the only state kept across restarts (`.symphony-ledger.json` under `workspace.root`); a corrupt ledger fails startup rather than silently resetting the limits.
- The optional HTTP status API (§13.7) is not implemented yet. `Orchestrator.snapshot()` already returns the data described in §13.3.
- As in the spec, the retry queue is not persisted. After a restart, the orchestrator recovers from the board and the workspaces that are still on disk.
- A workspace path that already exists as a file or symlink fails the attempt; it is never deleted or replaced.
