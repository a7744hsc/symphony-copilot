import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collisionMessage, defaultWorkflowId, describeWorkflow, type WorkflowInstance } from "../src/instance.ts";

function workflow(root: string, owner = "octo", project = 1): string {
  const dir = mkdtempSync(join(tmpdir(), "symphony-instance-"));
  const path = join(dir, "WORKFLOW.md");
  writeFileSync(path, `---
tracker:
  kind: github_project
  provider:
    owner: ${owner}
    project_number: ${project}
  active_states: [Todo]
  terminal_states: [Done]
workspace:
  root: ${root}
---
Work.
`);
  return path;
}

function instance(overrides: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return {
    id: "one",
    workflowPath: "/repos/one/WORKFLOW.md",
    workspaceRoot: "/state/one",
    ledgerPath: "/state/one/.symphony-ledger.json",
    project: "github_project:user:octo:1",
    ...overrides,
  };
}

test("workflow descriptors have stable default IDs and isolated paths", () => {
  const path = workflow("/tmp/workflow-one");
  const first = describeWorkflow(path);
  const second = describeWorkflow(path);
  assert.equal(first.id, defaultWorkflowId(path));
  assert.equal(first.id, second.id);
  assert.equal(first.workspaceRoot, "/tmp/workflow-one");
  assert.equal(first.ledgerPath, "/tmp/workflow-one/.symphony-ledger.json");
  assert.equal(first.project, "github_project:user:octo:1");
});

test("custom workflow IDs are validated", () => {
  const path = workflow("/tmp/workflow-custom");
  assert.equal(describeWorkflow(path, "team.backend").id, "team.backend");
  assert.throws(() => describeWorkflow(path, "Bad ID"), /workflow ID must/);
});

test("active runner collisions explain the unsafe resource", () => {
  const candidate = instance({ id: "two", workflowPath: "/repos/two/WORKFLOW.md", workspaceRoot: "/state/two", ledgerPath: "/state/two/.symphony-ledger.json" });
  assert.match(collisionMessage(candidate, [instance()]) ?? "", /same GitHub Project.*card claiming is not coordinated/);
  assert.match(collisionMessage({ ...candidate, project: "github_project:user:octo:2", workspaceRoot: "/state/one", ledgerPath: "/state/one/.symphony-ledger.json" }, [instance()]) ?? "", /shares state.*workspace\.root/);
  assert.equal(collisionMessage({ ...candidate, project: "github_project:user:octo:2" }, [instance()]), null);
});
