import type { ExecutionLimits } from "../config";
import type { TaskUnderstanding } from "./understand";

// Per-task output ceiling: derived from what the task asks for, never the
// global MAX_OUTPUT_TOKENS by default. The same ceiling applies to every
// candidate; reasoning models get extra headroom because their hidden
// reasoning is billed and counted as output.

export const TOKENS_PER_WORD = 1.4; // English prose with Markdown, slightly generous
const FORMAT_OVERHEAD = 64;

export type OutputBudget = { tokens: number; basis: string };

function words(n: number): number {
  return Math.ceil(n * TOKENS_PER_WORD) + FORMAT_OVERHEAD;
}

export function outputBudget(u: TaskUnderstanding, limits: ExecutionLimits): OutputBudget {
  const c = u.constraints;
  const wc = c.wordCount;
  let tokens: number;
  let basis: string;

  if (wc?.max != null) {
    tokens = words(wc.max);
    basis = `${wc.max}-word limit`;
  } else if (wc?.target != null) {
    tokens = words(Math.ceil(wc.target * 1.15)); // the pass range tops out at +15%
    basis = `${wc.target}-word target (+15%)`;
  } else if (c.listCount && wc?.perItemMax) {
    tokens = words(c.listCount * wc.perItemMax) + c.listCount * 4;
    basis = `${c.listCount} items x ${wc.perItemMax} words`;
  } else if (wc?.min != null) {
    tokens = words(Math.ceil(wc.min * 1.5));
    basis = `${wc.min}-word minimum (+50% room)`;
  } else if (u.primary === "structured_json" || c.outputFormat === "json") {
    const fields = Math.max(c.requiredFields.length, 4);
    tokens = 128 + fields * 48;
    basis = `JSON, ${c.requiredFields.length || "unspecified"} fields`;
  } else if (u.primary === "coding") {
    // Scales with how much the task asks for; tests roughly double the code.
    const asksForTests = c.wantsTests;
    tokens = Math.min(2400, 600 + c.estimatedInputTokens * 4) * (asksForTests ? 1.5 : 1);
    basis = asksForTests ? "code with tests, scaled to the task" : "code, scaled to the task";
  } else if (c.listCount) {
    tokens = 64 + c.listCount * 60;
    basis = `${c.listCount}-item list`;
  } else {
    const byCategory: Record<string, number> = {
      summarization: 400,
      extraction: 500,
      writing: 700,
      analysis: 900,
      research: 1000,
      reasoning: 900,
      mathematics: 900,
    };
    tokens = byCategory[u.primary] ?? 700;
    basis = `typical ${u.primary} reply`;
  }

  tokens = Math.ceil(tokens);
  if (tokens > limits.maxOutputTokens) return { tokens: limits.maxOutputTokens, basis: `${basis}, capped at the global ${limits.maxOutputTokens}` };
  return { tokens, basis };
}

export function plannedOutputTokens(u: TaskUnderstanding, limits: ExecutionLimits): number {
  return outputBudget(u, limits).tokens;
}

export function outputTokensFor(hasReasoning: boolean, planned: number, limits: ExecutionLimits, modelMax: number | null): number {
  // Reasoning headroom scales with the task (never more than the planned
  // answer itself, never more than REASONING_HEADROOM_TOKENS).
  const headroom = hasReasoning ? Math.min(limits.reasoningHeadroomTokens, planned) : 0;
  const want = Math.min(limits.maxOutputTokens, planned + headroom);
  return modelMax ? Math.min(want, modelMax) : want;
}

// What a reply is likely to use, for spend estimates only (never for the cap).
export function expectedOutputTokens(u: TaskUnderstanding, maxOut: number): number {
  const wc = u.constraints.wordCount;
  if (wc?.target != null) return Math.min(maxOut, Math.ceil(wc.target * TOKENS_PER_WORD));
  if (wc?.max != null) return Math.min(maxOut, Math.ceil(wc.max * 0.85 * TOKENS_PER_WORD));
  return Math.ceil(maxOut * 0.6);
}
