---
name: symphony-write-card
description: Write a task card for symphony-copilot agents. Turns a request into a GitHub issue with a goal, acceptance criteria, how to verify and scope, adds it to the project board named in WORKFLOW.md, and starts it only if the user wants. Use when the user wants to create a card, task or issue for the agents, or to split work into agent-sized issues.
---

<!-- Installed by symphony-copilot install-skills from $SYMPHONY_HOME. Rerun it after updating symphony-copilot. -->

# Write a card for symphony-copilot

An agent works from the issue alone, so the card has to say what done means and how to prove it. Write the title, all section headings and body in the configured output language, even when the conversation is in a different language. Keep identifiers, commands, paths and quoted existing user content unchanged.

## 1. Read the setup

- `WORKFLOW.md` at the repository root: `tracker.provider.owner`, `project_number`, `repo`, `status_field`, `priority_field`, `tracker.provider.start_state` (the explicit start column) and `tracker.required_labels` (the dispatch label). If `project_number` or `start_state` is empty, stop and fix onboarding; do not infer a start column from active-state order.
- Read top-level `language`: `en` means English; `zh-CN` means Simplified Chinese. A missing key in an older workflow defaults to `en`; do not infer language from the conversation, issue text or column names. Reject other values, including `null`, and fix configuration before drafting.
- AGENTS.md, "Build and verify": the commands the card can refer to.

## 2. Understand the request

Look at the code involved so the card names real files, commands and behavior. Infer relevant invariants and edge cases yourself; ask the user only for missing intent, priorities or decisions, not an exhaustive case list.

## 3. Size it

One card is one pull request that a person can review in one sitting. If the request is bigger, propose several cards that each ship on their own, and say which one has to wait for which.

## 4. Draft

Title: imperative and specific, under 70 characters, in the configured language. Use the English scaffold below for `en`; for `zh-CN`, write the entire body in Simplified Chinese and use the headings `目标`, `验收标准`, `验证方式`, `范围之外` and `备注` respectively. Do not leave English headings or placeholder prose in a Chinese card.

```markdown
### Goal

What should be different, and why, in two or three sentences.

### Acceptance criteria

- [ ] An observable result, checkable by running or looking at something ("works well" is not one)

### How to verify

Commands from AGENTS.md and what their output should show, and what only a person can check (devices, visuals, feel).

### Out of scope

Nearby things not to touch.

### Notes

Links, files to start from, constraints.
```

## 5. Confirm

In the configured language, show the draft and a priority (P1 is highest, P4 lowest), then ask: create and start now, create without starting, or change something.

## 6. Create

Use `gh`, logged in as the user:

1. `gh issue create --repo <repo> --title "<title>" --body-file <file>`. Add `--label <dispatch label>` only if agents should work on it.
2. `gh project item-add <project_number> --owner <owner> --url <issue url> --format json` returns the item id.
3. `gh project view <project_number> --owner <owner> --format json --jq .id` returns the project id, and `gh project field-list <project_number> --owner <owner> --format json` the field and option ids.
4. Set the priority, and the status when starting now: `gh project item-edit --id <item id> --project-id <project id> --field-id <field id> --single-select-option-id <option id>`.

Do not guess project, field or option IDs: use the returned metadata and match the configured column name exactly.

Starting now means `tracker.provider.start_state` and the dispatch label. Otherwise leave the status empty or pick a waiting column without the dispatch label. Never start by moving to In Progress, Rework or AI Review; those are scheduler-managed. For an existing card, renewed authorization is a human move from a waiting column to `start_state`, not an automatic retry or conflict return. If the card must wait for another issue, say so in Notes and mark it as blocked by that issue on GitHub; the orchestrator waits until blockers are closed.

## 7. Report

In the configured language, report the issue URL, its exact configured column and labels, and whether an agent picks it up at the next poll.

Never put secrets in an issue; in a public repository anyone can read it.
