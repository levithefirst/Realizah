import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessages, runModels, ModelNotFoundError, type ChatFn, type ChatMessage } from "../lib/engine";
import { assignLabels } from "../lib/labels";
import { DEFAULT_TASK, FIXTURE } from "../lib/fixture";
import type { Tool } from "../lib/tools";
import { selectModels, comparedAcross } from "../lib/selectModels";

const model = (slug: string, input: number, output: number): Tool => ({
  slug,
  name: slug,
  provider: "openai",
  modelId: slug,
  pricingUrl: null,
  inputUsdPer1m: input,
  outputUsdPer1m: output,
  lastChecked: "2026-10-01T00:00:00.000Z",
  isUnknown: false,
  enabled: true,
});
const MODELS = [model("gpt-4o-mini", 0.15, 0.6), model("gpt-4.1-mini", 0.4, 1.6), model("gpt-4.1-nano", 0.1, 0.4)];
const CRITERIA = { wordCap: 100, bannedPhrases: ["as an AI"] };

// Exactly what the user typed, including spacing, quotes and a line break.
const TASK =
  "  Write a cold email to a SaaS founder offering an AI video service. Keep it under 100 words.\n\"Sign off as Dana\" 🚀 ";

type Call = { model: string; messages: ChatMessage[]; temperature: number };
function recorder(reply: (model: string) => string = () => "Hi Sam, short note about our service. Dana") {
  const calls: Call[] = [];
  const call: ChatFn = async (req) => {
    calls.push(structuredClone(req));
    return { text: reply(req.model), tokensIn: 40, tokensOut: 20, latencyMs: 5 };
  };
  return { calls, call };
}

test("the user's task reaches every selected model unchanged", async () => {
  const prompt = buildMessages(TASK);
  assert.equal(prompt.mode, "custom");
  const { calls, call } = recorder();
  await runModels(MODELS, prompt.messages, CRITERIA, { fallback: MODELS[0], verifiedModelSlug: null, call });

  assert.deepEqual(calls.map((c) => c.model).sort(), MODELS.map((m) => m.modelId).sort());
  for (const c of calls) {
    assert.deepEqual(c.messages, [{ role: "user", content: TASK }]);
    assert.equal(c.messages[0].content, TASK); // byte for byte, not trimmed
    assert.ok(!JSON.stringify(c.messages).includes(FIXTURE.slice(0, 40)), "fixture must not be sent");
  }
  // Same prompt for every model: apples to apples.
  assert.equal(new Set(calls.map((c) => JSON.stringify(c.messages))).size, 1);
});

test("a model that 404s falls back with the same unchanged task", async () => {
  const calls: Call[] = [];
  const call: ChatFn = async (req) => {
    calls.push(structuredClone(req));
    if (req.model === "gpt-4.1-mini") throw new ModelNotFoundError("model_not_found");
    return { text: "Short reply.", tokensIn: 10, tokensOut: 5, latencyMs: 1 };
  };
  const prompt = buildMessages(TASK);
  const [, fallback] = await runModels(MODELS.slice(0, 2), prompt.messages, CRITERIA, {
    fallback: MODELS[0],
    verifiedModelSlug: null,
    call,
  });
  assert.equal(calls.length, 3);
  for (const c of calls) assert.deepEqual(c.messages, [{ role: "user", content: TASK }]);
  assert.equal(fallback.card.fallbackFor, "gpt-4.1-mini");
});

test("the demo fixture is used only when no task was entered", () => {
  for (const empty of ["", "   ", "\n\t"]) {
    const p = buildMessages(empty);
    assert.equal(p.mode, "demo");
    assert.equal(p.taskText, DEFAULT_TASK);
    assert.equal(p.messages.at(-1)?.content, FIXTURE);
  }
  // Any typed task, even one that looks like the demo task, is sent as typed.
  const typed = buildMessages(DEFAULT_TASK);
  assert.equal(typed.mode, "custom");
  assert.deepEqual(typed.messages, [{ role: "user", content: DEFAULT_TASK }]);
});

test("checks, costs and both labels are computed on the user's task replies", async () => {
  const replies: Record<string, string> = {
    "gpt-4o-mini": "Hi Sam, we make short product videos for SaaS launches. Worth a 15 minute call? Dana",
    "gpt-4.1-mini": "As an AI, I drafted this email for you. Hi Sam, quick idea about video. Dana",
    "gpt-4.1-nano": Array.from({ length: 120 }, () => "word").join(" "),
  };
  const { call } = recorder((m) => replies[m]);
  const outcomes = await runModels(MODELS, buildMessages(TASK).messages, CRITERIA, {
    fallback: MODELS[0],
    verifiedModelSlug: null,
    call,
  });
  const cards = outcomes.map((o) => o.card);
  const [mini4o, mini41, nano] = cards;

  assert.equal(mini4o.passed, true);
  assert.equal(mini41.passed, false); // banned phrase
  assert.equal(nano.passed, false); // over the 100-word cap
  // (40 in * rate + 20 out * rate) / 1M
  assert.equal(mini4o.estimatedCostUsd, (40 * 0.15 + 20 * 0.6) / 1e6);
  assert.equal(nano.estimatedCostUsd, (40 * 0.1 + 20 * 0.4) / 1e6);
  assert.equal(mini4o.costPerSuccessUsd, mini4o.estimatedCostUsd);
  assert.equal(nano.costPerSuccessUsd, null);
  assert.equal(mini41.costPerSuccessUsd, null);

  const labels = assignLabels(cards);
  assert.deepEqual(labels.cheaper, ["gpt-4.1-nano"]); // lowest sticker cost, even though it failed
  assert.deepEqual(labels.better, ["gpt-4o-mini"]); // a fail never gets Better cost
});

test("a failed call is an error card with no cost", async () => {
  const call: ChatFn = async () => {
    throw new Error("OpenAI 500: boom");
  };
  const [o] = await runModels(MODELS.slice(0, 1), buildMessages(TASK).messages, CRITERIA, {
    fallback: MODELS[0],
    verifiedModelSlug: null,
    call,
  });
  assert.equal(o.card.qualityBand, "error");
  assert.equal(o.card.estimatedCostUsd, null);
  assert.equal(o.audit, null);
});

test("auto-selected models of any count all get the exact same user task", async () => {
  const providers = new Set(["openai"]);
  for (const n of [2, 3, 5, 10]) {
    const pool = Array.from({ length: n }, (_, i) => model(`model-${String(i).padStart(2, "0")}`, 0.1 + i, 0.4 + i));
    const selected = selectModels(pool, { providers });
    assert.equal(selected.length, n);

    const { calls, call } = recorder();
    const outcomes = await runModels(selected, buildMessages(TASK).messages, CRITERIA, {
      fallback: undefined,
      verifiedModelSlug: null,
      call,
    });
    assert.equal(calls.length, n);
    assert.equal(outcomes.length, n);
    for (const c of calls) assert.deepEqual(c.messages, [{ role: "user", content: TASK }]);
    assert.deepEqual(calls.map((c) => c.model).sort(), selected.map((m) => m.modelId).sort());
    // The results heading counts the cards actually produced.
    assert.equal(comparedAcross(outcomes.length), `Compared across ${n} models`);
  }
});
