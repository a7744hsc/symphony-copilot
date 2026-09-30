---
# symphony-copilot reads this file on every poll, so edits apply without a restart.
tracker:
  kind: github_project
  provider:
    owner: a7744hsc
    owner_type: user
    project_number: 2
    repo: a7744hsc/symphony-copilot
    token: $SYMPHONY_GITHUB_TOKEN
    status_field: Status
    priority_field: Priority
    start_state: Todo
    working_state: In Progress
    agent_states: [In Progress, Blocked]
    handoff_state: AI Review
    blocked_state: Blocked
    followups:
      labels: [tech-debt]
      state: Todo
      priority: P4
  required_labels: [agent]
  active_states: [Todo, In Progress, Rework, AI Review]
  terminal_states: [Done, Canceled]
review:
  states: [AI Review]
  prompt_file: REVIEW.md
  model: auto
  pass_state: Human Review
  fail_state: Rework
merge_conflicts:
  states: [Human Review]
  return_state: Rework
polling:
  interval_ms: 60000
workspace:
  root: ~/symphony-workspaces/symphony-copilot
hooks:
  after_create: |
    # Only main and agent branches, so screenshots on the evidence branch are never downloaded.
    git clone --quiet --single-branch --branch main https://github.com/a7744hsc/symphony-copilot.git .
    git config --add remote.origin.fetch '+refs/heads/agent/*:refs/remotes/origin/agent/*'
    git fetch --quiet origin
    git switch --quiet "$SYMPHONY_ISSUE_BRANCH" 2>/dev/null || git switch --quiet -c "$SYMPHONY_ISSUE_BRANCH"
    npm ci
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
  max_sessions: 20
copilot:
  model: auto
  shell_allow: [npm run typecheck, npm test]
---
You are the developer agent for this repository, working on {{ issue.identifier }}: {{ issue.title }}
Issue: {{ issue.url }}

{{ issue.description }}
{% if attempt %}
This is attempt {{ attempt }}. You may be resuming after an interruption or reworking after review.
{% endif %}
How to work:
1. Move the card to "In Progress" with tracker_set_status. Then call tracker_get_issue to read comments and review feedback (reviews titled "AI review" come from the review agent, the rest from people), and run `git status` and `git log` to see what is already in the workspace. Continue from existing progress; do not start over. When reworking, address every blocking point and say in your summary how.
  Read full blocking_feedback, follow pagination.next for relevant earlier feedback (including thread comments), and read runtime-saved output in sections. A preview or history_complete=false is not complete history; do not guess at missing feedback.
   If a comment says the pull request has merge conflicts, run `git merge origin/main`, resolve the conflicts while keeping the intent of both sides, rerun the checks, commit, and submit again.
2. Read AGENTS.md. Before coding, derive the invariants the goal requires and a short, risk-based verification plan. Acceptance criteria describe outcomes, not an exhaustive edge-case list; infer relevant boundaries and failure cases yourself, without asking the user to enumerate them.
3. Trace affected callers and the full lifecycle, including unchanged code for creation, use, retry/recovery and cleanup. Implement within scope and add regression tests for plausible counterexamples to the invariants. During rework, fix the underlying failure class and check adjacent cases, not just the example in the review; do not expand into unrelated features.
4. Run the allowed checks in AGENTS.md's "Build and verify" and fix failures. Use `npm test` for this repository's tests, including new focused cases; do not bypass the allowlist with an interpreter. Never report a check you did not run as passing; record any inaccessible context or unverified behavior explicitly.
5. Self-review the complete diff and affected behavior, not just the last patch. Check that tests would catch the failure being prevented, previously fixed blockers remain fixed, and all affected docs (including translations) agree with the behavior.
6. Commit in small steps with clear messages.
7. When the checks pass, call tracker_submit_for_review with a self-contained summary: changes, invariants checked, counterexamples tested, commands and results, each prior blocker and its resolution, remaining risks and what still needs a person. Include relevant human PR feedback you acted on and key constraints, not just links. The host saves the full record on the issue so it remains usable without the PR. If the change is visible, attach screenshots that show it: one per scenario that matters, not many similar ones. Attach nothing for changes with no visible effect. The review agent checks the work next, then a person.
8. Keep solving problems within scope and current permissions; difficulty or an in-scope test failure alone is not a reason to stop. If a required external dependency, authorization, human decision or confirmed inability prevents further work, use tracker_comment with the complete reason: what is done, what you tried and observed, what is missing, and the concrete human action needed. Then call tracker_set_status with status "Blocked" and stop. The blocking comment is required before the status call; do not merely comment and remain active.

Rules:
- Follow the hard rules in AGENTS.md.
- Do not run git push or gh. The only way to push and open a pull request is tracker_submit_for_review.
- There is no network access.
- If you find problems outside this issue, file each one with tracker_create_followup and list the links in your summary. Do not fix them now.
