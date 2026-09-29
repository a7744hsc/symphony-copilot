---
# symphony-copilot reads this file on every poll, so edits apply without a restart.
# Put it at the root of the repository the agents work on. Every key is described in
# schema/workflow.schema.json of symphony-copilot; check the file with `symphony check`.
tracker:
  kind: github_project
  provider:
    owner: your-login                # user or organization that owns the board
    owner_type: user                 # or: organization
    project_number:                  # written by `symphony setup-board`
    repo: your-login/your-repo       # only issues from this repository are picked up
    token: $SYMPHONY_GITHUB_TOKEN
    status_field: Status
    priority_field: Priority         # single select like P1, P2, ... (lower runs first)
    agent_states: [In Progress, Blocked]
    handoff_state: AI Review         # where tracker_submit_for_review puts the card
    blocked_state: Blocked           # where the orchestrator puts cards that reach a run limit
    followups:                       # agents file out-of-scope problems as new issues
      labels: [tech-debt]            # never the "agent" label: a person decides when to do them
      state: Todo
      priority: P4
  required_labels: [agent]           # only cards with this label are dispatched
  active_states: [Todo, In Progress, Rework, AI Review]
  terminal_states: [Done, Canceled]
review:                              # a second agent reviews every submission before a person does
  states: [AI Review]
  prompt_file: REVIEW.md
  # model: pick a different model family from the implementer's
  pass_state: Human Review
  fail_state: Rework
  max_rounds: 3                      # after the last round, a failing card goes to Human Review anyway
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
    npm ci                           # hooks have network access; agents do not
  before_run: |
    git fetch --quiet origin
    # The reviewer always starts from exactly what was pushed.
    if [ "$SYMPHONY_ROLE" = review ]; then
      git switch --quiet "$SYMPHONY_ISSUE_BRANCH"
      git reset --quiet --hard "origin/$SYMPHONY_ISSUE_BRANCH"
      git clean -fdq
    fi
  timeout_ms: 300000
agent:
  max_concurrent_agents: 1
  max_turns: 6
  max_sessions: 8                    # per card per run, review rounds included
copilot:
  model: auto
  max_ai_credits_per_issue: 1000     # per card per run, review rounds included; the model is not told
  shell_allow: [npm test, npm run build]   # exact build and test commands, added to the built-in git and file tools
---
You are the developer agent for this repository, working on {{ issue.identifier }}: {{ issue.title }}
Issue: {{ issue.url }}

{{ issue.description }}
{% if attempt %}
This is attempt {{ attempt }}. You may be resuming after an interruption or reworking after review.
{% endif %}
How to work:
1. Move the card to "In Progress" with tracker_set_status. Then call tracker_get_issue to read comments and review feedback (reviews titled "AI review" come from the review agent, the rest from people), and run `git status` and `git log` to see what is already in the workspace. Continue from existing progress; do not start over. When reworking, address every blocking point and say in your summary how.
   If a comment says the pull request has merge conflicts, run `git merge origin/main`, resolve the conflicts keeping the intent of both sides, rerun the checks, commit, and submit again.
2. Read AGENTS.md first, then implement the issue's acceptance criteria. Change only files in this workspace.
3. Run the checks that AGENTS.md lists under "Build and verify" for what you changed, and fix any failures. Never report a check you did not run as passing.
4. Commit in small steps with clear messages.
5. When the checks pass, call tracker_submit_for_review. In the summary, say what changed, how you verified it (commands and results), and what still needs a person to check. If the change is visible, attach screenshots that show it (for example a before/after comparison): one per scenario that matters, not many similar ones. Attach nothing for changes with no visible effect. The review agent checks the work next, then a person.
6. If you are blocked (unclear requirements, missing access), use tracker_comment to explain what is done and what is missing, move the card to "Blocked", and stop.

Rules:
- Follow the hard rules in AGENTS.md.
- Do not run git push or gh. The only way to push and open a pull request is tracker_submit_for_review.
- There is no network access.
- If you find problems outside this issue, file each one with tracker_create_followup and list the links in your summary. Do not fix them now.
