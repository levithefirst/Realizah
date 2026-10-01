import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WORD_CAP, detectWordLimit, parseWordCap, resolveWordCap } from "../lib/wordLimit";
import { normalizeCriteria, runChecks } from "../lib/checks";

const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");

test("detects an explicit limit from the task", () => {
  const cases: [string, number | null][] = [
    ["Write a cold email to a SaaS founder. Keep it under 100 words.", 100],
    ["Summarize this in 137 words or fewer.", 137],
    ["No more than 250 words.", 250],
    ["Write a 500-word blog post about pricing.", 500],
    ["Keep it to 75 words.", 75],
    ["max 40 words", 40],
    ["Answer in 60 words.", 60],
    ["word limit: 120", 120],
    ["Between 150 and 200 words.", 200],
    ["Write at least 100 words.", null], // a minimum, not a limit
    ["Write more than 300 words.", null],
    ["Write a tweet about our launch.", null],
    ["List the 100 words every child should know.", null],
  ];
  for (const [task, want] of cases) assert.equal(detectWordLimit(task), want, task);
});

test("the detected limit is used, and the user can override it", () => {
  const task = "Write a cold email to a SaaS founder. Keep it under 100 words.";
  assert.deepEqual(resolveWordCap({ input: "", touched: false, task }), {
    cap: 100,
    source: "task",
    detected: 100,
    error: null,
  });
  const override = resolveWordCap({ input: "120", touched: true, task });
  assert.equal(override.cap, 120);
  assert.equal(override.source, "user");
  assert.equal(override.detected, 100);
  // No limit in the task: the existing default of 80.
  assert.equal(resolveWordCap({ input: "", touched: false, task: "Write a tweet." }).cap, DEFAULT_WORD_CAP);
  assert.equal(DEFAULT_WORD_CAP, 80);
});

test("arbitrary word caps are kept exactly; no forced multiples of 8", () => {
  for (const n of [1, 7, 9, 50, 80, 100, 137, 250, 500, 999]) {
    assert.equal(parseWordCap(String(n)), n);
    assert.equal(normalizeCriteria({ wordCap: n }).wordCap, n);
  }
  for (let n = 1; n <= 1000; n++) assert.equal(parseWordCap(String(n)), n);
});

test("typing a new cap: the field can be cleared, nothing snaps back to 80", () => {
  // The old field turned "" into 80, so typing 1-3-7 produced 801, 8013...
  const typed = ["", "1", "13", "137"];
  const caps = typed.map((input) => resolveWordCap({ input, touched: true, task: "" }));
  assert.equal(caps[0].cap, null);
  assert.ok(caps[0].error);
  assert.deepEqual(caps.slice(1).map((c) => c.cap), [1, 13, 137]);
  for (const bad of ["0", "-5", "12.5", "abc", "100000"]) {
    assert.equal(resolveWordCap({ input: bad, touched: true, task: "" }).cap, null, bad);
  }
});

test("the check enforces the exact cap: 137 passes at 137 and fails at 138", () => {
  const c = normalizeCriteria({ wordCap: 137 });
  assert.equal(runChecks(words(137), c).passed, true);
  assert.equal(runChecks(words(138), c).passed, false);
  const hundred = normalizeCriteria({ wordCap: 100 });
  assert.equal(runChecks(words(100), hundred).passed, true);
  assert.equal(runChecks(words(101), hundred).passed, false);
});
