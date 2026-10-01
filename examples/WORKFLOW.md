---
# symphony-copilot reads this file on every poll, so edits apply without a restart.
# Put it at the root of the repository the agents work on. Every key is described in
# schema/workflow.schema.json of symphony-copilot; check the file with `symphony check`.
# This is a full-capability reference profile: independent AI review, conflict return,
# a visible Blocked lane, and follow-up issues are all enabled. The symphony-onboard
# skill asks which capabilities you want and derives a smaller set of columns when off.
language: en                       # explicitly choose en (English) or zh-CN (Simplified Chinese) during onboarding
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
    start_state: Todo               # human start/reauthorization entry from a waiting column
    working_state: In Progress      # scheduler-managed; do not move running cards manually
    agent_states: [In Progress, Blocked] # only statuses agents may set directly
    handoff_state: AI Review         # where tracker_submit_for_review puts the card
    blocked_state: Blocked           # required: startup failure, human blocker, no progress or exhausted sessions
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
  max_sessions: 20                   # successfully created implementer + reviewer sessions per authorization
copilot:
  model: auto
  shell_allow: [npm test, npm run build]   # exact build and test commands, added to the built-in git and file tools
---
You are the developer agent for this repository, working on {{ issue.identifier }}: {{ issue.title }}
Issue: {{ issue.url }}

{{ issue.description }}
{% if attempt %}
This is attempt {{ attempt }}. You may be resuming after an interruption or reworking after review.
{% endif %}
How to work:
1. Move the card to "In Progress" with tracker_set_status. Then call tracker_get_issue to read plans, handoffs, review feedback and human comments; do not infer human authorship or approval from a comment title or automated reply. Run `git status` and `git log` to see what is already in the workspace. Continue from existing progress; do not start over. When reworking, address every blocking point and say in your summary how.
  Read full blocking_feedback, follow pagination.next for relevant earlier feedback (including thread comments), and read runtime-saved output in sections. A preview or history_complete=false is not complete history; do not guess at missing feedback.
  If a comment says the pull request has merge conflicts, complete the planning step below before running `git merge origin/main`, resolve the conflicts keeping the intent of both sides, rerun the checks, commit, and submit again.
2. Read AGENTS.md. Before coding, derive the invariants the goal requires and a short, risk-based verification plan. Acceptance criteria describe outcomes, not an exhaustive edge-case list; infer relevant boundaries and failure cases yourself, without asking the user to enumerate them.
  Follow the runtime's autonomous planning protocol: inspect evidence, compare meaningful approaches, self-grill material assumptions and lifecycle risks, and publish a concise Implementation plan with tracker_comment before product edits. Include the goal/non-goals, affected components, chosen approach, verification and steps; distinguish evidence from assumptions. Continue implementation in the same session without waiting for human approval. Reuse an applicable published plan; on rework, record a concise revision explaining changed decisions and verification. The issue must retain enough context without the PR.
3. Trace affected callers and the full lifecycle, including unchanged code for creation, use, retry/recovery and cleanup. Implement within scope and add regression tests for plausible counterexamples to the invariants. During rework, fix the underlying failure class and check adjacent cases, not just the example in the review; do not expand into unrelated features.
  If adjacent examples of the same class keep appearing, reconsider the shared mechanism rather than adding another example-specific patch. Do not republish an unchanged plan on continuation. Read the issue again after an uncertain comment result before retrying; do not claim an unconfirmed publication succeeded.
4. Run the allowed checks in AGENTS.md's "Build and verify" and fix failures. Use the repository's existing test entry point for new focused cases; do not bypass the allowlist with an interpreter. Never report a check you did not run as passing; record any inaccessible context or unverified behavior explicitly.
5. Self-review the complete diff and affected behavior, not just the last patch. Check that tests would catch the failure being prevented, previously fixed blockers remain fixed, and all affected docs (including translations) agree with the behavior.
6. Commit in small steps with clear messages.
7. When the checks pass, call tracker_submit_for_review with a self-contained summary: changes, invariants checked, counterexamples tested, commands and results, each prior blocker and its resolution, remaining risks and what still needs a person. Include relevant human PR feedback you acted on and key constraints, not just links. The host saves the full record on the issue so it remains usable without the PR. If the change is visible, attach screenshots that show it (for example a before/after comparison): one per scenario that matters, not many similar ones. Attach nothing for changes with no visible effect. The review agent checks the work next, then a person.
8. Keep solving problems within scope and current permissions; difficulty or an in-scope test failure alone is not a reason to stop. If a required external dependency, authorization, human decision or confirmed inability prevents further work, use tracker_comment with blocking=true and the complete reason: what is done, what you tried and observed, what is missing, and the concrete human action needed. Then call tracker_set_status with status "Blocked" and stop. The blocking comment is required before the status call; plans/progress leave blocking unset or false and cannot serve as a blocking reason. Do not merely comment and remain active.

Rules:
- Follow the hard rules in AGENTS.md.
- People control authorization through the Project, not chat interviews. Automated replies are not human approval; do not invent requirements, expand permissions or weaken acceptance criteria. Missing consequential requirements use the Blocked path above, not a fabricated answer. Do not invoke interactive brainstorming/grill-me/grilling or add a separate planner agent; self-grill does not replace independent review.
- Do not run git push or gh. The only way to push and open a pull request is tracker_submit_for_review.
- There is no network access.
- If you find problems outside this issue, file each one with tracker_create_followup and list the links in your summary. Do not fix them now.
