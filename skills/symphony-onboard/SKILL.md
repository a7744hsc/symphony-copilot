---
name: symphony-onboard
description: Set up a repository so symphony-copilot agents can work on it. Reads the repository's build and test setup, asks a few questions, writes WORKFLOW.md (board columns, hooks, allowed commands, agent prompt), AGENTS.md and REVIEW.md from symphony-copilot's templates, and validates them with `symphony check`. Use when the user wants to onboard a repository to symphony-copilot, write or fix a WORKFLOW.md, or prepare AGENTS.md or REVIEW.md for agents.
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

Ask only what the repository cannot tell you, in one message, each with your proposed default:

- Board owner: the repository owner, or an organization? (`gh api users/<owner> --jq .type` tells User from Organization.)
- Column names: default Todo, In Progress, Rework, AI Review, Human Review, Blocked, Done, Canceled. Offer names in the user's language.
- AI review: on (default) or off, and the reviewer's model, ideally from a different model family than the implementer's.
- Implementer model (default auto), agents at once (default 1), AI credits per card (`copilot.max_ai_credits_per_issue`, default 1000 with review) and sessions per card (`agent.max_sessions`, default 8).
- Follow-up issues for out-of-scope problems: on (default) with label tech-debt and priority P4.
- The dispatch label: default agent.

## 3. Write WORKFLOW.md

Start from the template and change only what this repository needs.

- Leave `project_number:` empty. `symphony setup-board` creates the board later and writes the number.
- Use each column name the same way everywhere. setup-board creates exactly the columns WORKFLOW.md names. `symphony check` enforces these rules:
  - review states are also in `active_states`, and one of them is `handoff_state`;
  - `review.pass_state` is a waiting column, not an active one;
  - `review.fail_state` and `merge_conflicts.return_state` are active columns the implementer works;
  - `blocked_state` is not active and not in `merge_conflicts.states`;
  - `followups.labels` never contain a `required_labels` label.
- `hooks.after_create`: keep the template's single-branch clone and branch switch, then install dependencies (hooks have network access; agents do not) and copy local-only files. `hooks.before_run`: keep the fetch and the reviewer reset. Replace `main` with the default branch in the hooks and the prompt.
- `copilot.shell_allow`: the exact build, test and lint commands, as prefixes, for example `npm test` or `swift test`. Do not add entries that run arbitrary code: `node`, `python3`, `bash`, `sh`, `npx`, or a bare `npm run`. git and basic file commands are built in.
- `workspace.root`: `~/symphony-workspaces/<repository name>`, outside the repository.
- The prompt: keep the template's steps and rules, and make the verify step fit this repository.

## 4. Write AGENTS.md

If the repository has one, keep it and add only what is missing: a "Build and verify" section (commands, plus a table of what changed and what to run at least) and the hard rules "evidence first", "no push: only tracker_submit_for_review" and "no network or new dependencies". Keep it a short map with links, not a manual.

## 5. Write REVIEW.md

Only when review is on. Start from the template, point its verify step at AGENTS.md's "Build and verify", and keep the rule that changes to WORKFLOW.md, REVIEW.md, AGENTS.md or CI go to a person.

## 6. Offer the issue form

Copy `$SYMPHONY_HOME/examples/ISSUE_TEMPLATE/agent-task.yml` to `.github/ISSUE_TEMPLATE/`. It adds no labels on purpose: only a maintainer should start an agent.

## 7. Check

Run `$SYMPHONY_HOME/bin/symphony check WORKFLOW.md` and fix every error. The only expected warning is the empty `project_number`; explain any other warning you leave.

## 8. Hand over

Show the user what you wrote, then list the next steps. They need the user's GitHub login, so the user runs them in a terminal:

1. Commit and push the files; agents clone the repository, so the files must be on the default branch.
2. `gh auth refresh -s project`, then `$SYMPHONY_HOME/bin/symphony setup-board WORKFLOW.md`: it creates the board, writes `project_number`, and lists the project settings to change in the browser. Commit the number.
3. `$SYMPHONY_HOME/bin/symphony check WORKFLOW.md --online`, then a dry run: `node $SYMPHONY_HOME/src/cli.ts WORKFLOW.md --dry-run --once`.
4. Write the first card with the symphony-write-card skill.

Do not create the board, push, or change GitHub settings yourself.
