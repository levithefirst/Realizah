// P2 regression: "What is 17*19? Show only the number." was classified as
// writing (the default) because the arithmetic rule required an "=" sign.
import { test } from "node:test";
import assert from "node:assert/strict";
import { understandTask } from "../lib/task/understand";

const primary = (task: string) => understandTask({ task, useCase: "general" }).primary;

test("arithmetic questions are mathematics", () => {
  for (const t of ["What is 17*19? Show only the number.", "What is 17 × 19?", "what's 120 / 8 + 3", "2^10", "How much is 45 times 12?", "Calculate 15% of 240.", "Compute the square root of 144."]) {
    assert.equal(primary(t), "mathematics", t);
  }
});

test("numbers in ordinary writing tasks are not mistaken for arithmetic", () => {
  assert.equal(primary("Write a 5-word slogan for coffee."), "writing");
  assert.equal(primary("Draft an email about our 24/7 support and 9-5 office hours."), "writing");
  assert.equal(primary("Write a cold email offering our 2x faster service."), "writing");
  assert.equal(primary("Write a blog post about our 3x3 grid layout."), "writing");
  assert.equal(primary("Summarize this meeting from 2024-10-01 in 5-10 bullet points."), "summarization");
  assert.equal(primary("Write a TypeScript function that returns the nth Fibonacci number."), "coding");
});
