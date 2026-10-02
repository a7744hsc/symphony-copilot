# AGENTS.md

symphony-copilot turns GitHub Project cards into pull requests by running local GitHub Copilot agents in isolated workspaces. It is a Node.js 22.18+ TypeScript project with no build output.

This file is a map: entry points and hard rules only; details live in the linked docs. When a doc and the code disagree, the code wins; fix the doc in the same pull request.

## Where to start

| Task | Read first |
|---|---|
| Any task | The issue on the board, then [README.md](README.md) |
| Orchestration or agent lifecycle | [src/orchestrator.ts](src/orchestrator.ts), [src/runner.ts](src/runner.ts) |
| GitHub Projects integration | [src/tracker/github-project.ts](src/tracker/github-project.ts), [docs/reference.md](docs/reference.md) |
| Workflow configuration or policy | [src/config.ts](src/config.ts), [src/policy.ts](src/policy.ts), [schema/workflow.schema.json](schema/workflow.schema.json) |
| CLI or setup | [src/cli.ts](src/cli.ts), [src/check.ts](src/check.ts), [docs/onboarding.md](docs/onboarding.md) |

## Build and verify

The workspace hook installs dependencies before an agent starts:

```sh
npm ci
npm run typecheck
npm test
```

| What changed | Run at least |
|---|---|
| TypeScript source, tests, workflow schema, or runtime behavior | `npm run typecheck` and `npm test` |
| `WORKFLOW.md` or onboarding examples | `npm test` (includes offline workflow checks) |
| Documentation only | Check links and commands against the current code; no automated command is required |

For this repository's implementers and reviewers, `npm test` is the required equivalent of offline `symphony check`: `test/check.test.ts` calls the same `checkWorkflow` function for both `WORKFLOW.md` and `examples/WORKFLOW.md`, including their prompt templates, without a token or network access. The root workflow must have no findings; the example may only warn about its unset `project_number`. This does not verify the CLI wrapper or the live board. Other workflow files need explicit test coverage; do not assume `npm test` checks arbitrary paths.

Direct `symphony`/`bin/symphony` commands are not allowlisted for unattended agents. Do not add them or broad interpreter permissions just to run this check. Human onboarding can still use the CLI as described in [docs/onboarding.md](docs/onboarding.md).

Agents may only run commands listed in `copilot.shell_allow` in WORKFLOW.md; keep that list and this section in step.

Reviewers may add new disposable `test/review-probe-*.test.ts` tests in their own review checkout and run `npm test`; remove those files before the verdict. Do not modify implementation, existing tests, scripts or permissions, and do not commit. See [REVIEW.md](REVIEW.md).

## Hard rules

1. **Evidence first.** Never report a check you did not run as passing. Say in the pull request what you ran and what happened, and list what only a person can verify.
2. **No push.** When symphony-copilot runs you, pushing and opening pull requests happen only through `tracker_submit_for_review`.
3. **No network and no new dependencies** unless the issue asks for them.
4. Keep configuration behavior, [schema/workflow.schema.json](schema/workflow.schema.json), [docs/reference.md](docs/reference.md), and the examples consistent.

## Working agreement

- One issue, one branch (`agent/<number>`), one pull request. The independent reviewer follows [REVIEW.md](REVIEW.md) before a person reviews.
- When behavior or conventions change, update the docs in the same pull request.
- Derive invariants and edge cases from the goal and affected lifecycle, including unchanged callers and cleanup. On rework, fix the failure class rather than only the reported example; keep unrelated work out of scope.
- Problems outside the issue become low-priority follow-up issues through `tracker_create_followup`, not drive-by fixes.
