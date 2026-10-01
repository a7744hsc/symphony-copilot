import assert from "node:assert/strict";
import { test } from "node:test";
import { composeAgentPrompt, renderContinuationPrompt, renderIssuePrompt, TemplateError } from "../src/template.ts";
import { makeIssue } from "./helpers.ts";

test("prompt renders issue fields, labels, and attempt", () => {
  const issue = makeIssue({ identifier: "GH-7", title: "Fix", labels: ["agent", "ui"] });
  const template = "{{ issue.identifier }} {{ issue.title }}{% for l in issue.labels %} #{{ l }}{% endfor %}{% if attempt %} retry {{ attempt }}{% endif %}";
  assert.equal(renderIssuePrompt(template, issue, null), "GH-7 Fix #agent #ui");
  assert.equal(renderIssuePrompt(template, issue, 2), "GH-7 Fix #agent #ui retry 2");
});

test("null fields render as empty, unknown variables and filters fail", () => {
  assert.equal(renderIssuePrompt("[{{ issue.description }}]", makeIssue(), null), "[]");
  assert.throws(() => renderIssuePrompt("{{ issue.nope }}", makeIssue(), null), (e: TemplateError) => e.code === "template_render_error");
  assert.throws(() => renderIssuePrompt("{{ oops }}", makeIssue(), null), (e: TemplateError) => e.code === "template_render_error");
  assert.throws(() => renderIssuePrompt("{{ issue.title | shout }}", makeIssue(), null), (e: TemplateError) => e.code === "template_parse_error");
});

test("empty template falls back to a minimal prompt", () => {
  assert.equal(renderIssuePrompt("  ", makeIssue(), null), "You are working on an issue from the configured tracker.");
});

test("continuation prompt gets turn and max_turns", () => {
  assert.equal(renderContinuationPrompt("{{ issue.identifier }} {{ turn }}/{{ max_turns }}", makeIssue(), 2, 5), "GH-1 2/5");
});

test("one English prompt specifies the selected output language in both roles and every turn", () => {
  for (const language of ["en", "zh-CN"] as const) {
    for (const role of ["implement", "review"] as const) {
      for (const firstTurn of [true, false]) {
        const prompt = composeAgentPrompt("Literal {{ unrendered }}. Use the issue evidence.", role, firstTurn, language);
        assert.ok(prompt.endsWith("Literal {{ unrendered }}. Use the issue evidence."));
        assert.ok(prompt.includes(`The workflow language is ${language === "en" ? "English (en)" : "Simplified Chinese (zh-CN)"}.`));
        assert.match(prompt, /even when the issue, conversation or repository instructions use another language/);
        assert.match(prompt, /issue and pull request titles\/bodies.*plans.*review.*follow-ups.*blocking/);
        assert.match(prompt, /prompt templates in English/);
        assert.match(prompt, /enum values.*Closes/);
        assert.doesNotMatch(prompt, /[\u3400-\u9fff]/, "the prompt itself remains English");
      }
    }
  }
});

test("implementer receives proportional planning and self-grill without replacing the repository prompt", () => {
  const repository = "Use this project's checks. Literal {{ not_a_template }} stays intact.";
  const prompt = composeAgentPrompt(repository, "implement", true);
  assert.ok(prompt.endsWith(repository), "already rendered content is neither templated again nor dropped");
  for (const rule of [/tracker_get_issue/, /pagination\.next/, /history_complete=false/, /Self-grill/, /evidence.*assumptions/, /unchanged callers/, /failure.*retry.*cleanup/, /alternatives/, /verification/, /tracker_comment/, /before product edits/, /same session/]) {
    assert.match(prompt, rule);
  }
  assert.match(prompt, /Reuse an applicable existing plan/);
  assert.match(prompt, /underlying failure class/);
  assert.match(prompt, /reconsider the shared mechanism/);
  assert.match(prompt, /read the issue again before retrying/);
  assert.match(prompt, /stop without product edits/);
  assert.match(prompt, /not human approval/);
  assert.match(prompt, /Do not wait for a chat answer/);
  assert.match(prompt, /tracker_set_status/);
  assert.match(prompt, /blocking=true/);
  assert.match(prompt, /progress comments must leave blocking unset or false/);
  assert.match(prompt, /Do not invent requirements.*weaken acceptance criteria/);
});

test("reviewer independently challenges issue plans without an implementation or planning handoff", () => {
  const prompt = composeAgentPrompt("Repository review rules and progress context.", "review", true);
  assert.ok(prompt.endsWith("Repository review rules and progress context."));
  assert.match(prompt, /plans and revisions.*current issue/);
  assert.match(prompt, /not authority/);
  assert.match(prompt, /cannot narrow acceptance criteria/);
  assert.match(prompt, /independently/i);
  assert.match(prompt, /outside-scope hardening/);
  assert.match(prompt, /tracker_submit_review[\s\S]*unable_to_verify[\s\S]*human_required/);
  assert.doesNotMatch(prompt, /tracker_comment|tracker_set_status|tracker_submit_for_review/);
});

test("both roles get short continuation reminders, not a fresh planning exercise", () => {
  for (const role of ["implement", "review"] as const) {
    const prompt = composeAgentPrompt("Continue custom task.", role, false);
    assert.ok(prompt.endsWith("Continue custom task."));
    assert.match(prompt, /not human approval/);
    assert.doesNotMatch(prompt, /## Autonomous planning|## Independent plan assessment/);
    if (role === "implement") {
      assert.match(prompt, /Continue the existing plan/);
      assert.match(prompt, /do not republish an unchanged plan/);
      assert.match(prompt, /still missing/);
    } else {
      assert.match(prompt, /remaining independent checks/);
      assert.doesNotMatch(prompt, /tracker_comment|tracker_set_status/);
    }
  }
});
