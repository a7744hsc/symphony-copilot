import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildConfig } from "../src/config.ts";
import { renderIssuePrompt, renderTemplate } from "../src/template.ts";
import { issueForTemplate } from "../src/types.ts";
import { loadWorkflow } from "../src/workflow.ts";
import { makeConfig, makeIssue } from "./helpers.ts";

const root = join(import.meta.dirname, "..");
const issue = makeIssue({ description: "Maintain resource isolation." });

for (const folder of ["", "examples"]) {
  test(`${folder || "repository"} implementation and review prompts preserve proactive verification and complete feedback`, () => {
    const workflow = loadWorkflow(join(root, folder, "WORKFLOW.md"));
    const implementation = renderIssuePrompt(workflow.promptTemplate, issue, 1);
    for (const phrase of [/derive the invariants/, /not an exhaustive edge-case list/, /including unchanged code/, /underlying failure class/, /pagination\.next/, /runtime-saved output/, /translations/]) {
      assert.match(implementation, phrase);
    }
    const reviewer = renderTemplate(readFileSync(join(root, folder, "REVIEW.md"), "utf8"), {
      issue: issueForTemplate(issue), attempt: null, review_round: 4, implementer_workspace: "/work/implement",
    });
    for (const phrase of [/Independently derive the invariants/, /rather than stopping at the first defect/, /all confirmed blockers together/, /Do not approve with material local-code or context access gaps/, /disposable tests/, /existing allowlisted/, /Do not commit/, /Remove only the scratch files/, /precise code path/]) {
      assert.match(reviewer, phrase);
    }
    assert.match(reviewer, /review 4/);
    assert.doesNotMatch(reviewer, /max_review_rounds|last (?:failed )?round|round \d+ of/);
    assert.match(readFileSync(join(root, folder, "AGENTS.md"), "utf8"), /Reviewers may add new disposable/);
  });

  test(`${folder || "repository"} prompts publish complete handoffs and actionable blockers`, () => {
    const implementation = loadWorkflow(join(root, folder, "WORKFLOW.md")).promptTemplate;
    assert.match(implementation, /full record on the issue/);
    assert.match(implementation, /human PR feedback/);
    assert.match(implementation, /external dependenc/);
    assert.match(implementation, /in-scope test failure/);
    assert.match(implementation, /tracker_comment[\s\S]*tried[\s\S]*human action[\s\S]*tracker_set_status[\s\S]*Blocked/);
    assert.match(implementation, /tracker_comment with blocking=true/);
    const reviewer = readFileSync(join(root, folder, "REVIEW.md"), "utf8");
    for (const field of ["reviewed_head", "progress", "progress_reason", "next_action", "next_step", "blocking_issues", "summary"]) {
      assert.ok(reviewer.includes(field), `missing review field ${field}`);
    }
    assert.match(reviewer, /unable_to_verify[\s\S]*not_assessed[\s\S]*human_required/);
    assert.match(reviewer, /null only for unable_to_verify/);
    assert.match(reviewer, /runner.*initial review.*formal rework/);
    assert.match(reviewer, /two consecutive.*no_progress/);
    assert.match(reviewer, /commit count.*line count.*not.*progress/);
    assert.match(reviewer, /full record on the issue/);
    assert.doesNotMatch(reviewer, /use tracker_comment.*and stop/);
  });

  test(`${folder || "repository"} prompts keep autonomous planning on the issue and humans on the Project`, () => {
    const implementation = loadWorkflow(join(root, folder, "WORKFLOW.md")).promptTemplate;
    for (const phrase of [/Implementation plan with tracker_comment before product edits/, /self-grill/, /same session without waiting for human approval/, /Reuse an applicable published plan/, /concise revision/, /reconsider the shared mechanism/, /not human approval/, /Project, not chat interviews/, /without the PR/]) {
      assert.match(implementation, phrase);
    }
    assert.match(implementation, /planning step below before running `git merge/);
    assert.match(implementation, /do not infer human authorship or approval/);
    assert.doesNotMatch(implementation, /the rest from people/);
    const reviewer = readFileSync(join(root, folder, "REVIEW.md"), "utf8");
    for (const phrase of [/Implementation plan and revisions/, /evidence, not authority/, /cannot narrow acceptance criteria/, /self-grill is not independent review/, /outside-scope hardening/, /Plan formatting alone is not a blocker/]) {
      assert.match(reviewer, phrase);
    }
  });

  test(`${folder || "repository"} workflow front matter uses explicit lifecycle mappings and one shared cap`, () => {
    const path = join(root, folder, "WORKFLOW.md");
    const { config: raw } = loadWorkflow(path);
    const config = buildConfig(raw, path, {});
    assert.equal(config.tracker.startState, "Todo");
    assert.equal(config.tracker.workingState, "In Progress");
    assert.equal(config.tracker.blockedState, "Blocked");
    assert.equal(config.agent.maxSessions, 20);
    assert.equal(config.agent.maxConcurrentAgents, 1);
    if (folder === "examples") {
      assert.equal(config.copilot.model, "auto");
      assert.equal(config.review?.model ?? config.copilot.model, "auto");
    } else {
      // The live repository profile may pin user-selected models without changing the contract.
      assert.ok(config.copilot.model?.trim());
      assert.ok((config.review?.model ?? config.copilot.model)?.trim());
    }
    assert.deepEqual(config.tracker.provider.agent_states, ["In Progress", "Blocked"]);
  });
}

test("default continuation prompts do not fall back to example-only repairs or first-defect review", () => {
  const config = makeConfig({
    tracker: { active_states: ["Todo", "In Progress", "Rework", "AI Review"], provider: { handoff_state: "AI Review" } },
    review: { states: ["AI Review"], prompt_file: "REVIEW.md", pass_state: "Human Review", fail_state: "Rework" },
  });
  assert.match(config.agent.continuationPrompt, /failure class/);
  assert.match(config.review!.continuationPrompt, /remaining risk-based coverage/);
  assert.match(config.review!.continuationPrompt, /Remove your disposable tests/);
  for (const prompt of [config.agent.continuationPrompt, config.copilot.userInputReply]) {
    assert.match(prompt, /external dependenc/);
    assert.match(prompt, /tracker_comment with blocking=true/);
    assert.match(prompt, /tracker_comment[\s\S]*tracker_set_status/);
  }
  for (const prompt of [config.review!.continuationPrompt, config.copilot.userInputReply]) {
    assert.match(prompt, /tracker_submit_review[\s\S]*unable_to_verify[\s\S]*not_assessed[\s\S]*human_required/);
  }
  assert.match(config.review!.continuationPrompt, /reviewed_head/);
  assert.match(config.review!.continuationPrompt, /progress_reason/);
});

test("onboarding derives mandatory lifecycle columns without credit budgets or invented model IDs", () => {
  const skill = readFileSync(join(root, "skills/symphony-onboard/SKILL.md"), "utf8");
  for (const phrase of [/start_state/, /working_state/, /blocked_state/, /default 20/, /default 1/, /auto/, /never invent an ID/, /waiting.*Todo/, /working agreement/, /two consecutive/]) {
    assert.match(skill, phrase);
  }
  assert.doesNotMatch(skill, /First `tracker\.active_states`|Blocked lane on:|Blocked lane is off|Only if selected|per-card AI-credit budget|default 8|1000 credits|last failed round/);
  for (const phrase of [/autonomous planning before product edits/, /same session/, /Project control plane/, /Automated answers are not human approval/, /not a write barrier/, /self-grill/i, /never let a plan narrow acceptance criteria/]) assert.match(skill, phrase);
});

test("write-card starts only in the explicit start_state and does not ask users to enumerate edge cases", () => {
  const skill = readFileSync(join(root, "skills/symphony-write-card/SKILL.md"), "utf8");
  assert.match(skill, /Starting now means[\s\S]*tracker\.provider\.start_state/);
  assert.doesNotMatch(skill, /first active|starts in the first|intent, priorities, edge cases/);
  assert.match(skill, /Do not guess.*IDs/);
});
