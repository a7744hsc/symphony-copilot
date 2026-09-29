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
./scripts/setup.sh
```

On Windows, run PowerShell in this repository folder:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

The project supports Node.js 22.18+, but on a fresh setup the wizard installs the latest Node.js 24 LTS by default. It checks Node.js, Git 2.38+ (for the merge-conflict check), npm, GitHub CLI (`gh`), and GitHub Copilot CLI (`copilot`). It lists every missing tool, its source and whether administrator approval may be requested, then asks once before installing. Node.js is downloaded as an official Node.js 24 LTS archive, checked against the official `SHASUMS256.txt`, and installed under your user profile (no administrator access); the wizard adds its bin directory to login and interactive shell startup files. Copilot CLI is installed from the official npm package `@github/copilot` into a user-local prefix to provide the interactive `copilot login` command. symphony itself still launches the runtime bundled with `@github/copilot-sdk`; both use the user's Copilot data under `~/.copilot`. Git and GitHub CLI are installed through the platform's supported package manager when available. If a package manager is unavailable, the wizard says which tools need manual installation before it starts. After prerequisites pass, the wizard separately asks before running `npm ci` in this checkout.

The setup has been exercised on this development machine with GitHub CLI `2.101.0` (2026-09-29). The wizard does not enforce a minimum `gh` version; it checks only that the command exists. It never automatically upgrades an already-installed `gh`, so an older CLI may fail later if it lacks a command or option this workflow uses. Upgrade it yourself with its package manager if needed.

| Platform | Node.js | Git | GitHub CLI |
|---|---|---|---|
| macOS | Latest Node 24 LTS archive from [nodejs.org](https://nodejs.org/en/download), SHA-256 checked, user-local | Homebrew when installed | GitHub CLI maintainers' Homebrew formula when Homebrew is installed |
| Debian/Ubuntu | Latest Node 24 LTS archive from [nodejs.org](https://nodejs.org/en/download), SHA-256 checked, user-local | Distribution's official `apt` repository | GitHub CLI maintainers' official apt repository |
| Fedora/RHEL | Latest Node 24 LTS archive from [nodejs.org](https://nodejs.org/en/download), SHA-256 checked, user-local | Distribution's official `dnf` repository | GitHub CLI maintainers' official RPM repository |
| openSUSE | Latest Node 24 LTS archive from [nodejs.org](https://nodejs.org/en/download), SHA-256 checked, user-local | Distribution's official `zypper` repository | GitHub CLI maintainers' official RPM repository |
| Windows | Latest Node 24 LTS archive from [nodejs.org](https://nodejs.org/en/download), SHA-256 checked, user-local | Microsoft's WinGet `Git.Git` package | GitHub CLI maintainers' WinGet `GitHub.cli` package |

Package managers may ask for administrator approval (for example via `sudo` or a Windows elevation prompt); the wizard only starts them after you approve its install plan. On Linux it runs package commands directly if the shell is already root, and uses `sudo` only for a non-root user. The Node.js installer itself needs no administrator privileges. It downloads only official archives and checks the published SHA-256; it does not pipe network scripts into a shell. On macOS without Homebrew, Git and GitHub CLI need manual installation from Apple's Command Line Tools and the [GitHub CLI maintainer instructions](https://github.com/cli/cli/blob/trunk/docs/install_macos.md). Unsupported Linux distributions are reported rather than guessing a package command. GitHub sign-in is completed by you in the browser when `gh auth login` opens it; the wizard does not automate that security approval.

GitHub CLI and Copilot CLI authentication are handled together in the setup sign-in phase. The wizard signs in through `gh auth login` (or asks whether to reuse the existing account), checks the active account's scopes with `gh auth status --json hosts`, and requests the `project` scope with `gh auth refresh` only if it is missing. It then configures Git with `gh auth setup-git` and checks Copilot sign-in using the SDK runtime's `getAuthStatus()` API. If already authenticated, setup reuses that session and skips `copilot login`; otherwise it asks which OAuth flow to use: device code (`copilot login --device-code`, the default and recommended for containers/remote shells) or browser link (`copilot login --web-flow`, which opens a local browser and prints a URL if needed). Approve the selected OAuth flow yourself. Setup does not read or write either token itself. Copilot CLI stores its credential in the OS keychain when available; on a headless Linux/container without a keychain, it may offer to store the token in plaintext under `~/.copilot/config.json` (or `$COPILOT_HOME/config.json`). Only accept that option in a private environment you trust; ephemeral containers discard it when removed.

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

Open the repository in VS Code (or start `copilot` in it) and run `/symphony-onboard`. You do not need to know or preselect board columns. The skill first inspects the repository, then asks which operating capabilities you want:

1. Whether an independent AI reviewer should check each submission before it reaches you (human approval before merge is always retained).
2. Whether to automatically detect merge conflicts on PRs waiting for a person and send them back to the implementer.
3. Whether to show a Blocked lane for run limits and work that needs human input.
4. Whether agents may file low-priority, unlabelled follow-up issues for unrelated problems.
5. Whether to add the optional structured GitHub issue form for human-written agent tasks.

It asks these together once, recommends defaults, and explains cost/behavior tradeoffs. It also asks about implementer/reviewer model, concurrency, sessions and the per-card AI-credit budget (recommended starting cap: 1000 credits per run, shared by implementer and reviewer). It infers board owner, language, build/test commands and default branch where possible. From capability choices it derives and previews the columns; it does **not** expect you to invent a state machine. For example, independent AI review adds AI Review and Rework; turning it off removes AI Review and sends submissions directly to Human Review. Rework remains if conflict recovery is enabled. Human Review is always the final person-owned step. After your choices, the skill writes `WORKFLOW.md`, `AGENTS.md`, optional `REVIEW.md`, and the issue form only if selected, then runs `symphony check` until there are no errors.

| File | Purpose | Template |
|---|---|---|
| `WORKFLOW.md` | Board, columns, hooks, limits, allowed commands, and the implementer's prompt | [examples/WORKFLOW.md](../examples/WORKFLOW.md) |
| `AGENTS.md` | What agents read first: where to start, how to build and verify, hard rules | [examples/AGENTS.md](../examples/AGENTS.md) |
| `REVIEW.md` | The review agent's prompt | [examples/REVIEW.md](../examples/REVIEW.md) |
| `.github/ISSUE_TEMPLATE/agent-task.yml` | Optional structured “New issue” form with Goal, Acceptance criteria, How to verify, Out of scope and Notes | [examples/ISSUE_TEMPLATE/agent-task.yml](../examples/ISSUE_TEMPLATE/agent-task.yml) |

The optional issue form only guides people writing issues. It does not create an issue, put it on the project, add the dispatch label, or start an agent. Agent-generated follow-up issues are a separate capability. A maintainer still chooses which submitted issue should be dispatched.

To write them by hand, copy the templates and fill them in. Every key of `WORKFLOW.md` is described in [schema/workflow.schema.json](../schema/workflow.schema.json). Check the result:

```sh
symphony check            # ./WORKFLOW.md; or: symphony check path/to/WORKFLOW.md
```

It reports misspelled keys, invalid values, columns that would send a card in circles, and prompts that use unknown variables ([all checks](reference.md#checking-a-workflow)). Leave `project_number` empty for now; the next step fills it in.

Commit and push the files. Agents work in fresh clones, so they only see what is on the default branch.

### Columns

Each column has a role derived from the selected behavior. The names are localized to your conversation language by default; you can ask to rename them, but do not need to design the workflow yourself:

| Column | Listed in | Who works on it |
|---|---|---|
| Todo, In Progress | Always active | The implementer, on cards with the `agent` label |
| Rework | Active when independent AI review or conflict recovery is on | The implementer addresses review requests and/or merge-conflict returns |
| AI Review | Only when independent AI review is on | The independent reviewer |
| Human Review | Always a waiting/handoff lane | You review and merge the PR; conflicts are monitored here if selected |
| Blocked | Only when the visible blocked-lane capability is on | You unblock it; the agent or run limits can move cards here. With this lane off, the agent comments and stops without changing status |
| Done, Canceled | Terminal | Nobody; the workspace is deleted |

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
