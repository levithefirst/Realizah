import type { ExecutionLimits } from "../config";
import type { TaskUnderstanding } from "./understand";

// Output tokens a model may spend on this task. Same for every candidate,
// plus headroom for models whose catalog entry says they reason before
// answering (their hidden reasoning tokens count as output).
const DEFAULT_BY_CATEGORY: Record<string, number> = {
  writing: 1200,
  coding: 2000,
  structured_json: 800,
  extraction: 800,
  summarization: 700,
  reasoning: 1500,
  mathematics: 1500,
  research: 1500,
  analysis: 1500,
};

export function plannedOutputTokens(u: TaskUnderstanding, limits: ExecutionLimits): number {
  const wc = u.constraints.wordCount;
  const words = wc ? wc.max ?? (wc.target !== null ? Math.ceil(wc.target * 1.15) : null) ?? wc.min : null;
  const base = words ? Math.ceil(words * 1.6) + 256 : DEFAULT_BY_CATEGORY[u.primary] ?? 1200;
  return Math.min(limits.maxOutputTokens, base);
}

export function outputTokensFor(hasReasoning: boolean, planned: number, limits: ExecutionLimits, modelMax: number | null): number {
  const want = hasReasoning ? Math.min(limits.maxOutputTokens, planned + limits.reasoningHeadroomTokens) : planned;
  return modelMax ? Math.min(want, modelMax) : want;
}
