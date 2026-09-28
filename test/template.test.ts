import assert from "node:assert/strict";
import { test } from "node:test";
import { renderContinuationPrompt, renderIssuePrompt, TemplateError } from "../src/template.ts";
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
