import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSupport, matchTool, UNSUPPORTED_MESSAGE, type AiTool } from "../lib/support";

const reg: AiTool[] = [
  { slug: "chatgpt", name: "ChatGPT", aliases: ["chat gpt"], capability: "text", verifiedModelSlug: null },
  { slug: "microsoft-copilot", name: "Microsoft Copilot", aliases: ["copilot"], capability: "text", verifiedModelSlug: null },
  { slug: "github-copilot", name: "GitHub Copilot", aliases: [], capability: "code", verifiedModelSlug: null },
  { slug: "higgsfield", name: "Higgsfield", aliases: [], capability: "video", verifiedModelSlug: null },
  { slug: "dall-e", name: "DALL-E", aliases: ["dalle"], capability: "image", verifiedModelSlug: null },
];
const S = (tool: string, useCase: string, task = "") => checkSupport({ tool, useCase, task }, reg);

test("text tasks that merely mention media stay supported", () => {
  const r = S(
    "ChatGPT",
    "writing cold emails",
    "Write a cold email to a SaaS founder offering an AI video service. Keep it under 100 words."
  );
  assert.equal(r.supported, true, r.message);
  for (const [tool, use] of [
    ["Claude", "summarizing video transcripts"],
    ["ChatGPT", "writing captions for product photos"],
    ["Acme Writer", "writing a script for a YouTube video"],
    ["Claude", "rewriting emails in our brand voice"],
    ["Notion AI", "drafting emails with a discount code"],
    ["ChatGPT", "writing song lyrics"],
  ]) {
    assert.equal(S(tool, use).supported, true, `${tool} / ${use}`);
  }
});

test("non-text tools and tasks are refused with the clear message", () => {
  const r = S("Higgsfield", "making AI videos");
  assert.equal(r.supported, false);
  assert.ok(r.message.startsWith(UNSUPPORTED_MESSAGE));
  const cases: [string, string, string][] = [
    ["ChatGPT", "making product photos", "image"],
    ["ChatGPT", "designing logos", "image"],
    ["Acme Studio", "turning blogs into reels", "video"],
    ["Acme", "video editing", "video"],
    ["Acme", "transcribing sales calls", "audio"],
    ["Acme", "recording podcasts", "audio"],
    ["ChatGPT", "writing python scripts", "code"],
    ["GitHub Copilot", "writing emails", "code"],
    ["DALL-E 3", "blog headers", "image"],
  ];
  for (const [tool, use, cap] of cases) {
    const res = S(tool, use);
    assert.equal(res.supported, false, `${tool} / ${use}`);
    assert.equal(res.capability, cap, `${tool} / ${use}`);
  }
});

test("unknown tools are judged by the task, never mapped to a model", () => {
  const r = S("Acme Writer", "drafting cold emails");
  assert.equal(r.supported, true);
  assert.equal(r.tool, null);
  assert.equal(r.capability, "unknown");
});

test("tool matching", () => {
  assert.equal(matchTool("ChatGPT Plus", reg)?.slug, "chatgpt");
  assert.equal(matchTool("GitHub Copilot", reg)?.slug, "github-copilot");
  assert.equal(matchTool("copilot", reg)?.slug, "microsoft-copilot");
  assert.equal(matchTool("dall-e 3", reg)?.slug, "dall-e");
  assert.equal(matchTool("chatgptx", reg), null);
});
