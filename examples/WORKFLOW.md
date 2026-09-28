---
# Put this file at the root of the repository the agents work on.
# symphony-copilot re-reads it on every poll, so edits apply without a restart.
tracker:
  kind: github_project
  provider:
    owner: your-login                # user or organization that owns the project
    owner_type: user                 # or: organization
    project_number: 1
    repo: your-login/your-repo       # only issues from this repository are picked up
    token: $SYMPHONY_GITHUB_TOKEN
    status_field: Status
    priority_field: Priority         # single select like P1, P2, ... (lower runs first)
    agent_states: [In Progress, Blocked]
    handoff_state: Human Review
    blocked_state: Blocked           # where the orchestrator puts cards that reach a run limit
    followups:                       # agents file out-of-scope problems as new issues
      labels: [tech-debt]            # no "agent" label, so a person decides when to do them
      state: Todo
      priority: P4
  required_labels: [agent]           # only cards with this label are dispatched
  active_states: [Todo, In Progress, Rework]
  terminal_states: [Done, Canceled]
merge_conflicts:                     # a PR that stops merging while it waits goes back to the agent, first in line
  states: [Human Review]
  return_state: Rework
polling:
  interval_ms: 60000
workspace:
  root: ~/symphony-workspaces/your-repo
hooks:
  after_create: |
    # Only main and agent branches, so screenshots on the evidence branch are never downloaded.
    git clone --quiet --single-branch --branch main https://github.com/your-login/your-repo.git .
    git config --add remote.origin.fetch '+refs/heads/agent/*:refs/remotes/origin/agent/*'
    git fetch --quiet origin
    git switch --quiet "$SYMPHONY_ISSUE_BRANCH" 2>/dev/null || git switch --quiet -c "$SYMPHONY_ISSUE_BRANCH"
    npm ci
  before_run: |
    git fetch --quiet origin
  timeout_ms: 300000
agent:
  max_concurrent_agents: 2
  max_turns: 6
  max_sessions: 3                    # per card per run
copilot:
  model: auto
  max_ai_credits_per_issue: 100      # per card per run; the model is not told
  shell_allow: [npm test, npm run]   # added to the built-in git and file tools
---
You are the developer agent for this repository, working on {{ issue.identifier }}: {{ issue.title }}
Issue: {{ issue.url }}

{{ issue.description }}
{% if attempt %}
This is attempt {{ attempt }}. You may be resuming after an interruption or reworking after review.
{% endif %}
How to work:
1. Move the card to "In Progress" with tracker_set_status. Then call tracker_get_issue to read comments and review feedback, and run `git status` and `git log` to see what is already in the workspace. Continue from existing progress; do not start over.
   If a comment says the pull request has merge conflicts, run `git merge origin/main`, resolve the conflicts keeping the intent of both sides, rerun the checks, commit, and submit again.
2. Read AGENTS.md or README.md first, then implement the issue's acceptance criteria. Change only files in this workspace.
3. Run `npm test` and fix any failures.
4. Commit in small steps with clear messages.
5. When the checks pass, call tracker_submit_for_review. In the summary, say what changed, how you verified it (commands and results), and what still needs a human to check. If the change is visible, attach screenshots that show it (for example a before/after comparison): one per scenario that matters, not many similar ones. Attach nothing for changes with no visible effect.
6. If you are blocked (unclear requirements, missing access), use tracker_comment to explain what is done and what is missing, move the card to "Blocked", and stop.

Rules:
- Do not run git push or gh. The only way to push and open a pull request is tracker_submit_for_review.
- There is no network access.
- If you find problems outside this issue, file each one with tracker_create_followup and list the links in your summary. Do not fix them now.
