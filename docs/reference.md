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
| `src/tracker/github-api.ts` | GraphQL and REST requests with the tracker token |
| `schema/workflow.schema.json` | Every `WORKFLOW.md` key with its default and meaning |
| `src/check.ts` | `symphony check`: keys, values, column rules, templates |
| `src/board.ts` | `symphony check --online` and `symphony setup-board` |
| `src/tools.ts` | Command line for `check` and `setup-board` |

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
| `evidence_branch` | `symphony-evidence` | Branch that stores screenshots attached with `tracker_submit_for_review`. It is never merged; keep it, or the images on issues stop loading |
| `followups` | None | Lets agents file out-of-scope problems as new issues with `tracker_create_followup`. Keys: `labels` (never include your dispatch label), `state` and `priority` for the new card, `max_per_session` (default 3) |

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
| `tracker_get_issue` | No | Board status, body, labels, recent comments, and the open PR for the issue's branch with its mergeability, reviews and review threads |
| `tracker_comment` | Yes | Comments on the issue |
| `tracker_set_status` | Yes | Moves the card, only to one of `agent_states` |
| `tracker_create_followup` | Yes | Only with `followups` configured; offered to implementer and reviewer. Creates an issue with the configured labels, adds it to the board with the configured state and priority, and notes which issue it came from. An open issue with the same title is reused instead |
| `tracker_submit_for_review` | Yes | Requires a clean working tree and a HEAD that merges into the default branch without conflicts (checked with `git merge-tree`; skipped on git older than 2.38). Pushes HEAD to `agent/<number>` with your git credentials, opens a PR with `Closes #<number>` (or comments on the existing PR), posts the summary on the issue, then moves the card to `handoff_state`. Optional `attachments`: images in the workspace (PNG, JPEG, GIF or WebP, up to 5 MB each), committed to `evidence_branch` with the tracker token and embedded in the PR and the issue comment |

Screenshots are linked by commit, so they render for anyone with access to the repository, including private ones. Clone workspaces with only `main` and the agent branches (see [examples/WORKFLOW.md](../examples/WORKFLOW.md)); a plain `git clone` also downloads every stored screenshot.

If a tool fails, it returns a failure result and the session continues.

The reviewer (see [Independent review](../README.md#independent-review)) gets `tracker_get_issue`, `tracker_comment` and one more tool instead of `tracker_submit_for_review` and `tracker_set_status`:

| Tool | Changes the board | What it does |
|---|---|---|
| `tracker_submit_review` | Yes | `verdict` (`approve` or `request_changes`), `summary`, `blocking_issues` (required when requesting changes) and optional `attachments`. Posts a comment review on the open PR and the same text on the issue, then moves the card to `review.pass_state` or `review.fail_state`. On the last round, requesting changes moves the card to `pass_state` so a human decides |

## Prompt templates

Prompts are [Liquid](https://liquidjs.com/) templates. An unknown variable or filter fails the attempt, and `symphony check` reports it beforehand.

| Template | Variables |
|---|---|
| `WORKFLOW.md` body (implementer's first turn) | `issue`, `attempt` (empty on a first run, then the retry number) |
| `agent.continuation_prompt`, `review.continuation_prompt` | `issue`, `turn`, `max_turns` |
| `review.prompt_file` (reviewer's first turn) | `issue`, `attempt`, `review_round`, `max_review_rounds`, `implementer_workspace` |

`issue` has `id`, `identifier`, `title`, `description`, `priority`, `state`, `branch_name`, `url`, `assignee_id`, `labels`, `blocked_by` (each with `id`, `identifier`, `state`), `dispatchable`, `created_at`, `updated_at` and `native_ref` (see [Field mapping](#field-mapping)).

## Checking a workflow

`symphony check [WORKFLOW.md]` runs without network access and exits with 1 if it finds an error.

| Check | Level |
|---|---|
| The file parses, and every key is in [the schema](../schema/workflow.schema.json); a misspelled key gets a suggestion | Error |
| Values are valid, as the orchestrator checks them at startup | Error |
| `blocked_state` is not an active column and not in `merge_conflicts.states` | Error |
| `handoff_state` is not a column the implementer works | Error |
| `review.pass_state` is not active; `review.fail_state` is an implementer column | Error |
| `followups.labels` contain no `required_labels` label | Error |
| Every prompt renders with a sample issue, with and without `attempt`; `review.prompt_file` and `copilot.cli_path` exist | Error |
| With review, `handoff_state` is one of `review.states` | Warning |
| `required_labels` is not empty, `hooks.after_create` is set, and with review `hooks.before_run` resets the reviewer's workspace | Warning |
| `project_number` is set; the token is a `$VAR` reference, not a literal | Warning |

`--online` also reads the board with the token: every column the workflow names is a Status option, the follow-up priority is a Priority option, and the labels exist in the repository. It warns if the project workflow "Pull request linked to issue" is enabled because it may change card status independently of Symphony. It does not change GitHub Project workflows; inspect the project's Workflows page if a card's status transitions are unexpected.

## Scheduling guarantees

- **One worker per issue.** An issue is claimed from dispatch until its run is released: handed off, blocked, halted, terminal, or no longer visible. Polls and retries skip claimed issues.
- **One scheduling decision at a time.** Polls, retry firings and worker-exit handling go through a single queue. Workers run in parallel, but no decision interleaves with another one that is still waiting on the tracker.
- **No stale stops.** Reconciliation only acts on the workers that existed when it read the tracker, so a slow read never stops a worker that started after it.
- **Halts hold.** A halted issue records its live tracker state, so a poll never mistakes the agent's own status change for a person moving the card.
- **No overlap in a workspace.** The next session for an issue starts only after the previous one, including its `after_run` hook, has finished.
- **One role per session.** When a card moves between an implementation state and a review state, the running session is stopped and the other role starts in a new session, in its own workspace.
- **Conflicts first.** A card the orchestrator returned for a [merge conflict](../README.md#merge-conflicts) is dispatched before every other card until its run ends; the reason is kept in the ledger, so a restart does not lose it. GitHub answers `UNKNOWN` while it computes mergeability, so a conflict is acted on at the first poll after GitHub has decided.
- **One owner per workflow, workspace tree and GitHub Project.** Managed runners reserve a case-insensitive ID before opening their log. A host-wide registry uses the host filesystem's case and Unicode-normalization identity to reject live runners with equivalent workflow paths, a workflow inside another runner's workspace, overlapping workspace roots, state/log writes inside another runner's workspace, or the same normalized GitHub Project owner/type/number. These checks still apply with different `SYMPHONY_STATE_DIR` values, while unrelated runners may share the normal state directory. Direct `node src/cli.ts` runs join the same registry. Sharing one project across runners is not supported because card claiming is not distributed.

## Differences from the spec

- Run limits (`agent.max_sessions`, `copilot.max_ai_credits_per_issue`) are an addition. The spec keeps dispatching an active issue indefinitely; here a run that reaches a limit is halted until the issue leaves the active states. The per-run counts are the only state kept across restarts (`.symphony-ledger.json` under `workspace.root`); a corrupt ledger fails startup rather than silently resetting the limits.
- The optional HTTP status API (§13.7) is not implemented yet. `Orchestrator.snapshot()` already returns the data described in §13.3.
- Returning cards whose pull request conflicts (`merge_conflicts`) is an addition. The spec only dispatches from active states; here the orchestrator also reads the configured waiting states and may move a card out of them.
- As in the spec, the retry queue is not persisted. After a restart, the orchestrator recovers from the board and the workspaces that are still on disk.
- A workspace path that already exists as a file or symlink fails the attempt; it is never deleted or replaced.
