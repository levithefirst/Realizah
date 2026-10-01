import { test } from "node:test";
import assert from "node:assert/strict";
import { countWords, evaluate } from "../lib/evaluation/evaluate";
import { understandTask } from "../lib/task/understand";

const U = (task: string, useCase = "") => understandTask({ task, useCase });
const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
const status = (e: ReturnType<typeof evaluate>, rule: string) => e.checks.find((c) => c.rule.startsWith(rule))?.status;

test("a reply under a word limit is not automatically a pass", () => {
  const u = U("Write a 1,000-word article about remote work.");
  const short = evaluate(words(80), "stop", u);
  assert.equal(short.passed, false);
  assert.equal(status(short, "word_count"), "fail");
  assert.equal(evaluate(words(1000), "stop", u).passed, true);
  assert.equal(evaluate(words(1140), "stop", u).passed, true); // within 15%
  assert.equal(evaluate(words(1200), "stop", u).passed, false);
});

test("limits, minimums and per-item limits", () => {
  assert.equal(evaluate(words(100), "stop", U("Keep it under 100 words.")).passed, true);
  assert.equal(evaluate(words(101), "stop", U("Keep it under 100 words.")).passed, false);
  assert.equal(evaluate(words(137), "stop", U("Write about tea."), { wordMax: 137 }).passed, true);
  assert.equal(evaluate(words(138), "stop", U("Write about tea."), { wordMax: 137 }).passed, false);
  assert.equal(evaluate(words(299), "stop", U("Write at least 300 words.")).passed, false);
  const items = U("Give me 3 taglines for a bakery, under 6 words each, as a numbered list");
  assert.equal(evaluate("1. Fresh bread daily\n2. Baked with love\n3. Warm crusts, warm hearts", "stop", items).passed, true);
  assert.equal(evaluate("1. Fresh bread daily\n2. Baked with love and a lot of care always", "stop", items).passed, false);
});

test("truncated, empty and refusing replies fail", () => {
  const u = U("Write a short poem about rain.");
  assert.equal(evaluate("Rain falls", "length", u).passed, false);
  assert.equal(evaluate("   ", "stop", u).passed, false);
  assert.equal(evaluate("As an AI, I cannot feel rain.", "stop", u).passed, false);
  assert.equal(evaluate("I'm sorry, but I can't help with that.", "stop", u).passed, false);
});

test("JSON: validity and required fields", () => {
  const u = U("Return JSON with fields name, email, company for: Ana from Acme, ana@acme.co");
  assert.equal(evaluate('```json\n{"name":"Ana","email":"ana@acme.co","company":"Acme"}\n```', "stop", u).passed, true);
  const missing = evaluate('{"name":"Ana","email":"ana@acme.co"}', "stop", u);
  assert.equal(missing.passed, false);
  assert.match(missing.checks.find((c) => c.rule.startsWith("json_fields"))!.detail, /company/);
  assert.equal(evaluate("{name: Ana", "stop", u).passed, false);
});

test("code: presence, language, TypeScript syntax; tests are honestly not run", () => {
  const u = U("Write a TypeScript function that returns the average of an array of numbers.");
  const good = evaluate("```ts\nexport function avg(xs: number[]): number {\n  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;\n}\n```", "stop", u);
  assert.equal(good.passed, true);
  assert.equal(status(good, "code_tests"), "not_checked");
  const broken = evaluate("```ts\nexport function avg(xs: number[]: number {\n  return 0\n```", "stop", u);
  assert.equal(status(broken, "code_syntax"), "fail");
  const wrongLang = evaluate("```python\ndef avg(xs):\n    return sum(xs) / len(xs)\n```", "stop", u);
  assert.equal(status(wrongLang, "code_language"), "fail");
  assert.equal(evaluate("Just average them.", "stop", u).passed, false);
});

test("citations, sections and required phrases", () => {
  const cite = U("Write about solar power and cite your sources.");
  assert.equal(evaluate("Solar is growing. Source: https://iea.org/solar", "stop", cite).passed, true);
  assert.equal(evaluate("Solar is growing fast.", "stop", cite).passed, false);
  const sec = U("Write a report with sections: Summary, Risks.");
  assert.equal(evaluate("## Summary\nok\n## Risks\nfew", "stop", sec).passed, true);
  assert.equal(evaluate("## Summary\nok", "stop", sec).passed, false);
  const must = U('Write a tweet that must mention "free trial".');
  assert.equal(evaluate("Start your free trial today", "stop", must).passed, true);
  assert.equal(evaluate("Start today", "stop", must).passed, false);
});

test("not-checked rules never fail a reply", () => {
  const e = evaluate("Hola, este es un artículo corto.", "stop", U("Write a short note in Spanish about coffee."));
  assert.equal(status(e, "language"), "not_checked");
  assert.equal(e.passed, true);
});

test("word counting ignores Markdown markers and URLs", () => {
  assert.equal(countWords("# Title\n\n- one two\n- three https://x.com/y"), 4);
});
