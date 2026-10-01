# Reference

Details that the [README](../README.md) leaves out. Section numbers (§) refer to the [Symphony spec](https://github.com/openai/symphony/blob/main/SPEC.md).

## Source layout

| File | Responsibility (spec sections) |
|---|---|
| `src/manage.ts` | Start, list, inspect logs/status and stop independently isolated workflow processes |
| `src/instances.ts` | Stable workflow IDs, persistent registrations and serialized project/state-path ownership |
| `src/runner-control.ts` | Per-run local IPC for status and graceful stop, authenticated by a run nonce |
| `src/cli.ts` | One runner's ownership, ledger, workflow store, orchestrator and shutdown lifecycle |
| `src/workflow.ts` | Reads, parses and watches `WORKFLOW.md`; keeps the last valid config when an edit is invalid (§5, §6.2) |
| `src/config.ts` | Typed config with defaults, `$VAR`, `~` and relative paths (§6) |
| `src/template.ts` | Strict Liquid rendering plus role-specific, host-owned autonomous planning/review instructions (§5.4, §12) |
| `src/orchestrator.ts` | The only scheduling state: polling, dispatch, reconciliation, stall detection, retries (§7, §8, §16) |
| `src/iteration.ts` | Structured handoff validation and deterministic progress/session-limit decisions |
| `src/ledger.ts` | Durable per-issue authorization, started-session counts and pending semantic handoffs |
| `src/workspace.ts` | Workspace naming, root containment, the four hooks (§9) |
| `src/runner.ts` | Copilot SDK session and the multi-turn loop (§10, §16.5) |
| `src/policy.ts` | Permission decisions for agent tool calls (§10.5, §15) |
| `src/tracker/github-project.ts` | GitHub Project adapter and the agent tools (§11) |
| `src/tracker/github-api.ts` | GraphQL and REST requests with the tracker token |
| `src/tracker/issue-context.ts` | Issue-scoped feedback pagination, complete review text and mirrored-review deduplication |
| `schema/workflow.schema.json` | Every `WORKFLOW.md` key with its default and meaning |
| `src/check.ts` | `symphony check`: keys, values, column rules, templates |
| `src/board.ts` | `symphony check --online` and `symphony setup-board` |
| `src/tools.ts` | Command line for `check` and `setup-board` |

## Runner management and recovery

`bin/symphony` delegates `start`, `run`, `list`, `status`, `logs` and `stop` to the management interface. Each workflow runs in a separate Node.js process, not a shared scheduler or supervisor daemon. Use `start|run [WORKFLOW.md] [--id ID]`, `status|logs|stop [ID]`, and `list`. Management commands also accept `--id ID` instead of a positional ID. `logs --no-follow` prints the latest lines and exits. The direct runner accepts `node src/cli.ts [WORKFLOW.md] [--id ID]` with its existing `--once`, `--dry-run` and `--log-level` flags.

IDs are 1-64 ASCII letters/digits/underscores/hyphens, starting with a letter or digit, normalized to lowercase. The default is a readable directory name plus a hash of the canonical workflow path. An explicit ID remains bound to that file; invoking the same file again without an ID reuses its registration. On a fresh installation, omitted paths use `SYMPHONY_WORKFLOW`, the legacy `.last-workflow` under `SYMPHONY_STATE_DIR`, or `./WORKFLOW.md`. Once registered, one workflow can be managed without an ID. With multiple registrations (including stopped ones), omit an ID only for `list`/`status`, which list all; other ambiguous commands fail.

| Resource | Location / ownership |
|---|---|
| Registry | `~/.symphony/runners/registry.json`, shared across installations for the current OS user; no tracker tokens or prompts |
| Log | `${SYMPHONY_STATE_DIR:-~/symphony-workspaces}/runners/<ID>/orchestrator.log`, appended across restarts; foreground runs also log to stderr |
| Ledger | `<workspace.root>/.symphony-ledger.json` and its `.tmp` save sidecar; stopping does not reset authorization |
| Workspaces | Under that workflow's `workspace.root`, including separate reviewer folders |
| Control | Unique local socket (named pipe on Windows) plus a random run nonce; management never sends a stop signal to a PID read from the registry |

The registry serializes collision checks and ownership writes before runner log creation, ledger loading or workspace cleanup. It rejects a second live runner on the same API authority, case-insensitive owner and project number, independent of repository filters, endpoint URL suffixes and log-directory overrides. It also rejects duplicate workflow registration and overlapping config/workspace/ledger/log paths, including the ledger's temporary save file, nested paths, existing symlink ancestors and hard-linked state files. These checks apply across runners, within each runner, and against the shared registry files. Supply distinct `workspace.root` values: the unchanged system-temp default is intentionally not enough for two workflows. Case aliases are conservatively rejected on macOS/Windows. A workspace must not contain its workflow file, logs or the shared registry.

Stopped registrations retain their most recently registered paths, preventing accidental reuse by another ID. Restarting the same ID can update its settings and paths after collision checks; it does not migrate or delete old state. Do not repurpose an old workspace for a different repository/project: select a fresh root when changing tracker scope. While running, workflow path, workspace root, API endpoint, owner/type/project, repository, identifier prefix and branch prefix are pinned. Edits to those identities are rejected before replacing the store's last-good configuration; dispatch remains paused until the file is restored or the runner restarted. Other valid settings and prompts still reload independently.

`start` reports success only after the child has acquired ownership, opened its control endpoint and completed orchestrator startup. `stop ID` requests graceful shutdown, retaining ownership while workers and queued tracker operations drain; it times out after 60 seconds without forcing a kill or affecting other runners. Repeated signals do not bypass cleanup. A dead process's claim can be replaced on restart; a live but unresponsive PID retains ownership, including possible PID reuse, rather than risking another runner. Inspect its log and residual Copilot runtimes before manual recovery. Existing ledger startup-uncertainty fences still apply and are never cleared by the manager.

Registry writes use an exclusive `registry.lock` and atomic file replacement. A crash during a registry transaction may leave that lock: the error names its exact path. Its content is the writer PID (possibly empty if interrupted during creation). Only after verifying no management/startup/shutdown operation is still using it should a person remove that lock and retry. A malformed registry fails closed; restore its contents instead of discarding it while runners may still be active. Do not edit registrations or retarget state symlinks under a live runner.

Ledger saves exclusively create `.symphony-ledger.json.tmp`, write through that new file's descriptor, and atomically rename it over the ledger. They never open an existing sidecar for writing, including symlinks and hard links. Ordinary write/rename failures remove only the sidecar created by that save, preserve the last durable ledger and halt scheduling. A crash can leave a sidecar; startup refuses any pre-existing sidecar before opening runner logs or loading the ledger. With the runner stopped and residual runtimes checked, inspect/back up the leftover and remove that exact temporary file or alias before restarting. Do not delete the ledger or promote an incomplete temporary file to reset authorization or bypass startup-uncertainty fences.

Before upgrading from the old PID-file wrapper, stop all old runners, including direct Node invocations: they do not participate in the new registry. The old remembered workflow path is imported on first use; old logs/PID files are not used for control or migrated. Coordination assumes one trusted OS user on a single host, using the same home directory and canonical API hostname, not different accounts, API proxy aliases or distributed hosts. macOS/Linux are supported; Windows remains unverified. Concurrent runners on one GitHub Project are unsupported.

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

Required: `owner`, `project_number`, `repo` (as `owner/name`), plus these explicit lifecycle mappings (never inferred from active-state order):

| Key | Meaning |
|---|---|
| `start_state` | Human start/reauthorization entry, e.g. Todo; an implementer active column distinct from `working_state` |
| `working_state` | Scheduler-managed implementer active column, e.g. In Progress |
| `blocked_state` | Waiting column for startup failures, human-required blockers, no progress or exhausted sessions; never active, terminal or monitored for conflicts |

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
| `handoff_state` | None | Target for `tracker_submit_for_review`; configure it for submission, which fails without a handoff target |
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
| `contentState` | Native GitHub issue `OPEN`/`CLOSED`; closure takes terminal precedence even when the project column has not changed |
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
| `tracker_get_issue` | No | Board status, complete issue/PR bodies, labels, PR head commit, and paginated comments/reviews/threads with unabridged blocking feedback |
| `tracker_comment` | Yes | Comments on the issue. Optional `blocking` defaults to false; set true only for a complete blocking reason, not a plan/progress note |
| `tracker_set_status` | Yes | Implementer only; moves to one of `agent_states`. Before setting `blocked_state`, the latest successfully posted `tracker_comment` in this invocation must have `blocking: true` and contain the complete reason; that exact comment becomes the formal blocking handoff |
| `tracker_create_followup` | Yes | Only with `followups` configured; offered to implementer and reviewer. Creates an issue with the configured labels, adds it to the board with the configured state and priority, and notes which issue it came from. An open issue with the same title is reused instead |
| `tracker_submit_for_review` | Yes | Requires a clean working tree and a HEAD that merges into the default branch without conflicts (checked with `git merge-tree`; skipped on git older than 2.38). Accepts the complete result durably and publishes it on the issue, pushes HEAD to `agent/<number>` with your git credentials, opens a PR with `Closes #<number>` (or comments on the existing PR), then hands off. If no session remains for required review, the result is blocked as unreviewed instead. Optional `attachments`: images in the workspace (PNG, JPEG, GIF or WebP, up to 5 MB each), committed to `evidence_branch` with the tracker token and embedded in the PR and the issue comment |

Screenshots are linked by commit, so they render for anyone with access to the repository, including private ones. Clone workspaces with only `main` and the agent branches (see [examples/WORKFLOW.md](../examples/WORKFLOW.md)); a plain `git clone` also downloads every stored screenshot.

If a tool fails before accepting a result, it returns a failure result and the session can correct it. Once a semantic handoff is accepted, its persisted publication is recovered without starting another model invocation to repeat it. This recovery is separate from the optional usage footer.

Acceptance does not override dispatch eligibility. Before resuming a pending handoff on a poll, retry, worker exit or restart, the host refreshes the issue and checks `isRoutable`. The GitHub adapter also resolves the current native issue/project item and checks the configured required labels and adapter eligibility before publication effects, including again after local Git inspection before pushing and before the final issue edit. Removing a required label, archiving the card or introducing an open blocker suspends publication: no further push, PR/review/comment or status writes, and the optional usage footer is skipped. A failed eligibility read never permits a write.

The accepted result, saved SHA, workspace, publication checkpoints, session count and usage stay intact; no new ledger state or model retry is introduced. Restoring eligibility while the card is still in the applicable source/intended-target state resumes the same handoff with the same allowance. This is not a new Todo authorization. Closure retains terminal precedence; an incompatible state still cancels outdated publication under the existing rules. Already-completed effects are not undone. Eligibility checks and remote mutations are not atomic: a change after the final read cannot cancel an already-issued request.

After an implementation push succeeds, the PR API can temporarily report a different head SHA. Symphony keeps that result pending rather than marking it stale or rerunning implementation. A successful inconsistent-head observation counts once; the next check runs on a host poll at least 60 seconds later. The fixed limit is three mismatching checks in total (the first plus two retries). The count, last observed SHA and next-check time survive restart. API failures are not SHA observations. A match completes the same handoff without another push, result comment or agent session.

If the third check still differs, Symphony moves the card to `blocked_state` and updates the original issue result's host status block with `head_mismatch`, the expected and actual SHA, and the check count. It does not infer commit ancestry, force-push, or consume another agent round. This is a publication failure, not a no-progress review. A lost Blocked/status-comment response retries only that final publication, not a fourth head check. Reviewer quality verdicts retain strict checked-SHA validation; closing an issue or leaving the applicable handoff state still cancels outdated work. No extra configuration is needed.

Source-code fixes require restarting the service after active work is safely stopped. Previously finalized `Stale result` records are not automatically reconstructed or retried by this change.

#### Reading complete feedback

`tracker_get_issue` without arguments returns an overview: the latest five issue comments, PR reviews and PR comments, plus the first five review threads and the first five comments in each thread. No text is clipped at a character limit. Reviews expose the full Markdown after `**Blocking issues**` in `blocking_feedback`, independently of the full `body`; GitHub's `COMMENT` state is not treated as the AI verdict. An exact issue-comment copy of a review is omitted only when the full source review with the same author and URL is present in that response. Other comments, and mirrors whose source is on another page, remain available.

Every connection includes `pagination` with `total_count`, `has_more` and `next`. Pass `next` directly as the arguments to `tracker_get_issue`. Sections are `issue_comments`, `reviews`, `pull_request_comments`, `review_threads`, and `thread_comments`; the latter also needs the returned `thread_id`. Comments and reviews page backwards to older history; threads and their comments page forwards. A thread is checked against this issue's open PR before its comments are returned. No arbitrary issue or PR ID can be supplied. Missing pagination metadata or a non-advancing cursor is an error, not an empty or complete history.

`history_complete: false` on the overview means more history exists, including nested thread comments. `text_truncated: false` means the returned text is unabridged; it does **not** mean all pages have been read. Follow relevant continuation pages before judging earlier feedback, and do not present an unread criterion as verified.

The SDK may spill large tool output to disk. Each attempt gets a unique, canonical, private (`0700`) output directory outside the Git workspace. It is passed as `largeOutput.outputDirectory` with an explicit 51,200-byte threshold, and only that exact directory is added to the agent's read permissions. The parent temp directory, other attempts' output, and writes to this directory are not granted. Output is retained until session/runtime shutdown has been attempted, then removed on both success and failure; cleanup failures are logged. It is temporary context, not retained review evidence. This is a permission-callback restriction, not an OS sandbox for code launched by approved test commands.

The reviewer (see [Independent review](../README.md#independent-review)) gets `tracker_get_issue`, `tracker_comment` and one more tool instead of `tracker_submit_for_review` and `tracker_set_status`:

| Tool | Changes the board | What it does |
|---|---|---|
| `tracker_submit_review` | Yes | Submits the structured result below, saves the full record on the issue before the PR mirror and moves to the host-decided state. It is also the reviewer's effective blocked exit; the reviewer has no general status-setting or commit/push permission |

Required tool fields are `verdict`, `reviewed_head`, `progress`, `progress_reason` and `summary`. Conditional fields are checked by the host:

| Field | Contract |
|---|---|
| `verdict` | `approve`, `request_changes` or `unable_to_verify` |
| `reviewed_head` | Exact checked commit SHA, matching local checkout and current PR head for quality verdicts. May be `null` only for `unable_to_verify` when unavailable |
| `progress` | `initial` for an initial quality verdict; `made_progress` or `no_progress` for a formally handed-off rework; `not_assessed` for `unable_to_verify`. The runner supplies initial/rework context; do not infer it from the review number |
| `progress_reason` | Nonempty evidence for changed behavior, resolved blockers or reduced uncertainty, or the missing verification conditions. Commit/line counts alone are not progress |
| `next_action`, `next_step` | For request changes: `continue` with a concrete next approach (changed approach for no progress), or `human_required` with the specific human action. For unable to verify: `human_required` and the missing action. For approval: omitted or `null` |
| `summary` | Complete coverage, checks/results, earlier blockers, relevant human PR feedback, constraints, risks and unverified areas; not just PR links |
| `blocking_issues` | Nonempty list required for request changes, empty/omitted for approval; each finding says what, where and expected behavior |
| `attachments` | Optional images, with the same limits as implementation submission |

Approval with `no_progress` is invalid. `unable_to_verify` always requires `not_assessed` and `human_required`; it is not a quality approval or a stagnation strike. Approval goes to `review.pass_state`. Human-required results, two consecutive reviewed no-progress reworks, or no remaining capacity for continuation go to `blocked_state`; otherwise request changes goes to `review.fail_state`. Made progress clears the streak. Initial findings and infrastructure failures never add strikes. A formal rework at the same SHA can still be reviewed and assessed once; repeated delivery of one accepted result must not add another strike.

Full implementation, review and blocking records live on the issue independently of PR availability. PR human feedback is still read and the agents include relevant decisions in their handoffs; not every human comment is automatically copied.

### Implementation and review method

The runtime adds an autonomous planning protocol to the already-rendered repository prompt, including custom prompts. Before product edits (also merge-conflict repairs), the implementer reads the issue/history and code, chooses a proportionate approach, challenges its own consequential assumptions, and publishes an **Implementation plan** through `tracker_comment` on the current issue. The plan records goal/non-goals, evidence versus assumptions, affected components/resources/lifecycle, chosen approach and meaningful alternatives, invariants/counterexamples, verification and steps. Small tasks need only a few bullets. Self-grill follows decision dependencies and stops when material in-scope decisions and verification are clear; it is not an exhaustive search for every hypothetical defect or a transcript of internal deliberation.

Planning continues directly into implementation in the **same SDK session**, without a planner role, approval lane, additional session allocation or quota reset. People authorize and recover work through the Project, not per-task chat interviews. Automated input replies are not human approval. Workers resolve facts themselves and make reversible, in-scope technical choices with explicit assumptions; genuinely missing requirements, external dependencies or authority use the existing Blocked handoff. A plan cannot expand scope, permissions or acceptance. The runtime disables the interactive `brainstorming`, `grill-me` and `grilling` skills alongside the two setup skills; this is a Symphony-owned adaptation of planning and self-questioning methods, not invocation of their human approval workflows. Personal skill installations are unchanged and not required.

On continuation or a new session, validate and reuse an applicable issue plan rather than starting over or reposting it. Rework or material design changes get a concise revision explaining changed decisions and verification. Repeated adjacent failures call for reconsidering the shared mechanism, not just another example-specific patch. Plans and revisions stay on the issue independently of PR availability; ordinary history pagination exposes them. A plan comment is not a semantic handoff. `tracker_comment` is append-only and has no exactly-once recovery or persistent plan queue: after a failure/uncertain response the agent is instructed to reread the issue before retrying and reuse a matching comment. If publication remains unavailable, it must refrain from product edits and use the existing failure/blocker handling; remote comment/status availability still constrains that handling.

The independent reviewer uses plans as evidence, not authority: independently check requirements, code, material assumptions and omitted impact; a plan cannot narrow review coverage or waive a defect. Self-grill does not replace independent review. Justified plan changes and formatting alone are not defects. Findings should distinguish concrete in-scope contract failures from outside-scope hardening with triggering conditions, impact and evidence.

This is **prompt-level guidance**, not an enforced filesystem barrier or proof that the model planned correctly. Offline tests verify prompt composition, tool scope, full plan history and scripted plan/work/review/rework without extra allocations; they do not prove LLM compliance, guaranteed comment deduplication or improved convergence. A user-authorized live trial must assess those outcomes. No new configuration keys, tool permissions or Project columns are introduced.

The prompts require both roles to derive invariants and relevant edge cases from the goal and code; users do not need to enumerate every case in acceptance criteria. The implementer traces affected lifecycle paths, tests counterexamples, checks docs/translations and fixes the failure class during rework. The reviewer independently plans coverage, follows unchanged callers and cleanup as well as the diff, verifies prior fixes and completes the risk-focused pass before reporting all confirmed blockers together. A finding needs a concrete failure scenario and test or code-path evidence; speculative improvements remain suggestions. Unread context/code is marked unverified and cannot support an approval. Access failures alone should be reported as missing evidence, not invented product defects.

Reviewers may create new disposable tests/fixtures only in their own checkout's normal test-discovery paths and use the existing allowlisted test entry point. In this repository, a new `test/review-probe-*.test.ts` runs through `npm test`. Reviewers must not change implementation, existing tests, scripts, dependencies or permissions; they remove their scratch files, check the working tree and never commit. This is a prompt-level working agreement; no broader shell permissions or new execution sandbox are introduced. Existing `copilot.shell_allow`, read/write boundaries and the shared session limit remain in force. Deploy code changes by restarting the runner after active work is stopped; prompt files are loaded for new attempts and do not replace an already-running session's prompt.

Implementers keep solving in-scope failures within current permissions. When external dependencies, authorization, human decisions or confirmed inability prevent work, they comment with `blocking: true`, completed work, attempted steps/results, missing conditions and concrete human action, then set Blocked. Plans/progress leave the flag unset or false and cannot be upgraded to a blocked handoff. This typed guard does not judge whether a claimed blocking reason is substantively correct. Older custom prompts should include the flag; the runtime instructions and tool error also explain it. Reviewers use the structured unavailable-verification result instead of merely commenting and staying active.

## Prompt templates

Prompts are [Liquid](https://liquidjs.com/) templates. An unknown variable or filter fails the attempt, and `symphony check` reports it beforehand.

After rendering, the runner prepends its role-specific [autonomous protocol](#implementation-and-review-method) without rendering the combined text again. Repository instructions and reviewer progress context are preserved. Later turns receive a short continuation reminder, not the full planning exercise. `attempt` is a retry number, not a planning phase: plan reuse/revision depends on issue history, current code and feedback.

| Template | Variables |
|---|---|
| `WORKFLOW.md` body (implementer's first turn) | `issue`, `attempt` (empty on a first run, then the retry number) |
| `agent.continuation_prompt`, `review.continuation_prompt` | `issue`, `turn`, `max_turns` |
| `review.prompt_file` (reviewer's first turn) | `issue`, `attempt`, `review_round`, `implementer_workspace` |

`review_round` is a review sequence number, `turn` is an SDK-session turn, and `agent.max_sessions` counts successfully started implementer and reviewer sessions together (default 20). They are different counters. Migration: remove `max_review_rounds` from old templates and delete `review.max_rounds`, `copilot.max_ai_credits` and `copilot.max_ai_credits_per_issue` from front matter; those keys now produce explicit migration errors.

`issue` has `id`, `identifier`, `title`, `description`, `priority`, `state`, `branch_name`, `url`, `assignee_id`, `labels`, `blocked_by` (each with `id`, `identifier`, `state`), `dispatchable`, `created_at`, `updated_at` and `native_ref` (see [Field mapping](#field-mapping)).

## Checking a workflow

`symphony check [WORKFLOW.md]` runs without network access and exits with 1 if it finds an error.

| Check | Level |
|---|---|
| The file parses, and every key is in [the schema](../schema/workflow.schema.json); a misspelled key gets a suggestion | Error |
| Values are valid, as the orchestrator checks them at startup | Error |
| Required `start_state` and `working_state` are distinct implementer active columns; `blocked_state` is waiting, not terminal or in `merge_conflicts.states` | Error |
| No agent-set, handoff, review-return or conflict-return state targets `start_state`; removed budget/review-cap keys are rejected | Error |
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
- **Halts hold.** Paused/exhausted work is not restarted by automatic rework/conflict return or a process restart. Renewed authorization is a waiting-to-`start_state` move, not just any change to an active column.
- **No overlap in a workspace.** The next session for an issue starts only after the previous one, including its `after_run` hook, has finished.
- **One role per session.** When a card moves between an implementation state and a review state, the running session is stopped and the other role starts in a new session, in its own workspace.
- **Conflicts first.** A card the orchestrator returned for a [merge conflict](../README.md#merge-conflicts) is dispatched before every other card until its run ends; the reason is kept in the ledger, so a restart does not lose it. GitHub answers `UNKNOWN` while it computes mergeability, so a conflict is acted on at the first poll after GitHub has decided.
- **Isolated runner ownership.** Startup rejects a second live owner of a project or overlapping state paths, including direct CLI invocations. Each runner has its own store, ledger and scheduler; [management and recovery](#runner-management-and-recovery) describes the single-user/host boundary.

### Authorization and usage

`createSession` success consumes one of the default 20 shared slots, before the first prompt. Pre-session workspace/hook/startup failure pauses with a stage/error report without a charge or automatic retry loop; uncertain startup is paused for reconciliation. The last started session can finish; no new session starts beyond the limit. Startup and inactivity timeouts remain, but there is no absolute elapsed-time limit or credit stopping threshold.

Startup uncertainty is persisted on the invocation. A late successful session is counted once but receives no prompt; the original runner must confirm that its pending startup resolved and cleanup succeeded before the fence clears. Restarting the host or moving to Todo alone never clears this flag. An interrupted startup without a surviving cleanup acknowledgement stays paused for manual runtime/ledger reconciliation; no automatic repair command is provided.

Onboarding explicitly sets concurrency to 1 (the core spec default remains 10 if omitted) and models to `auto`. Fixed model IDs must be user-provided or verified as available, not guessed.

State ownership is a working agreement, not actor detection or a GitHub permission lock. People start in Todo and renew an existing card only from a waiting column to `start_state`; do not manually move into/out of In Progress, Rework or AI Review. Keep other board automation from returning existing cards to `start_state`. Renewal resets the session allowance and no-progress streak while preserving work, full issue history and cumulative usage. Automatic conflict return does not reset them. Terminal is a human merge/close, not AI approval; there is no separate terminal-reopen workflow.

`agent.usage_comments` (default `true`) adds only a best-effort footer to the invocation's issue-result message: `用量（本轮）：12.34 · 轮次 6/20 · 模型：xxxx`. It uses observed session AI credits and actual model(s), with the session's fixed ordinal/limit, not cumulative cost or configured `auto`. Detailed metrics stay in logs. Missing/unreliable metrics, removed markers, deleted messages or update failures may omit the footer; no standalone usage comment, model retry or durable footer queue is created. Disabling it does not suppress necessary semantic failure reports.

## Differences from the spec

- The shared session limit (`agent.max_sessions`) and evidence-based review progression are additions. Authorization, confirmed sessions, pause state, progress streak, usage and pending semantic handoffs are persisted by native issue identity in `.symphony-ledger.json` under `workspace.root`; a restart or project-item re-add does not grant fresh capacity. A corrupt ledger fails closed rather than silently resetting control state. Footer display is not durable control state.
- The optional HTTP status API (§13.7) is not implemented yet. `Orchestrator.snapshot()` already returns the data described in §13.3.
- Returning cards whose pull request conflicts (`merge_conflicts`) is an addition. The spec only dispatches from active states; here the orchestrator also reads the configured waiting states and may move a card out of them.
- As in the spec, the retry queue is not persisted. After a restart, the orchestrator recovers from the board and the workspaces that are still on disk.
- A workspace path that already exists as a file or symlink fails the attempt; it is never deleted or replaced.
