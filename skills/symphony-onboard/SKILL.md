---
name: symphony-onboard
description: Set up a repository so symphony-copilot agents can work on it. Reads the repository's build and test setup, asks which workflow capabilities the user wants (independent AI review, merge-conflict recovery, follow-up issues), derives board columns including mandatory Blocked, writes WORKFLOW.md, AGENTS.md and optional REVIEW.md from templates, and validates with `symphony check`. Use when the user wants to onboard a repository, choose board workflow behavior, or write/fix WORKFLOW.md, AGENTS.md or REVIEW.md.
---

<!-- Installed by symphony-copilot install-skills from $SYMPHONY_HOME. Rerun it after updating symphony-copilot. -->

# Onboard a repository to symphony-copilot

symphony-copilot turns cards on a GitHub Project board into pull requests: it runs a Copilot agent per card in a clone of the repository. The repository needs these files at its root:

- `WORKFLOW.md`: YAML front matter (board, columns, hooks, limits, allowed commands), then the implementer's prompt as a Liquid template. The contract is `$SYMPHONY_HOME/schema/workflow.schema.json`: read it before writing; every key and rule is described there.
- `AGENTS.md`: the map agents read first: where to start, how to build and verify, hard rules.
- `REVIEW.md`: the review agent's prompt, when AI review is on.

Templates to start from: `$SYMPHONY_HOME/examples/WORKFLOW.md`, `$SYMPHONY_HOME/examples/AGENTS.md`, `$SYMPHONY_HOME/examples/REVIEW.md`, `$SYMPHONY_HOME/examples/ISSUE_TEMPLATE/agent-task.yml`. The checker is `$SYMPHONY_HOME/bin/symphony check`.

Write prose in the language the user writes to you. Keep YAML keys, tool names (`tracker_*`) and template variables as they are.

## 1. Read the repository

Find out yourself instead of asking:

- `git remote get-url origin`: owner, name and clone URL. The default branch: `git symbolic-ref --short refs/remotes/origin/HEAD`.
- How it builds and tests: CI workflows in `.github/workflows` (the commands CI runs are the most reliable), package.json scripts, Makefile, pyproject.toml, Cargo.toml, go.mod, Xcode projects, the README.
- Existing agent docs: AGENTS.md, CLAUDE.md, `.github/copilot-instructions.md`, CONTRIBUTING.md.
- Toolchains outside the repository that the build reads, such as Xcode or an SDK: these go in `copilot.read_allow`.
- Files the build needs that are not in git, such as local config or signing settings: `after_create` copies them in.
- An existing WORKFLOW.md: then you are fixing it, not starting over.

## 2. Ask the user, once

Users should not have to know Symphony's internal state machine or invent a board. Infer facts from the repository first (owner/type, repository name, default branch, language, build/test commands). Ask, in one concise batch, only what the repository cannot answer. Explain capabilities in plain language, recommend a default, and allow “use the recommended setup.” Do not ask which columns they want.

Ask:

- Independent AI review before a person reviews/merges the PR? Explain the extra model usage/latency; human approval before merge remains final either way. If enabled, use reviewer model `auto` by default: Copilot chooses a model available to this account. Ask this as a normal-language question, not a technical model picker. Do not present a picker of guessed model IDs or ask the user to recognize names they may not know. Configure a fixed reviewer model only if the user explicitly requests it and provides an ID, or you have verified that exact ID is available to their Copilot account. A different model family can improve independence, but never invent an ID to achieve that.
- Automatically detect PR merge conflicts while a PR waits for a person and return the card to the implementer? Recommend Yes; if No, explain a person can return a waiting card to Todo after leaving instructions.
- Let agents file low-priority follow-up issues for unrelated problems? Recommend No if issue noise is a concern; when Yes, explain follow-ups use `tech-debt` and P4 and do not receive the dispatch label, so never start automatically. Clarify this is separate from the issue form below.
- Implementer model defaults to `auto` (Copilot selects an available model). Do not present an unverified model list. If the user requests a fixed model, use an ID they provide or one verified as available; otherwise keep `auto`. Ask concurrent agents (onboarding default 1) and total started sessions per card authorization (default 20, implementer and reviewer combined, not 20 pairs). Costs are recorded for people, not used as a stopping threshold; do not ask for a credit budget.
- Board owner only if it cannot be inferred: default to repository owner; `gh api users/<owner> --jq .type` distinguishes user from organization.
- Dispatch label (default `agent`); only issues with this label are eligible.
- Add an optional GitHub task issue form? Recommend Yes. Explain it only adds a structured New issue form for human-written tasks (goal, acceptance, verification, scope, notes); it does not create, label, dispatch, or start issues. This is distinct from agent-generated follow-up issues.

Use the user's conversation language for questions and generated column names. Do not ask for individual column names. Show the derived lane plan after the capability answers; the user may ask to rename lanes. Keep chosen names consistent in WORKFLOW.md, REVIEW.md and the handoff summary.

Explain the fixed behavior, not as optional questions: Blocked is mandatory. A successful SDK session creation consumes one session; workspace/hook/runtime startup failures before that pause without charging or endless retry. Approval goes to Human Review; a human-only blocker, two consecutive reviewed no-progress reworks or the shared session limit pauses in Blocked. Initial review and infrastructure failures are not no-progress reworks. No credit cap or absolute elapsed-time cap is provided.

### Derive columns from the selected behavior

Use these default names, localized to the user's language when appropriate, in this order, deduplicating shared roles:

| Role | Default column | Mapping |
|---|---|---|
| New work / renewed authorization | Todo | Required `tracker.provider.start_state`; requires the dispatch label, independent of active-state order |
| Implementation | In Progress | Required `tracker.provider.working_state`; scheduler-managed implementer state |
| Rework | Rework | Add when either independent AI review or conflict recovery is enabled; review failures and/or conflicted PRs return here |
| Independent check | AI Review | Only with independent AI review; `review.states` and handoff state |
| Human decision | Human Review | Always; direct handoff without AI review, pass state with it; conflict-wait state if enabled |
| Blocked | Blocked | Always; required `tracker.provider.blocked_state`; allow implementers to set it after commenting with the reason |
| Complete | Done, Canceled | `tracker.terminal_states`; keep Done first for closed/merged automation |

Generate config consistently from the answers:

- Derive `tracker.active_states` exactly as follows (Blocked is never active):

  | AI review | Conflict recovery | `tracker.active_states` |
  |---|---|---|
  | On | On or off | `[Todo, In Progress, Rework, AI Review]` |
  | Off | On | `[Todo, In Progress, Rework]` |
  | Off | Off | `[Todo, In Progress]` |

- AI review on: include AI Review and Rework in `active_states`; hand off to AI Review; pass to Human Review; fail to Rework when the host allows continuation; include `review` and generate REVIEW.md. Review numbering is a sequence, not a separate cap. Rework is needed even if conflict recovery is off.
- AI review off: omit `review` and REVIEW.md; hand off directly to Human Review; omit AI Review. Include Rework only if conflict recovery is on.
- Conflict recovery on: include Rework in `active_states` and set `merge_conflicts.states: [Human Review]`, `return_state: Rework`. If off, omit `merge_conflicts`; when AI review is also off, omit Rework.
- Always set `start_state: Todo`, `working_state: In Progress`, `blocked_state: Blocked`; Blocked is a waiting column, never active, terminal or monitored for conflicts. Automatic review/conflict return must not target Todo.
- Follow-ups on: configure `followups` with `state: Todo`, `labels: [tech-debt]`, and `priority: P4`; never attach the dispatch label. Todo is the human intake queue; an issue is not picked up until a person explicitly labels it for dispatch.
- Set `terminal_states: [Done, Canceled]` and `agent_states: [In Progress, Blocked]`. Do not list every active state; AI Review, Rework and Human Review are set by submission/review/orchestrator tools, not `tracker_set_status`. Terminal means a person merges the PR or closes the issue, not an AI approval.

Before writing, show a compact preview, for example: “AI reviewer: on; conflict return: on; Blocked: required; task issue form: yes; columns: Todo → In Progress → Rework → AI Review → Human Review → Blocked → Done → Canceled.” Then generate from this plan; do not copy the full-featured example unchanged.

Teach state ownership as a working agreement, not a GitHub permission lock: people start new work in Todo and return existing cards only from a waiting column (Blocked/Human Review) to Todo. This renews the session allowance and clears the no-progress streak, preserving work and issue history. Do not manually move cards into or out of In Progress, Rework or AI Review. Automatic conflict return to Rework does not reset anything and cannot restart paused or exhausted work; restarting Symphony does not reset it either. Other board automation must not send existing cards to Todo as if a person had authorized them.

## 3. Write WORKFLOW.md

Start from the templates and change only what this repository needs and the user selected. The example WORKFLOW.md is a full-featured reference profile, not a requirement to keep every lane.

- Leave `project_number:` empty. `symphony setup-board` creates the board later and writes the number.
- Apply the derived lane plan from step 2. Remove the `review` section and do not create REVIEW.md when independent AI review is off. Do not keep unused Rework or AI Review columns. Use each selected column name consistently; `symphony setup-board` creates exactly the states named by WORKFLOW.md. `symphony check` enforces these rules:
  - review states are also in `active_states`, and one of them is `handoff_state`;
  - required `start_state` and `working_state` are distinct implementer active columns; no automatic return or agent status targets `start_state`;
  - `review.pass_state` is a waiting column, not an active one;
  - `review.fail_state` and `merge_conflicts.return_state` are active columns the implementer works;
  - `blocked_state` is not active and not in `merge_conflicts.states`;
  - `followups.labels` never contain a `required_labels` label.
- `hooks.after_create`: keep the template's single-branch clone and branch switch, then install dependencies (hooks have network access; agents do not) and copy local-only files. `hooks.before_run`: keep the fetch and the reviewer reset. Replace `main` with the default branch in the hooks and the prompt.
- `copilot.shell_allow`: the exact build, test and lint commands, as prefixes, for example `npm test` or `swift test`. Do not add entries that run arbitrary code: `node`, `python3`, `bash`, `sh`, `npx`, or a bare `npm run`. git and basic file commands are built in.
- `workspace.root`: `~/symphony-workspaces/<repository name>`, outside the repository.
- The prompt: keep the template's steps and rules, replace every example state with the generated localized name, and make verify fit this repository. Preserve the required `tracker_comment` with `blocking: true`, then `tracker_set_status` exit for missing external dependencies, authorization or confirmed inability; in-scope failures still need solving. Plans/progress leave `blocking` unset or false; only a complete blocking reason qualifies for the Blocked handoff. If follow-ups are off, remove the instruction to file follow-up issues; if conflict recovery is off, say a person can return a waiting card to Todo. The PR-submission/handoff step stays enabled even when AI review is off.
- Use `agent.max_sessions: 20` unless the user chooses otherwise. Remove obsolete credit-cap and review-round-cap keys; costs belong only in detailed logs and a best-effort issue-result footer, e.g. `用量（本轮）：12.34 · 轮次 6/20 · 模型：xxxx` with actual model usage. Missing metrics or a failed footer update may leave no footer; there is no separate usage comment or durable footer retry queue.
- Preserve the implementer's responsibility to infer invariants and edge cases from the goal and code, trace the affected lifecycle (including unchanged callers and cleanup), test counterexamples, and fix the underlying failure class on rework. Do not ask users to enumerate edge cases. Keep the instructions to follow feedback pagination and read saved output fully rather than relying on previews.
- Preserve autonomous planning before product edits, including conflict repair: inspect evidence, choose an approach, self-grill consequential assumptions, and publish a concise Implementation plan with `tracker_comment` on the issue. Planning and implementation stay in the same session, without a new agent, column or human approval gate. Reuse applicable plans; revise material decisions and verification on rework, reconsidering the shared mechanism when adjacent failures recur. Keep full plan context on the issue, not only the PR. Do not republish unchanged plans or blindly repeat a comment after a lost response. The runtime supplies this protocol even for custom prompts; it is behavioral guidance, not a write barrier.
- People remain at the Project control plane. Automated answers are not human approval: infer facts, make reasonable in-scope choices and document assumptions, but do not invent requirements or broaden permissions. Use the existing Blocked path for genuinely missing decisions/authorization, not routine technical choices. Do not ask people to approve each task's plan or install/invoke interactive `brainstorming`, `grill-me` or `grilling` in unattended workers; those skills remain separate tools for people.

## 4. Write AGENTS.md

If the repository has one, keep it and add only what is missing: a "Build and verify" section (commands, plus a table of what changed and what to run at least) and the hard rules "evidence first", "no push: only tracker_submit_for_review" and "no network or new dependencies". Keep it a short map with links, not a manual.

## 5. Write REVIEW.md only when selected

If independent AI review is on, start from the template, point its verify step at AGENTS.md's "Build and verify", and keep the rule that changes to WORKFLOW.md, REVIEW.md, AGENTS.md or CI go to a person. If review is off, do not create a REVIEW.md just to satisfy the example; the human-review handoff still remains.

Retain independent risk-based review, whole-change coverage before a verdict, explicit unverified areas, and evidence-backed findings rather than speculative requirements. Name this repository's existing test-discovery path and allowed test command so the reviewer can create new disposable regression tests in its own clone, run them, and remove them without changing implementation, existing tests, scripts or permissions. Include this narrow scratch-test allowance in AGENTS.md's "Build and verify"; do not grant bare interpreter access or introduce a new test framework just for review.

Keep independent assessment of issue plans and revisions: challenge assumptions and omitted impact, but never let a plan narrow acceptance criteria or waive defects. Self-grill is not independent review. Distinguish concrete in-scope contract failures from outside-scope hardening using triggering conditions, impact and evidence; formatting alone or a justified plan change is not a defect.

Keep the structured `tracker_submit_review` fields from the template: exact `reviewed_head`, `progress`, `progress_reason`, `next_action` and `next_step`, plus verdict, summary and blockers. Follow the runner's initial/rework context; unavailable verification uses `unable_to_verify`, `not_assessed`, `human_required` and a concrete human action (SHA may be null), never just a comment and stop. Preserve complete implementation/review/blocking handoffs on the issue, including relevant human PR feedback and constraints; do not rely on PR links alone or promise automatic copying of every human comment.

## 6. Apply the issue-form choice

Use the Yes/No answer collected in step 2; do not ask a second time. If Yes, copy `$SYMPHONY_HOME/examples/ISSUE_TEMPLATE/agent-task.yml` to `.github/ISSUE_TEMPLATE/`. It deliberately adds no dispatch label; a maintainer decides whether a submitted issue should be added to the board and labeled to start work. If No, do not create the form.

## 7. Check

Run `$SYMPHONY_HOME/bin/symphony check WORKFLOW.md` and fix every error. The only expected warning is the empty `project_number`; explain any other warning you leave.

## 8. Hand over

Show the user what you wrote, then list the next steps. They need the user's GitHub login, so the user runs them in a terminal:

1. Commit and push the files; agents clone the repository, so the files must be on the default branch.
2. `gh auth refresh -s project`, then `$SYMPHONY_HOME/bin/symphony setup-board WORKFLOW.md`: it creates the board, writes `project_number`, and explains that GitHub Project workflows are separate, cannot be configured through the public API, and do not need changes for onboarding. If card statuses later change unexpectedly or skip a Symphony stage, inspect enabled workflows on the project's Workflows page. Commit the number.
3. Before either verification command, set `SYMPHONY_GITHUB_TOKEN` in the current shell. In Bash, use `export SYMPHONY_GITHUB_TOKEN="$(gh auth token)"`; in PowerShell, use `$env:SYMPHONY_GITHUB_TOKEN = gh auth token`. Then run `$SYMPHONY_HOME/bin/symphony check WORKFLOW.md --online` and the read-only dry run `node $SYMPHONY_HOME/src/cli.ts WORKFLOW.md --dry-run --once`. The `symphony` wrapper can load the token itself, but the direct `node` command cannot.
4. Write the first card with the symphony-write-card skill.

Do not create the board, push, or change GitHub settings yourself.
