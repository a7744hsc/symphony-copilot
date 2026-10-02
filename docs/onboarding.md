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

This bootstrap installation wizard remains English: the repository's output-language choice happens during onboarding below.

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

Unattended planning is built into the runner; no personal planning skill installation is needed. Interactive `brainstorming`, `grill-me` and `grilling` are disabled for card workers, not removed from your own editor. Symphony supplies its own autonomous planning/self-questioning instructions instead of their human interview/approval gates.

## 2. Write WORKFLOW.md, AGENTS.md and REVIEW.md

Open the repository in VS Code (or start `copilot` in it) and run `/symphony-onboard`. You do not need to know or preselect board columns. The skill first inspects the repository, then explicitly asks you to choose the output language—English (`en`) or Simplified Chinese (`zh-CN`)—alongside the operating capabilities:

1. Whether an independent AI reviewer should check each submission before it reaches you (human approval before merge is always retained).
2. Whether to automatically detect merge conflicts on PRs waiting for a person and send them back to the implementer.
3. Whether agents may file low-priority follow-up issues without the dispatch label for unrelated problems.
4. Whether to add the optional structured GitHub issue form for human-written agent tasks.

It collects choices in one batch, recommends capability defaults, and explains cost/behavior tradeoffs. “Use the recommended setup” does not choose a language: the skill must obtain your explicit language choice before generating files, never infer it from the conversation or repository. Onboarding defaults to concurrency 1, implementer/reviewer models `auto`, and 20 total successfully started sessions per issue authorization, shared by both roles—not 20 pairs. Fixed model IDs must be supplied by you or verified for your account; no guessed model list. Costs are recorded, not capped, so there is no credit-budget question. Blocked is mandatory, not an optional capability. The skill infers board owner, build/test commands and default branch where possible, then derives and previews columns rather than asking you to invent a state machine. AI review adds AI Review and Rework; without it submissions go directly to Human Review. Rework remains if conflict recovery is enabled. The skill writes the selected files and runs `symphony check` until there are no errors.

The choice is written as top-level `language: en` or `language: zh-CN` in `WORKFLOW.md`. Its generated prompt body and REVIEW.md remain English in both modes, apart from configured names and repository-specific references; there is no second translated prompt set. New AGENTS.md prose and the optional issue form may use the selected language. Existing user content is not rewritten. The runtime instructs both agents to write plans, cards, issue/PR handoffs and reviews in the configured language. Host-generated status/failure messages and usage footers follow it too; technical logs and CLI diagnostics remain English. See [output language](reference.md#output-language) for reload and recovery behavior.

| File | Purpose | Template |
|---|---|---|
| `WORKFLOW.md` | Board, columns, hooks, limits, allowed commands, and the implementer's prompt | [examples/WORKFLOW.md](../examples/WORKFLOW.md) |
| `AGENTS.md` | What agents read first: where to start, how to build and verify, hard rules | [examples/AGENTS.md](../examples/AGENTS.md) |
| `REVIEW.md` | The review agent's prompt | [examples/REVIEW.md](../examples/REVIEW.md) |
| `.github/ISSUE_TEMPLATE/agent-task.yml` | Optional structured “New issue” form with Goal, Acceptance criteria, How to verify, Out of scope and Notes | [examples/ISSUE_TEMPLATE/agent-task.yml](../examples/ISSUE_TEMPLATE/agent-task.yml) |

The optional issue form only guides people writing issues. It does not create an issue, put it on the project, add the dispatch label, or start an agent. Agent-generated follow-up issues are a separate capability. A maintainer still chooses which submitted issue should be dispatched.

To write them by hand, copy the templates and fill them in, including your chosen `language`. Older or hand-written workflows that omit the key default to `en`; any other value, including `null`, is rejected. This compatibility default does not replace the onboarding question. Every key of `WORKFLOW.md` is described in [schema/workflow.schema.json](../schema/workflow.schema.json). Check the result:

```sh
symphony check            # ./WORKFLOW.md; or: symphony check path/to/WORKFLOW.md
```

It reports misspelled keys, invalid values, columns that would send a card in circles, and prompts that use unknown variables ([all checks](reference.md#checking-a-workflow)). Leave `project_number` empty for now; the next step fills it in.

上述 CLI 步骤面向人在 onboarding 时使用，不代表无人值守 agent 获得了执行权限。维护 symphony-copilot 本仓库时，实现者和审查者应按 [AGENTS.md](../AGENTS.md) 运行已允许的 `npm test`，其中包含根 workflow 和示例的同一离线 checker；不必扩大 shell allowlist。此等价步骤不覆盖在线检查，也不表示其他仓库的 `npm test` 自动包含 workflow 检查。详见[检查范围](reference.md#checking-a-workflow)。

Commit and push the files. Agents work in fresh clones, so they only see what is on the default branch.

### Columns

Each column has a role derived from the selected behavior. New names may be localized to your explicitly selected output language, not your conversation language; you can ask to rename them, but do not need to design the workflow yourself. Changing `language` later does not rename existing columns:

| Column | Listed in | Who works on it |
|---|---|---|
| Todo | Always active; required `start_state` | Human start/reauthorization entry, on cards with the dispatch label |
| In Progress | Always active; required `working_state` | Scheduler-managed implementation |
| Rework | Active when independent AI review or conflict recovery is on | The implementer addresses review requests and/or merge-conflict returns |
| AI Review | Only when independent AI review is on | The independent reviewer |
| Human Review | Always a waiting/handoff lane | You review and merge the PR; conflicts are monitored here if selected |
| Blocked | Always required `blocked_state`; never active or conflict-monitored | Waiting for human action after a blocker, startup failure, no progress or session exhaustion |
| Done, Canceled | Terminal | Human merges the PR or closes the issue; workspace cleanup follows |

**Working agreement, not a permission lock:** people start new cards in Todo and return existing cards only from waiting columns (Human Review/Blocked) to Todo. This renews the allowance and clears the no-progress streak while preserving work and issue history. Do not manually move cards into or out of In Progress, Rework or AI Review; those belong to the scheduler. Other board automation must not return existing cards to Todo. Automatic conflict return to Rework and process restarts never reset the allowance or restart paused/exhausted work.

Planning is part of In Progress/Rework, not a new column or approval step. The implementer investigates the repository, chooses an approach, self-grills material assumptions and publishes a concise Implementation plan on the issue before product edits, then implements in the same session. Existing plans are reused and materially revised on rework. People do not answer a planning interview; automated replies are not human approval, and missing consequential decisions or authority still go to Blocked. Independent AI review, when enabled, challenges the plan as well as the code rather than treating self-grill as approval. These are behavioral instructions, not a filesystem write gate; see the [method and limits](reference.md#implementation-and-review-method).

A session counts when SDK creation succeeds; preparation/startup failures beforehand pause without a charge or endless retry. Reviews can continue while making progress: the first reviewed no-progress rework needs a changed approach, two consecutive ones pause, and human-required results pause immediately. Initial findings and infrastructure failures do not add strikes. Missing review evidence uses `unable_to_verify`, not a silent comment-and-stop. There is no separate review-round, credit or absolute elapsed-time cap; operational startup/inactivity timeouts still apply.

For older workflows, add the three explicit lifecycle mappings and remove retired credit/review caps and template variables; see [migration guidance](../README.md#run-limits). Run the offline checker before starting again.

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

New board and label descriptions use the configured `language`; identifiers and explicitly configured names stay unchanged. This does not translate an existing board.

If `project_number` already points to a board, `setup-board` shows its name and card count and offers to delete it and start over, or to exit (the default). Deleting needs the board number typed in; the issues stay, but every card's status and fields are lost. It never edits an existing board.

GitHub Project workflows are separate from `WORKFLOW.md` and can change card statuses automatically. GitHub's public API does not let `setup-board` configure or enable these workflows, and onboarding does not require you to change them. If a card changes status unexpectedly or skips a Symphony stage, inspect the enabled workflows in the browser at the project's **Workflows** page; one may be responsible.

Then add a Board view to see the columns, and compare the board with `WORKFLOW.md`:

```sh
symphony check --online
```

The `symphony` wrapper gets its token from `gh auth token`. Before running the direct `node` command below, set the token in the current shell: use `export SYMPHONY_GITHUB_TOKEN="$(gh auth token)"` in Bash, or `$env:SYMPHONY_GITHUB_TOKEN = gh auth token` in PowerShell. The direct Node.js invocation does not load the GitHub token automatically.

## 4. Write the first card and run

Run `/symphony-write-card` and describe the task. The skill uses `WORKFLOW.md`'s `language` for the title, all headings and the body even if you chat in another language (missing means `en`). It drafts an issue with a goal, acceptance criteria, how to verify it, and what is out of scope, asks for confirmation, then creates it and adds it to the board. It only adds the dispatch label and moves the card to `tracker.provider.start_state` if you want to start now, never by guessing the first active column or option IDs. Pick something small the first time.

See what the orchestrator would do, then start it:

```sh
node <symphony-copilot>/src/cli.ts WORKFLOW.md --dry-run --once   # read-only: which cards would run
symphony start WORKFLOW.md                                       # in the background
symphony logs
```

Implementation, review and blocking handoffs retain full records on the issue, including relevant human PR feedback and constraints, not just PR links. Usage is a best-effort footer in the session's selected language on that result, using this session's credits and actual model(s). Detailed metrics stay in logs; missing metrics or a failed update may leave no footer. There is no separate usage-only comment or durable footer retry queue.

After submission, independent review (if enabled) precedes Human Review. Merge the PR or close the issue to finish; to request more work, leave feedback and move the waiting card to Todo, not Rework.

For multiple repositories on this host, configure a different GitHub Project and a separate, non-nested `workspace.root` for each workflow. Give each runner a stable `--id` when starting it, then target that ID with `status`, `logs` or `stop`; stopping one leaves the others running. The original no-ID commands remain valid when only one workflow is registered. See [multiple-workflow commands](../README.md#multiple-workflows-on-one-host) and [ownership/recovery rules](reference.md#runner-management-and-recovery). Different repository filters or `SYMPHONY_STATE_DIR` values do not permit sharing a project board.
