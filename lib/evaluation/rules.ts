// Versioned rule ids, persisted with each result and in evaluation_rules.
export const RULES = {
  nonempty: { id: "nonempty.v1", appliesTo: "all", description: "The reply is not empty." },
  not_truncated: { id: "not_truncated.v1", appliesTo: "all", description: "The reply was not cut off by the output token limit." },
  no_refusal: { id: "no_refusal.v1", appliesTo: "all", description: 'The reply does not refuse or say "as an AI".' },
  word_count: { id: "word_count.v1", appliesTo: "tasks stating a word count", description: "Word count meets the limit or target the task states (targets: within 15%)." },
  per_item_words: { id: "per_item_words.v1", appliesTo: "per-item word limits", description: "Each list item meets the per-item word limit." },
  list_count: { id: "list_count.v1", appliesTo: "tasks asking for N items", description: "At least the requested number of list items." },
  format_json: { id: "format_json.v1", appliesTo: "JSON output", description: "The reply contains valid JSON." },
  json_fields: { id: "json_fields.v1", appliesTo: "JSON with named fields", description: "Every requested field is present." },
  format_list: { id: "format_list.v1", appliesTo: "bullet or numbered lists", description: "The reply uses the requested list format." },
  format_table: { id: "format_table.v1", appliesTo: "tables", description: "The reply contains a Markdown table." },
  format_csv: { id: "format_csv.v1", appliesTo: "CSV", description: "The reply contains comma-separated rows with a consistent column count." },
  code_present: { id: "code_present.v1", appliesTo: "coding", description: "The reply contains code." },
  code_language: { id: "code_language.v1", appliesTo: "coding with a stated language", description: "The code is in the requested language." },
  code_syntax: { id: "code_syntax.v1", appliesTo: "JavaScript, TypeScript and JSON code", description: "The code parses without syntax errors." },
  code_tests: { id: "code_tests.v1", appliesTo: "coding", description: "Tests pass. Not run: Realizah does not execute code yet." },
  citations: { id: "citations.v1", appliesTo: "tasks requiring sources", description: "The reply cites sources (links or a references list)." },
  sections: { id: "sections.v1", appliesTo: "tasks naming sections", description: "Every named section appears." },
  must_include: { id: "must_include.v1", appliesTo: "tasks quoting required phrases", description: "Every quoted phrase appears." },
  language: { id: "language.v1", appliesTo: "tasks naming a language", description: "Written in the requested language. Not checked automatically yet." },
  math_answer: { id: "math_answer.v1", appliesTo: "mathematics and reasoning", description: "The reply states the correct value when the task's arithmetic can be computed; otherwise not checked." },
  extraction_values: { id: "extraction_values.v1", appliesTo: "extraction", description: "Every number, phone number, email and link in the reply appears in the task's source text." },
  extraction_text: { id: "extraction_text.v1", appliesTo: "extraction", description: "Extracted text values appear verbatim in the source; rephrased values are not checked." },
} as const;

export type RuleKey = keyof typeof RULES;
