import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseDocument } from "yaml";
import { buildConfig } from "../src/config.ts";
import { composeAgentPrompt, renderIssuePrompt, renderTemplate } from "../src/template.ts";
import { issueForTemplate } from "../src/types.ts";
import { loadWorkflow } from "../src/workflow.ts";
import { makeConfig, makeIssue } from "./helpers.ts";

const root = join(import.meta.dirname, "..");
const issue = makeIssue({ description: "Maintain resource isolation." });

for (const folder of ["", "examples"]) {
  test(`${folder || "repository"} selects its output language without translating prompt sources`, () => {
    const path = join(root, folder, "WORKFLOW.md");
    const workflow = loadWorkflow(path);
    const config = buildConfig(workflow.config, path, {});
    const language = folder === "examples" ? "en" : "zh-CN";
    assert.equal(workflow.config.language, language, "the language must be explicitly configured");
    assert.equal(config.language, language);
    assert.ok(config.review);
    const templates = {
      implement: workflow.promptTemplate,
      review: readFileSync(config.review.promptFile, "utf8"),
    };
    for (const role of ["implement", "review"] as const) {
      assert.doesNotMatch(templates[role], /\p{Script=Han}/u);
      const prompt = composeAgentPrompt(templates[role], role, true, config.language);
      assert.match(prompt, language === "en" ? /The workflow language is English \(en\)/ : /The workflow language is Simplified Chinese \(zh-CN\)/);
      assert.ok(prompt.endsWith(templates[role]));
    }
  });

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

test("the repository issue form uses Chinese without changing its protocol or dispatch behavior", () => {
  const form = parseDocument(readFileSync(join(root, ".github/ISSUE_TEMPLATE/agent-task.yml"), "utf8"));
  assert.deepEqual(form.errors, []);
  assert.equal(form.get("name"), "Agent 任务");
  assert.equal(form.has("labels"), false);
  assert.equal(form.has("projects"), false);
  const sections = [
    ["goal", "目标", true],
    ["acceptance", "验收标准", true],
    ["verify", "验证方式", true],
    ["out-of-scope", "范围之外", undefined],
    ["notes", "备注", undefined],
  ] as const;
  for (const [index, [id, label, required]] of sections.entries()) {
    assert.equal(form.getIn(["body", index, "type"]), "textarea");
    assert.equal(form.getIn(["body", index, "id"]), id);
    assert.equal(form.getIn(["body", index, "attributes", "label"]), label);
    assert.equal(form.getIn(["body", index, "validations", "required"]), required);
  }
  assert.equal(form.getIn(["body", sections.length]), undefined);
  assert.equal(form.getIn(["body", 1, "attributes", "value"]), "- [ ]\n");
  for (const path of [["description"], ...sections.map((_, index) => ["body", index, "attributes", "description"])]) {
    const description = form.getIn(path);
    assert.ok(typeof description === "string");
    assert.match(description, /\p{Script=Han}/u);
  }
  const example = readFileSync(join(root, "examples/ISSUE_TEMPLATE/agent-task.yml"), "utf8");
  assert.doesNotMatch(example, /\p{Script=Han}/u);
});

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

test("onboarding requires an explicit output-language choice even with recommended setup", () => {
  const skill = readFileSync(join(root, "skills/symphony-onboard/SKILL.md"), "utf8");
  for (const phrase of [
    /Explicitly ask the user.*English \(`en`\).*Simplified Chinese \(`zh-CN`\)/,
    /Do not infer it from the conversation or repository/,
    /Require an explicit choice before generating files, even if the user accepts the recommended setup/,
    /If the answer omits the language, ask only for that missing choice; do not auto-default it/,
    /Always write top-level `language: en` or `language: zh-CN`/,
    /Omission defaults to `en` only for older or hand-written workflows/,
    /including `null`.*invalid/,
    /Do not rename existing columns or rewrite existing user content/,
  ]) assert.match(skill, phrase);
  assert.doesNotMatch(skill, /Write prose in the language the user writes|Use the user's conversation language|localized to the user's language/);
});

test("onboarding preserves English prompt sources and localizes only selected documentation", () => {
  const skill = readFileSync(join(root, "skills/symphony-onboard/SKILL.md"), "utf8");
  for (const phrase of [
    /single English prompt source/,
    /WORKFLOW\.md body and REVIEW\.md stay in English in both modes, except configured column names/,
    /runtime adds the output-language instruction; do not translate or duplicate these prompts/,
    /New AGENTS\.md prose may use the selected language/,
    /keep its existing content/,
    /visible name, descriptions and section labels may use the selected language/,
    /preserve YAML keys, field IDs, validation rules and the absence of dispatch labels/,
    /Do not overwrite an existing user-authored form/,
  ]) assert.match(skill, phrase);

  const path = join(root, "examples/WORKFLOW.md");
  const workflow = loadWorkflow(path);
  assert.equal(workflow.config.language, "en");
  assert.match(readFileSync(path, "utf8"), /language: en\s+# explicitly choose en \(English\) or zh-CN \(Simplified Chinese\) during onboarding/);
  assert.doesNotMatch(workflow.promptTemplate, /\p{Script=Han}/u);
  assert.doesNotMatch(readFileSync(join(root, "examples/REVIEW.md"), "utf8"), /\p{Script=Han}/u);
});

test("write-card starts only in the explicit start_state and does not ask users to enumerate edge cases", () => {
  const skill = readFileSync(join(root, "skills/symphony-write-card/SKILL.md"), "utf8");
  assert.match(skill, /Starting now means[\s\S]*tracker\.provider\.start_state/);
  assert.doesNotMatch(skill, /first active|starts in the first|intent, priorities, edge cases/);
  assert.match(skill, /Do not guess.*IDs/);
});

test("write-card uses configured language for title, headings and body rather than conversation", () => {
  const skill = readFileSync(join(root, "skills/symphony-write-card/SKILL.md"), "utf8");
  for (const phrase of [
    /title, all section headings and body in the configured output language/,
    /even when the conversation is in a different language/,
    /Read top-level `language`: `en` means English; `zh-CN` means Simplified Chinese/,
    /missing key in an older workflow defaults to `en`/,
    /do not infer language from the conversation, issue text or column names/,
    /Reject other values, including `null`/,
    /write the entire body in Simplified Chinese/,
    /`目标`, `验收标准`, `验证方式`, `范围之外` and `备注`/,
    /Keep identifiers, commands, paths and quoted existing user content unchanged/,
  ]) assert.match(skill, phrase);
  assert.doesNotMatch(skill, /Write in the language the user writes to you/);
});
