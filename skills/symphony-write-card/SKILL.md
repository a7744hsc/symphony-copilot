---
name: symphony-write-card
description: Write a task card for symphony-copilot agents. Turns a request into a GitHub issue with a goal, acceptance criteria, how to verify and scope, adds it to the project board named in WORKFLOW.md, and starts it only if the user wants. Use when the user wants to create a card, task or issue for the agents, or to split work into agent-sized issues.
---

<!-- Installed by symphony-copilot install-skills from $SYMPHONY_HOME. Rerun it after updating symphony-copilot. -->

# Write a card for symphony-copilot

An agent works from the issue alone, so the card has to say what done means and how to prove it. Write in the language the user writes to you.

## 1. Read the setup

- `WORKFLOW.md` at the repository root: `tracker.provider.owner`, `project_number`, `repo`, `status_field`, `priority_field`, `tracker.required_labels` (the dispatch label) and `tracker.active_states` (new work starts in the first one). If `project_number` is empty, stop: the board does not exist yet; the symphony-onboard skill explains the setup.
- AGENTS.md, "Build and verify": the commands the card can refer to.

## 2. Understand the request

Look at the code involved so the card names real files, commands and behavior. Ask the user only what you cannot find out: intent, priorities, edge cases.

## 3. Size it

One card is one pull request that a person can review in one sitting. If the request is bigger, propose several cards that each ship on their own, and say which one has to wait for which.

## 4. Draft

Title: imperative and specific, under 70 characters. Body, with the sections of the issue form:

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

Show the draft and a priority (P1 is highest, P4 lowest), then ask: create and start now, create without starting, or change something.

## 6. Create

Use `gh`, logged in as the user:

1. `gh issue create --repo <repo> --title "<title>" --body-file <file>`. Add `--label <dispatch label>` only if agents should work on it.
2. `gh project item-add <project_number> --owner <owner> --url <issue url> --format json` returns the item id.
3. `gh project view <project_number> --owner <owner> --format json --jq .id` returns the project id, and `gh project field-list <project_number> --owner <owner> --format json` the field and option ids.
4. Set the priority, and the status when starting now: `gh project item-edit --id <item id> --project-id <project id> --field-id <field id> --single-select-option-id <option id>`.

Starting now means the first active column and the dispatch label. Otherwise leave the status empty or pick a column that is not active: without the label, or outside the active columns, no agent starts. If the card must wait for another issue, say so in Notes and mark it as blocked by that issue on GitHub; the orchestrator waits until blockers are closed.

## 7. Report

The issue URL, its column and labels, and whether an agent picks it up at the next poll.

Never put secrets in an issue; in a public repository anyone can read it.
