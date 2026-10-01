export type Language = "en" | "zh-CN";

export function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "zh-CN";
}

export function localize(language: Language, english: string, chinese: string): string {
  return language === "zh-CN" ? chinese : english;
}

/** Instructions stay English; only the requested output language changes. */
export function outputLanguageInstruction(language: Language): string {
  const name = language === "zh-CN" ? "Simplified Chinese (zh-CN)" : "English (en)";
  return `## Output language
The workflow language is ${name}. Write all user-facing prose in ${name}, including responses, issue and pull request titles/bodies, plans, progress, review findings, handoffs, follow-ups and blocking explanations. This applies even when the issue, conversation or repository instructions use another language.
Keep the system and repository prompt templates in English; do not create translated prompt copies. Preserve code identifiers, commands, paths, URLs, configured state/label names, tool names, structured protocol keys and enum values, GitHub closing keywords such as Closes, and quoted source/error evidence verbatim. Do not rewrite existing human content merely to translate it.`;
}
