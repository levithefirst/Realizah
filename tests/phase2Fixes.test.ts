// Regressions from the Phase 2 data-quality QA (2026-10-02).
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractListCount, extractRequiredFields, extractWordCount } from "../lib/task/constraints";
import { understandTask } from "../lib/task/understand";
import { contentFreeChecks, evaluate } from "../lib/evaluation/evaluate";
import { arithmeticAnswer } from "../lib/evaluation/arithmetic";
import { outputBudget } from "../lib/task/outputBudget";
import { DEFAULT_LIMITS } from "./fixtures";

const MAYA = "Return ONLY valid JSON with fields name, age, and city for a fictional person named Maya who is 29 and lives in Lagos.";
const u = (task: string) => understandTask({ task, useCase: "general" });
const ev = (task: string, reply: string) => evaluate(reply, "stop", u(task), { source: task });
const check = (task: string, reply: string, rule: string) => ev(task, reply).checks.find((c) => c.rule === rule);

test("BLOCKER: a sentence after the field list is not a field (no spurious 'lives')", () => {
  assert.deepEqual(u(MAYA).constraints.requiredFields, ["name", "age", "city"]);
  const e = ev(MAYA, '{"name":"Maya","age":29,"city":"Lagos"}');
  assert.equal(e.passed, true, JSON.stringify(e.checks));
  assert.equal(check(MAYA, '{"name":"Maya","age":29}', "json_fields.v1")!.status, "fail", "a really missing field still fails");
});

test("field lists: still complete, and multi-word names survive", () => {
  assert.deepEqual(extractRequiredFields("Return JSON with keys title, summary and tags."), ["title", "summary", "tags"]);
  assert.deepEqual(extractRequiredFields("Output JSON with fields date_of_birth, place of birth and price in USD."), ["date_of_birth", "place_of_birth", "price"]);
  assert.deepEqual(extractRequiredFields("JSON with fields company, city, phone from this text: Acme Ltd, Lagos"), ["company", "city", "phone"]);
  assert.deepEqual(extractRequiredFields("Give JSON with fields id and status that describe the order."), ["id", "status"]);
});

test("list counts: number words, adjectives in between, and ranges need their lower bound", () => {
  assert.equal(extractListCount("Give me exactly five short tips for sleeping better."), 5);
  assert.equal(extractListCount("List exactly 5 tips"), 5);
  assert.equal(extractListCount("a list of seven ideas"), 7);
  assert.equal(extractListCount("Summarize this in 5-10 bullet points."), 5);
  assert.equal(extractListCount("Give 3 to 5 reasons."), 3);
  assert.equal(extractListCount("Write an essay about tips culture."), null);
});

test("per-item word limits stated before the limit ('Each tip under 12 words')", () => {
  const wc = extractWordCount("List exactly 5 tips for focus. Each tip under 12 words.")!;
  assert.deepEqual([wc.max, wc.perItemMax], [null, 12]);
  const t = understandTask({ task: "List exactly 5 tips for focus. Each tip under 12 words.", useCase: "writing" });
  assert.equal(outputBudget(t, DEFAULT_LIMITS).tokens, 64 + Math.ceil(5 * 12 * 1.4) + 20, "budget by items, not a 12-word global cap");
  assert.deepEqual(extractWordCount("Every bullet no more than 8 words.")!.perItemMax, 8);
  assert.equal(extractWordCount("Keep it to no more than 50 words.")!.min, null, "'no more than' is not a minimum");
  assert.equal(extractWordCount("Keep it to no more than 50 words.")!.max, 50);
});

test("classification: quantitative questions are reasoning; data reshaping is extraction", () => {
  assert.equal(u("A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost?").primary, "reasoning");
  assert.equal(u("Convert this list to CSV with columns sku, name, price: SKU A1 Widget 2.50; SKU B2 Gadget 4.00").primary, "extraction");
  assert.equal(u("Turn these notes into a table with columns date and amount: Jan 3 $40").primary, "extraction");
  // Not over-triggered.
  assert.equal(u("Write an email to my landlord asking how much the repair will cost?").primary, "writing");
  assert.equal(u("Write a blog post about how many hours remote workers should sleep.").primary, "writing");
  assert.equal(u("What is 17*19? Show only the number.").primary, "mathematics");
});

test("mathematics: a computable answer is checked; a wrong number fails", () => {
  const T = "What is 17*19? Show only the number.";
  assert.deepEqual(arithmeticAnswer(T), { expression: "17*19", value: 323 });
  assert.equal(check(T, "323", "math_answer.v1")!.status, "pass");
  assert.equal(ev(T, "324").passed, false, "a wrong number used to pass");
  assert.equal(check("Calculate 15% of 240.", "That is 36.", "math_answer.v1")!.status, "pass");
  assert.equal(check("What is 1,250 + 3,750?", "5,000", "math_answer.v1")!.status, "pass");
  assert.equal(check("Compute the square root of 144.", "12", "math_answer.v1")!.status, "pass");
});

test("mathematics/reasoning without computable arithmetic: correctness is explicitly not checked", () => {
  const bat = "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost?";
  const c = check(bat, "$0.10", "math_answer.v1")!;
  assert.equal(c.status, "not_checked");
  assert.match(c.detail, /not verified/);
  assert.equal(arithmeticAnswer("Summarize the meeting from 2024-10-01."), null);
  assert.equal(arithmeticAnswer("Solve 2x + 3 = 7 for x."), null);
  assert.equal(arithmeticAnswer("Is 7*8 bigger than 6*9?"), null, "more than one computation: ambiguous, not checked");
});

test("extraction: invented numbers fail; values from the source pass; rephrasing is not a failure", () => {
  const T = "Extract the company name, city and phone number from: Acme Ltd is based in Lagos, call 0803 123 4567.";
  assert.equal(u(T).primary, "extraction");
  const good = ev(T, "Company: Acme Ltd\nCity: Lagos\nPhone: 0803 123 4567");
  assert.equal(good.passed, true);
  assert.equal(good.checks.find((c) => c.rule === "extraction_values.v1")!.status, "pass");
  assert.equal(good.checks.find((c) => c.rule === "extraction_text.v1")!.status, "pass");
  const invented = ev(T, "Company: Acme Ltd\nCity: Lagos\nPhone: 0803 999 4567");
  assert.equal(invented.passed, false, "a wrong phone number used to pass");
  assert.match(invented.checks.find((c) => c.rule === "extraction_values.v1")!.detail, /0803 999 4567/);
  const reformatted = ev(T, "Company: Acme Limited\nCity: Lagos\nPhone: +234 803 123 4567");
  assert.equal(reformatted.passed, true, "international format and rephrased names are not failures");
  assert.equal(reformatted.checks.find((c) => c.rule === "extraction_text.v1")!.status, "not_checked");
  assert.equal(ev(T, '{"company":"Acme Ltd","city":"Lagos","phone":"0803 123 4567"}').passed, true);
});

test("CSV transforms: grounded values pass, an invented price fails", () => {
  const T = "Convert this list to CSV with columns sku, name, price: SKU A1 Widget 2.50; SKU B2 Gadget 4.00";
  assert.equal(ev(T, "sku,name,price\nA1,Widget,2.50\nB2,Gadget,4.00").passed, true);
  assert.equal(ev(T, "sku,name,price\nA1,Widget,2.5\nB2,Gadget,4").passed, true, "2.5 equals 2.50");
  assert.equal(ev(T, "sku,name,price\nA1,Widget,2.75\nB2,Gadget,4.00").passed, false);
});

test("permanent check records never quote the task or the reply", () => {
  const T = "Extract the company name, city and phone number from: Acme Ltd is based in Lagos, call 0803 123 4567.";
  const checks = ev(T, "Company: Acme Ltd\nCity: Lagos\nPhone: 0803 999 4567").checks;
  const stored = JSON.stringify(contentFreeChecks(checks));
  assert.ok(!stored.includes("0803") && !stored.includes("Acme"), stored);
  const json = JSON.stringify(contentFreeChecks(ev(MAYA, '{"name":"Maya"}').checks));
  assert.ok(!json.includes("age") || !/Missing/.test(json), json);
  // Status is preserved.
  assert.deepEqual(contentFreeChecks(checks).map((c) => c.status), checks.map((c) => c.status));
});
