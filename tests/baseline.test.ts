import { test } from "node:test";
import assert from "node:assert/strict";
import { currentToolBaseline, matchProduct, searchProducts, type AiProduct } from "../lib/products";
import { comparisonSummary } from "../lib/comparison/summary";
import { assignLabels } from "../lib/labels";
import { budgetLine, parseBudget } from "../lib/budget";
import { parseWordCap } from "../lib/wordLimit";

const chatgpt: AiProduct = { slug: "chatgpt", name: "ChatGPT", aliases: ["chat gpt"], capability: "text", baselineStatus: "unknown", baselineMethodology: null, baselineSourceUrl: null, verifiedModelId: null };
const mapped: AiProduct = { ...chatgpt, slug: "acme", name: "Acme Writer", aliases: [], baselineStatus: "verified", baselineMethodology: "Vendor docs state it runs model X", baselineSourceUrl: "https://example.com", verifiedModelId: "model-x" };

test("a product without a verified baseline never gets a cost", () => {
  const b = currentToolBaseline({ input: "ChatGPT", product: chatgpt });
  assert.deepEqual([b.status, b.taskRun, b.taskCostKnown, b.costUsd], ["unknown", false, false, null]);
  assert.match(b.message, /^Current tool cost unavailable/);
});

test("an unknown tool typed by hand is also unknown", () => {
  const b = currentToolBaseline({ input: "My Custom GPT", product: matchProduct("My Custom GPT", [chatgpt]) });
  assert.equal(b.product, "My Custom GPT");
  assert.equal(b.taskCostKnown, false);
});

test("a verified mapping counts only when that model actually ran", () => {
  assert.equal(currentToolBaseline({ input: "Acme Writer", product: mapped, verifiedModelResult: null }).taskCostKnown, false);
  const ran = currentToolBaseline({ input: "Acme Writer", product: mapped, verifiedModelResult: { costUsd: 0.002 } });
  assert.deepEqual([ran.status, ran.taskRun, ran.costUsd], ["verified", true, 0.002]);
});

test("the summary never claims anything about the current tool without a known cost", () => {
  const s = comparisonSummary({
    attempted: 12,
    cheaper: { names: ["Model A"], costUsd: 0.0004 },
    better: { names: ["Model B"], costPerSuccessUsd: 0.0009 },
    baseline: currentToolBaseline({ input: "ChatGPT", product: chatgpt }),
  });
  assert.doesNotMatch(s, /ChatGPT/);
  assert.match(s, /among the 12 tested models/);
  const none = comparisonSummary({ attempted: 3, cheaper: { names: ["A"], costUsd: 0.001 }, better: { names: [], costPerSuccessUsd: null }, baseline: currentToolBaseline({ input: "x", product: null }) });
  assert.match(none, /Better cost: none/);
});

test("labels: Cheaper cost may go to a failed run; Better cost never does", () => {
  const l = assignLabels([
    { key: "fail-cheap", label: "a", passed: false, estimatedCostUsd: 0.0001, costPerSuccessUsd: null },
    { key: "pass", label: "b", passed: true, estimatedCostUsd: 0.0003, costPerSuccessUsd: 0.0003 },
    { key: "pass-2", label: "c", passed: true, estimatedCostUsd: 0.0003, costPerSuccessUsd: 0.0003 },
    { key: "error", label: "d", passed: false, estimatedCostUsd: null, costPerSuccessUsd: null },
  ]);
  assert.deepEqual(l.cheaper, ["fail-cheap"]);
  assert.deepEqual(l.better, ["pass", "pass-2"]); // ties share
});

test("$20 budget: estimated successful runs, failures give none, over-budget flagged", () => {
  assert.deepEqual(budgetLine(20, { estimatedCostUsd: 0.004, costPerSuccessUsd: 0.004 }), { budgetUsd: 20, exceedsBudget: false, successfulRunsWithinBudget: 5000, isEstimate: true });
  assert.equal(budgetLine(20, { estimatedCostUsd: 0.004, costPerSuccessUsd: null }).successfulRunsWithinBudget, null);
  assert.equal(budgetLine(0.001, { estimatedCostUsd: 0.004, costPerSuccessUsd: 0.004 }).exceedsBudget, true);
  assert.deepEqual([parseBudget("$20"), parseBudget("2.50"), parseBudget(""), parseBudget("twenty")], [20, 2.5, null, "invalid"]);
});

test("word cap overrides keep any whole number", () => {
  for (const n of [8, 50, 80, 100, 137, 250, 500]) assert.equal(parseWordCap(String(n)), n);
  assert.equal(parseWordCap("12.5"), null);
});

test("tool search filters as you type; unknown tools match nothing", () => {
  const list: AiProduct[] = [chatgpt, { ...chatgpt, slug: "claude", name: "Claude", aliases: [] }, { ...chatgpt, slug: "cursor", name: "Cursor", aliases: [] }];
  assert.deepEqual(searchProducts("c", list).map((p) => p.slug), ["chatgpt", "claude", "cursor"]);
  assert.deepEqual(searchProducts("cla", list).map((p) => p.slug), ["claude"]);
  assert.deepEqual(searchProducts("zzz", list), []);
  assert.equal(matchProduct("ChatGPT Plus", list)?.slug, "chatgpt");
  assert.equal(matchProduct("Unknown Tool", list), null);
});
