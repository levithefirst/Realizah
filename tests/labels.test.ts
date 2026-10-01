import { test } from "node:test";
import assert from "node:assert/strict";
import { assignLabels } from "../lib/labels";

const card = (slug: string, passed: boolean | null, cost: number | null) => ({
  slug,
  label: slug,
  passed,
  estimatedCostUsd: cost,
  costPerSuccessUsd: passed && cost !== null ? cost : null,
  cheaperCost: false,
  betterCost: false,
});

test("cheapest model fails: Cheaper cost only; cheapest passing gets Better cost", () => {
  const c = [card("a", false, 1), card("b", true, 2), card("c", true, 3)];
  const r = assignLabels(c);
  assert.deepEqual(c.map((x) => [x.cheaperCost, x.betterCost]), [[true, false], [false, true], [false, false]]);
  assert.deepEqual([r.cheaper, r.better], [["a"], ["b"]]);
});

test("one model can carry both labels", () => {
  const c = [card("a", true, 1), card("b", true, 2)];
  assignLabels(c);
  assert.deepEqual(c.map((x) => [x.cheaperCost, x.betterCost]), [[true, true], [false, false]]);
});

test("nobody passes: no Better cost", () => {
  const r = assignLabels([card("a", false, 1), card("b", false, 2)]);
  assert.deepEqual(r.better, []);
  assert.match(r.summary, /Better cost: none, no model passed/);
});

test("errors never get Cheaper cost and ties share labels", () => {
  const c = [card("a", null, null), card("b", true, 2), card("c", true, 2)];
  const r = assignLabels(c);
  assert.deepEqual([r.cheaper, r.better], [["b", "c"], ["b", "c"]]);
  assert.equal(c[0].cheaperCost, false);
});

test("passing with an UNKNOWN price gets no Better cost", () => {
  const r = assignLabels([card("a", true, null), card("b", false, 1)]);
  assert.deepEqual([r.cheaper, r.better], [["b"], []]);
  assert.match(r.summary, /UNKNOWN/);
});
