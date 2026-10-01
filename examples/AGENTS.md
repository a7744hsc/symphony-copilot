# AGENTS.md

<!-- Template from symphony-copilot's examples/AGENTS.md. Replace every <...>; delete what does not apply. -->

<One or two sentences: what this project is, who it is for, and the main technologies.>

This file is a map: entry points and hard rules only; details live in the linked docs. When a doc and the code disagree, the code wins; fix the doc in the same pull request.

## Where to start

| Task | Read first |
|---|---|
| Any task | The issue on the board, then [README.md](README.md) |
| <Change an area, for example the API> | <doc or directory> |

## Build and verify

```sh
<install command>    # WORKFLOW.md's after_create hook runs it; agents have no network
<build command>
<test command>
```

| What changed | Run at least |
|---|---|
| <area or directory> | <command> |
| Docs only | <link check, or nothing> |

Agents may only run commands listed in `copilot.shell_allow` in WORKFLOW.md; keep that list and this section in step.

Reviewers may add new disposable tests in their own review checkout's normal test-discovery paths and run the existing allowed test command; remove those files before the verdict. Do not modify implementation, existing tests, scripts or permissions, and do not commit. See [REVIEW.md](REVIEW.md).

## Hard rules

1. **Evidence first.** Never report a check you did not run as passing. Say in the pull request what you ran and what happened, and list what only a person can verify.
2. **No push.** When symphony-copilot runs you, pushing and opening pull requests happen only through `tracker_submit_for_review`.
3. **No network and no new dependencies** unless the issue asks for them.
4. <Project rule, for example supported platform versions, or generated files that must not be edited by hand.>

## Working agreement

- One issue, one branch (`agent/<number>`), one pull request. A review agent ([REVIEW.md](REVIEW.md)) checks it before a person does.
- When behavior or conventions change, update the docs in the same pull request.
- Derive invariants and edge cases from the goal and affected lifecycle, including unchanged callers and cleanup. On rework, fix the failure class rather than only the reported example; keep unrelated work out of scope.
- Problems outside the issue become new low-priority issues (with `tracker_create_followup` when symphony-copilot runs you), not drive-by fixes.
