import { Liquid } from "liquidjs";
import { issueForTemplate, type Issue } from "./types.ts";

const engine = new Liquid({ strictVariables: true, strictFilters: true, ownPropertyOnly: true });

export class TemplateError extends Error {
  readonly code: "template_parse_error" | "template_render_error";
  constructor(code: "template_parse_error" | "template_render_error", message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export function renderTemplate(template: string, scope: Record<string, unknown>): string {
  let parsed;
  try {
    parsed = engine.parse(template);
  } catch (error) {
    throw new TemplateError("template_parse_error", (error as Error).message);
  }
  try {
    return engine.renderSync(parsed, scope).trim();
  } catch (error) {
    throw new TemplateError("template_render_error", (error as Error).message);
  }
}

const FALLBACK_PROMPT = "You are working on an issue from the configured tracker.";

export function renderIssuePrompt(template: string, issue: Issue, attempt: number | null): string {
  return renderTemplate(template.trim() === "" ? FALLBACK_PROMPT : template, { issue: issueForTemplate(issue), attempt });
}

export function renderContinuationPrompt(template: string, issue: Issue, turn: number, maxTurns: number): string {
  return renderTemplate(template, { issue: issueForTemplate(issue), turn, max_turns: maxTurns });
}
