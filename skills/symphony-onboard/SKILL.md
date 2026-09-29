---
name: symphony-onboard
description: Set up a repository so symphony-copilot agents can work on it. Reads the repository's build and test setup, asks which workflow capabilities the user wants (independent AI review, merge-conflict recovery, blocked/follow-up handling), derives board columns automatically instead of asking the user to invent them, writes WORKFLOW.md, AGENTS.md and optional REVIEW.md from templates, and validates with `symphony check`. Use when the user wants to onboard a repository, choose board workflow behavior, or write/fix WORKFLOW.md, AGENTS.md or REVIEW.md.
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
- Automatically detect PR merge conflicts while a PR waits for a person and return the card to the implementer? Recommend Yes; if No, explain a person can move it back manually.
- A visible Blocked lane when an agent hits a run limit or cannot proceed? Recommend Yes; if No, omit the column and explain the card remains paused until a person intervenes.
- Let agents file low-priority follow-up issues for unrelated problems? Recommend No if issue noise is a concern; when Yes, explain follow-ups use `tech-debt` and P4 and do not receive the dispatch label, so never start automatically. Clarify this is separate from the issue form below.
- Implementer model defaults to `auto` (Copilot selects an available model). Do not present an unverified model list. If the user requests a fixed model, use an ID they provide or one verified as available; otherwise keep `auto`. Also ask concurrent agents (default 1), sessions per card/run (default 8), and per-card AI-credit budget; review rounds count toward it.
- Per-card AI-credit budget: recommend 1000 credits per run as the starting cap; it covers implementer and reviewer calls together and the run halts at the cap. Explain that higher caps permit more work but may incur more usage, and let the user lower or raise it.
- Board owner only if it cannot be inferred: default to repository owner; `gh api users/<owner> --jq .type` distinguishes user from organization.
- Dispatch label (default `agent`); only issues with this label are eligible.
- Add an optional GitHub task issue form? Recommend Yes. Explain it only adds a structured New issue form for human-written tasks (goal, acceptance, verification, scope, notes); it does not create, label, dispatch, or start issues. This is distinct from agent-generated follow-up issues.

Use the user's conversation language for questions and generated column names. Do not ask for individual column names. Show the derived lane plan after the capability answers; the user may ask to rename lanes. Keep chosen names consistent in WORKFLOW.md, REVIEW.md and the handoff summary.

### Derive columns from the selected behavior

Use these default names, localized to the user's language when appropriate, in this order, deduplicating shared roles:

| Role | Default column | Mapping |
|---|---|---|
| New work | Todo | First `tracker.active_states` item; requires the dispatch label |
| Implementation | In Progress | Implementer active state; `tracker.provider.agent_states` |
| Rework | Rework | Add when either independent AI review or conflict recovery is enabled; review failures and/or conflicted PRs return here |
| Independent check | AI Review | Only with independent AI review; `review.states` and handoff state |
| Human decision | Human Review | Always; direct handoff without AI review, pass state with it; conflict-wait state if enabled |
| Blocked | Blocked | Only if selected; `tracker.provider.blocked_state`; allow agents to set it |
| Complete | Done, Canceled | `tracker.terminal_states`; keep Done first for closed/merged automation |

Generate config consistently from the answers:

- Derive `tracker.active_states` exactly as follows (Blocked is never active):

  | AI review | Conflict recovery | `tracker.active_states` |
  |---|---|---|
  | On | On or off | `[Todo, In Progress, Rework, AI Review]` |
  | Off | On | `[Todo, In Progress, Rework]` |
  | Off | Off | `[Todo, In Progress]` |

- AI review on: include AI Review and Rework in `active_states`; hand off to AI Review; pass to Human Review; fail to Rework; include `review` and generate REVIEW.md. On the last failed round the runtime hands the card to Human Review. Rework is needed even if conflict recovery is off.
- AI review off: omit `review` and REVIEW.md; hand off directly to Human Review; omit AI Review. Include Rework only if conflict recovery is on.
- Conflict recovery on: include Rework in `active_states` and set `merge_conflicts.states: [Human Review]`, `return_state: Rework`. If off, omit `merge_conflicts`; when AI review is also off, omit Rework.
- Blocked lane on: add the Blocked column, set `blocked_state: Blocked`, and include Blocked in `agent_states`. When the visible lane is off, omit both Blocked and `blocked_state`; adapt the prompt to have the agent comment with the blocker and stop without trying to set a Blocked status. The orchestrator still records the run limit and waits for a person to move the card.
- Follow-ups on: configure `followups` with `state: Todo`, `labels: [tech-debt]`, and `priority: P4`; never attach the dispatch label. Todo is the human intake queue; an issue is not picked up until a person explicitly labels it for dispatch.
- Set `terminal_states: [Done, Canceled]`. `agent_states` contains only statuses an agent may set directly: `[In Progress]`, plus Blocked if selected. Do not list every active state; AI Review, Rework, Human Review and terminal states are set by submission/review/orchestrator tools, not `tracker_set_status`.

Before writing, show a compact preview, for example: “AI reviewer: on; conflict return: on; blocked lane: on; task issue form: yes; columns: Todo → In Progress → Rework → AI Review → Human Review → Blocked → Done → Canceled.” Then generate from this plan; do not copy the full-featured example unchanged.

## 3. Write WORKFLOW.md

Start from the templates and change only what this repository needs and the user selected. The example WORKFLOW.md is a full-featured reference profile, not a requirement to keep every lane.

- Leave `project_number:` empty. `symphony setup-board` creates the board later and writes the number.
- Apply the derived lane plan from step 2. Remove the `review` section and do not create REVIEW.md when independent AI review is off. Do not keep unused Rework or AI Review columns. Use each selected column name consistently; `symphony setup-board` creates exactly the states named by WORKFLOW.md. `symphony check` enforces these rules:
  - review states are also in `active_states`, and one of them is `handoff_state`;
  - `review.pass_state` is a waiting column, not an active one;
  - `review.fail_state` and `merge_conflicts.return_state` are active columns the implementer works;
  - `blocked_state` is not active and not in `merge_conflicts.states`;
  - `followups.labels` never contain a `required_labels` label.
- `hooks.after_create`: keep the template's single-branch clone and branch switch, then install dependencies (hooks have network access; agents do not) and copy local-only files. `hooks.before_run`: keep the fetch and the reviewer reset. Replace `main` with the default branch in the hooks and the prompt.
- `copilot.shell_allow`: the exact build, test and lint commands, as prefixes, for example `npm test` or `swift test`. Do not add entries that run arbitrary code: `node`, `python3`, `bash`, `sh`, `npx`, or a bare `npm run`. git and basic file commands are built in.
- `workspace.root`: `~/symphony-workspaces/<repository name>`, outside the repository.
- The prompt: keep the template's steps and rules, replace every example state with the generated localized name, and make verify fit this repository. If the Blocked lane is off, replace instructions to move a card to Blocked with “comment with the blocker and stop”; if follow-ups are off, remove the instruction to file follow-up issues; if conflict recovery is off, say a person must move a conflicted PR back to an implementation state. The PR-submission/handoff step stays enabled even when AI review is off.

## 4. Write AGENTS.md

If the repository has one, keep it and add only what is missing: a "Build and verify" section (commands, plus a table of what changed and what to run at least) and the hard rules "evidence first", "no push: only tracker_submit_for_review" and "no network or new dependencies". Keep it a short map with links, not a manual.

## 5. Write REVIEW.md only when selected

If independent AI review is on, start from the template, point its verify step at AGENTS.md's "Build and verify", and keep the rule that changes to WORKFLOW.md, REVIEW.md, AGENTS.md or CI go to a person. If review is off, do not create a REVIEW.md just to satisfy the example; the human-review handoff still remains.

## 6. Apply the issue-form choice

Use the Yes/No answer collected in step 2; do not ask a second time. If Yes, copy `$SYMPHONY_HOME/examples/ISSUE_TEMPLATE/agent-task.yml` to `.github/ISSUE_TEMPLATE/`. It deliberately adds no dispatch label; a maintainer decides whether a submitted issue should be added to the board and labeled to start work. If No, do not create the form.

## 7. Check

Run `$SYMPHONY_HOME/bin/symphony check WORKFLOW.md` and fix every error. The only expected warning is the empty `project_number`; explain any other warning you leave.

## 8. Hand over

Show the user what you wrote, then list the next steps. They need the user's GitHub login, so the user runs them in a terminal:

1. Commit and push the files; agents clone the repository, so the files must be on the default branch.
2. `gh auth refresh -s project`, then `$SYMPHONY_HOME/bin/symphony setup-board WORKFLOW.md`: it creates the board, writes `project_number`, and lists the project settings to change in the browser. Commit the number.
3. `$SYMPHONY_HOME/bin/symphony check WORKFLOW.md --online`, then a dry run: `node $SYMPHONY_HOME/src/cli.ts WORKFLOW.md --dry-run --once`.
4. Write the first card with the symphony-write-card skill.

Do not create the board, push, or change GitHub settings yourself.
