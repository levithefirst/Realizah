import { test } from "node:test";
import assert from "node:assert/strict";
import { understandTask } from "../lib/task/understand";
import { extractWordCount } from "../lib/task/constraints";

const U = (task: string, useCase = "", productCapability: any = null) => understandTask({ task, useCase, productCapability });

test("classifies the main task families", () => {
  const cases: [string, string, string][] = [
    ["Write a 1,000-word article about remote work for small teams.", "long-form writing", "writing"],
    ["Fix this TypeScript function:\n```ts\nfunction avg(xs: number[]) { return xs.reduce((a,b)=>a+b)/xs.length }\n```", "coding", "coding"],
    ["Return JSON with fields name, email, company for: Ana from Acme, ana@acme.co", "data entry", "structured_json"],
    ["Summarize this meeting transcript in five bullet points: ...", "notes", "summarization"],
    ["Extract every date mentioned in this contract.", "legal ops", "extraction"],
    ["Solve 3x + 5 = 20 and show your steps.", "homework", "mathematics"],
    ["What does the research say about intermittent fasting? Cite sources.", "health research", "research"],
    ["Analyze the pros and cons of usage-based pricing for a SaaS.", "strategy", "analysis"],
  ];
  for (const [task, use, want] of cases) assert.equal(U(task, use).primary, want, task);
});

test("unsupported modalities are refused, never mapped to text models", () => {
  const video = U("A 10 second clip of a cat surfing", "making AI videos", "video");
  assert.equal(video.outputModality, "video");
  assert.equal(video.executable, false);
  assert.match(video.notExecutableReason!, /can't run video comparisons yet/);
  assert.equal(U("Design a minimalist logo for a coffee shop", "logos").primary, "image_generation");
  assert.equal(U("Transcribe my meeting recording", "meetings").constraints.requiresInputFile, "audio");
  assert.equal(U("Describe what is in this image", "vision").executable, false);
  assert.equal(U("Browse to our competitor's website and click pricing", "research").executable, false);
});

test("text tasks that mention media stay text", () => {
  const u = U("Write a cold email to a SaaS founder offering an AI video service. Keep it under 100 words.", "writing cold emails");
  assert.equal(u.outputModality, "text");
  assert.equal(u.executable, true);
});

test("extracts word counts: limits, minimums, ranges, targets, per-item", () => {
  assert.deepEqual(extractWordCount("Keep it under 100 words."), { min: null, max: 100, target: null, perItemMax: null, phrase: "Keep it under 100 words" });
  assert.equal(extractWordCount("Write a 1,000-word article")?.target, 1000);
  assert.equal(extractWordCount("At least 300 words.")?.min, 300);
  const range = extractWordCount("Between 150 and 200 words.")!;
  assert.deepEqual([range.min, range.max], [150, 200]);
  assert.equal(extractWordCount("5 taglines, under 10 words each")?.perItemMax, 10);
  assert.equal(extractWordCount("5 taglines, under 10 words each")?.max, null);
  assert.equal(extractWordCount("List the 100 words every child should know."), null);
  assert.equal(extractWordCount("Summarize in 137 words or fewer.")?.max, 137);
});

test("extracts other constraints", () => {
  const json = U("Return JSON with fields name, email, company.", "extraction").constraints;
  assert.equal(json.outputFormat, "json");
  assert.deepEqual(json.requiredFields, ["name", "email", "company"]);
  const code = U("Write a React component in TypeScript that shows a counter.", "frontend").constraints;
  assert.equal(code.codeLanguage, "typescript");
  assert.equal(code.framework, "react");
  assert.equal(U("Give me 5 taglines for a bakery as a numbered list").constraints.listCount, 5);
  assert.equal(U("Give me 5 taglines for a bakery as a numbered list").constraints.outputFormat, "numbered_list");
  assert.equal(U("Write about solar power and cite your sources.").constraints.citationsRequired, true);
  assert.deepEqual(U('Write a post that must mention "free trial".').constraints.mustInclude, ["free trial"]);
  assert.equal(U("Write a blog post in Spanish about coffee.").constraints.language, "spanish");
  assert.deepEqual(U("Write a report with sections: Summary, Risks, Next steps.").constraints.requiredSections, ["Summary", "Risks", "Next steps"]);
});

test("current-information research gets an honest warning", () => {
  const u = U("Research the latest news on EU AI regulation and cite sources.", "research");
  assert.equal(u.executable, true);
  assert.match(u.warnings[0], /without web access/);
});

test("unknown tool: classification comes from the task alone", () => {
  assert.equal(U("Write a 500-word blog post about tea.", "blogging", null).primary, "writing");
});
