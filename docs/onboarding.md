# Onboarding a repository

This guide sets up a repository so symphony-copilot agents can work on it. One file, `WORKFLOW.md`, describes everything: the board and its columns, how a workspace is prepared, which commands agents may run, and the agents' prompt. You write it first, and the board is created from it.

1. [Install the skills](#1-install-the-skills)
2. [Write WORKFLOW.md, AGENTS.md and REVIEW.md](#2-write-workflowmd-agentsmd-and-reviewmd)
3. [Create the board](#3-create-the-board)
4. [Write the first card and run](#4-write-the-first-card-and-run)

## Before you start

- First install and sign in to symphony-copilot using the [first-run wizard](#install-and-sign-in).
- The commands below assume `symphony` is on your PATH (`ln -s "$PWD/bin/symphony" /usr/local/bin/symphony` in the symphony-copilot folder). Otherwise call `bin/symphony` by its full path.
- You can push to the repository and create projects for its owner.

## Install and sign in

Clone this repository and run the wizard from its root. It does not require Node.js to start:

```sh
git clone https://github.com/a7744hsc/symphony-copilot.git
cd symphony-copilot
bash scripts/setup.sh
```

On Windows, run PowerShell in this repository folder:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

The wizard checks Node.js 24+, Git 2.38+ (for the merge-conflict check), npm and GitHub CLI, then installs this checkout's dependencies with `npm ci`. If a tool is missing, it gives you the platform's official/recommended source, lets you open the installer page, and checks again after you install it. The supported paths are:

| Platform | Node.js | Git | GitHub CLI |
|---|---|---|---|
| macOS | Official LTS `.pkg` from [nodejs.org](https://nodejs.org/en/download) | Apple Command Line Tools or [git-scm.com](https://git-scm.com/download/mac) | GitHub CLI maintainers' [Homebrew formula or release binaries](https://github.com/cli/cli/blob/trunk/docs/install_macos.md) |
| Linux | Official LTS binaries from [nodejs.org](https://nodejs.org/en/download) | The distribution's official repository | GitHub CLI maintainers' [official repositories](https://github.com/cli/cli/blob/trunk/docs/install_linux.md) |
| Windows | Official LTS `.msi` from [nodejs.org](https://nodejs.org/en/download) | [Git for Windows](https://git-scm.com/download/win) | GitHub CLI maintainers' [WinGet package or release binaries](https://github.com/cli/cli/blob/trunk/docs/install_windows.md) |

Installers may ask for administrator approval. The wizard does not run downloaded scripts or silently elevate privileges. It can install GitHub CLI through the maintainer-supported Homebrew formula on macOS or WinGet package on Windows when you confirm; other missing tools use the official installer instructions above.

If needed, it signs in through `gh auth login` using the browser, requests the `project` scope with `gh auth refresh`, and configures Git with `gh auth setup-git`. It never asks for or writes your password or token into a file. If `gh` is already signed in, it asks whether to reuse that account.

After it finishes, run `symphony install-skills` in this checkout. Then open the target repository in Copilot and run `/symphony-onboard`.

## 1. Install the skills

```sh
symphony install-skills
```

This copies two [agent skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills) into `~/.copilot/skills`, where Copilot in VS Code and Copilot CLI find them:

| Skill | What it does |
|---|---|
| `symphony-onboard` | Reads the repository, asks a few questions, and writes `WORKFLOW.md`, `AGENTS.md` and `REVIEW.md` |
| `symphony-write-card` | Turns a request into an issue an agent can work from, and puts it on the board |

The skills refer to templates in your symphony-copilot folder by absolute path, so run `install-skills` again after moving or updating it. The agents symphony-copilot runs on cards never load these skills.

## 2. Write WORKFLOW.md, AGENTS.md and REVIEW.md

Open the repository in VS Code (or start `copilot` in it) and run `/symphony-onboard`. The skill:

1. works out the clone URL, default branch, and build and test commands from the repository and its CI;
2. asks what it cannot find out: who owns the board, the column names, whether a second agent reviews each change, the models, and the limits per card;
3. writes the three files from the templates in [examples/](../examples/);
4. runs `symphony check` until there are no errors.

| File | Purpose | Template |
|---|---|---|
| `WORKFLOW.md` | Board, columns, hooks, limits, allowed commands, and the implementer's prompt | [examples/WORKFLOW.md](../examples/WORKFLOW.md) |
| `AGENTS.md` | What agents read first: where to start, how to build and verify, hard rules | [examples/AGENTS.md](../examples/AGENTS.md) |
| `REVIEW.md` | The review agent's prompt | [examples/REVIEW.md](../examples/REVIEW.md) |
| `.github/ISSUE_TEMPLATE/agent-task.yml` | Optional issue form with the sections a card needs | [examples/ISSUE_TEMPLATE/agent-task.yml](../examples/ISSUE_TEMPLATE/agent-task.yml) |

To write them by hand, copy the templates and fill them in. Every key of `WORKFLOW.md` is described in [schema/workflow.schema.json](../schema/workflow.schema.json). Check the result:

```sh
symphony check            # ./WORKFLOW.md; or: symphony check path/to/WORKFLOW.md
```

It reports misspelled keys, invalid values, columns that would send a card in circles, and prompts that use unknown variables ([all checks](reference.md#checking-a-workflow)). Leave `project_number` empty for now; the next step fills it in.

Commit and push the files. Agents work in fresh clones, so they only see what is on the default branch.

### Columns

Each column plays one of these roles. The names are yours; these are the template's:

| Column | Listed in | Who works on it |
|---|---|---|
| Todo, In Progress, Rework | `tracker.active_states` | The implementer, on cards with the `agent` label |
| AI Review | `tracker.active_states`, `review.states`, `handoff_state` | The review agent |
| Human Review | `review.pass_state`, `merge_conflicts.states` | You |
| Blocked | `blocked_state`, `agent_states` | You; agents and run limits put cards here |
| Done, Canceled | `tracker.terminal_states` | Nobody; the workspace is deleted |

## 3. Create the board

```sh
symphony setup-board      # ./WORKFLOW.md
```

`setup-board` reads `WORKFLOW.md`, shows what it will create, and asks before changing anything:

- a project owned by `tracker.provider.owner` and linked to the repository, titled after the repository (`--title` changes it);
- a Status field with exactly the columns `WORKFLOW.md` names, in board order;
- a Priority field with P1 to P4 (P1 runs first);
- the dispatch label and the follow-up labels, if the repository does not have them yet.

As soon as the project exists, it writes the number into `tracker.provider.project_number` and says so. Only that line changes; commit it.

If `project_number` already points to a board, `setup-board` shows its name and card count and offers to delete it and start over, or to exit (the default). Deleting needs the board number typed in; the issues stay, but every card's status and fields are lost. It never edits an existing board.

GitHub has no API for a project's workflows, so `setup-board` ends with the settings to change in the browser:

- "Item closed" and "Pull request merged": set the status to your first terminal column;
- "Item added to project": turn it off, or pick a column agents do not work on;
- "Pull request linked to issue": turn it off; it moves the card when the agent opens its pull request;
- "Auto-add to project": turn it on for the repository with the filter `is:issue`.

Then add a Board view to see the columns, and compare the board with `WORKFLOW.md`:

```sh
symphony check --online
```

## 4. Write the first card and run

Run `/symphony-write-card` and describe the task. The skill drafts an issue with a goal, acceptance criteria, how to verify it, and what is out of scope, then creates it and adds it to the board. It only adds the `agent` label and moves the card to an active column if you want the agent to start now. Pick something small the first time.

See what the orchestrator would do, then start it:

```sh
node <symphony-copilot>/src/cli.ts WORKFLOW.md --dry-run --once   # read-only: which cards would run
symphony start WORKFLOW.md                                       # in the background
symphony logs
```

After every session the orchestrator comments on the issue with what the session did and used. When the agent submits, the card moves to AI Review, then to Human Review for you. Merge the pull request, or move the card to Rework with your comments.
