// Regression (Phase 2 final QA, commit a40e047): "Give me 5 tips. Each tip
// must contain no more than 8 words." was parsed as a global 8-word maximum
// because only two words were allowed between "each" and the limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractListCount, extractWordCount } from "../lib/task/constraints";
import { understandTask } from "../lib/task/understand";
import { outputBudget } from "../lib/task/outputBudget";
import { DEFAULT_LIMITS } from "./fixtures";

const limits = (task: string) => {
  const wc = extractWordCount(task);
  return { max: wc?.max ?? null, perItemMax: wc?.perItemMax ?? null };
};

test("the reported prompt: 5 tips, 8 words per tip, no global 8-word maximum", () => {
  const task = "Give me 5 tips. Each tip must contain no more than 8 words.";
  assert.deepEqual(limits(task), { max: null, perItemMax: 8 });
  assert.equal(extractListCount(task), 5);
  const u = understandTask({ task, useCase: "general" });
  assert.equal(u.constraints.listCount, 5);
  assert.equal(u.constraints.wordCount!.perItemMax, 8);
  assert.equal(u.constraints.wordCount!.max, null);
  // Budget by items (5 x 8 words), not a 8-word global cap.
  assert.deepEqual(outputBudget(u, DEFAULT_LIMITS), { tokens: 140, basis: "5 items x 8 words" });
});

test("natural per-item phrasings are per-item limits", () => {
  const cases: [string, number][] = [
    ["Each tip must contain no more than 8 words.", 8],
    ["Each tip should contain no more than 8 words.", 8],
    ["Each tip can have at most 8 words.", 8],
    ["Each bullet must be under 10 words.", 10],
    ["Every item should have fewer than 12 words.", 12],
    ["Keep each tip to no more than 8 words.", 8],
    ["Each recommendation must contain at most 15 words.", 15],
    ["Each idea needs to be under 9 words.", 9],
    ["Every headline has to stay below 7 words.", 7],
    ["Each of the 3 tips must use no more than 6 words.", 6],
  ];
  for (const [task, n] of cases) assert.deepEqual(limits(`Give me 5 tips. ${task}`), { max: null, perItemMax: n }, task);
});

test("already-working per-item phrasings still work", () => {
  assert.deepEqual(limits("Each tip no more than 8 words."), { max: null, perItemMax: 8 });
  assert.deepEqual(limits("Every bullet no more than 8 words."), { max: null, perItemMax: 8 });
  assert.deepEqual(limits("List exactly 5 tips for focus. Each tip under 12 words."), { max: null, perItemMax: 12 });
  assert.deepEqual(limits("Write 3 taglines under 8 words each."), { max: null, perItemMax: 8 });
});

test("global limits stay global (no false per-item)", () => {
  const global: [string, number][] = [
    ["Answer in no more than 50 words.", 50],
    ["Keep it under 100 words.", 100],
    ["Explain each step briefly. Answer in no more than 50 words.", 50],
    ["Describe each of the three plans, and keep the whole answer under 120 words.", 120],
    ["Each response must be under 50 words.", 50],
    ["Write a summary that covers each chapter, in no more than 200 words total.", 200],
    ["Summarize each chapter in no more than 300 words total.", 300],
    ["Review each option and answer in no more than 60 words.", 60],
  ];
  for (const [task, n] of global) assert.deepEqual(limits(task), { max: n, perItemMax: null }, task);
});

test("both limits in one task are kept apart", () => {
  assert.deepEqual(limits("Give me 5 tips. Each tip must contain no more than 8 words. Keep the whole answer under 60 words."), {
    max: 60,
    perItemMax: 8,
  });
});
