// Runs one prompt on several models and scores the replies. Pure: no
// database, no secrets. The model client is passed in so tests can record
// exactly what every model receives.
import { DEFAULT_TASK, FIXTURE } from "./fixture";
import { runChecks, type Criteria } from "./checks";
import { estimateCostUsd } from "./cost";
import type { Tool } from "./tools";

export type ChatMessage = { role: "system" | "user"; content: string };

export type Completion = {
  text: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
};

export type ChatFn = (req: {
  model: string;
  messages: ChatMessage[];
  temperature: number;
}) => Promise<Completion>;

export class ModelNotFoundError extends Error {}

export type RunMode = "custom" | "demo";

// The prompt every selected model receives.
// custom: the user's task, byte for byte, as the only message. No wrapper,
//   no fixture, no added instructions. The success checks are applied to the
//   replies, not sent to the models.
// demo:   only when the user entered no task. Summarize the fictional ticket.
export function buildMessages(task: string): { mode: RunMode; messages: ChatMessage[]; taskText: string } {
  if (task.trim() !== "") {
    return { mode: "custom", messages: [{ role: "user", content: task }], taskText: task };
  }
  return {
    mode: "demo",
    messages: [
      { role: "system", content: `${DEFAULT_TASK} Reply with the summary only.` },
      { role: "user", content: FIXTURE },
    ],
    taskText: DEFAULT_TASK,
  };
}

const FALLBACK_MODEL = "gpt-4o-mini";
const DEFAULT_TEMPERATURE = 0.2;
const FALLBACK_TEMPERATURE = 0.9;

export type ResultCard = {
  slug: string;
  label: string;
  modelId: string;
  // True only when this model is the verified model behind the user's tool.
  isCurrent: boolean;
  fallbackFor: string | null;
  passed: boolean | null;
  qualityBand: "good" | "fail" | "error";
  wordCount: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  estimatedCostUsd: number | null;
  costPerSuccessUsd: number | null;
  latencyMs: number | null;
  priceUnknown: boolean;
  priceAsOf: string | null;
  error: string | null;
  why: string;
  output: string | null;
  // Cheaper cost: lowest estimated dollars for this run, pass or fail.
  cheaperCost: boolean;
  // Better cost: lowest dollars per successful outcome. A fail never gets it.
  betterCost: boolean;
};

export type AuditEvent = {
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  estimatedCostUsd: number | null;
  success: boolean | null;
  createdAt: string;
};


export async function runOne(
  tool: Tool,
  fallbackTool: Tool | undefined,
  messages: ChatMessage[],
  c: Criteria,
  isCurrent: boolean,
  call: ChatFn
): Promise<RunOutcome> {
  const base = {
    isCurrent,
    cheaperCost: false,
    betterCost: false,
    priceAsOf: tool.lastChecked,
  };
  let used: Tool = tool;
  let temperature = DEFAULT_TEMPERATURE;
  let fallbackFor: string | null = null;
  let completion;
  try {
    try {
      completion = await call({ model: tool.modelId, messages, temperature });
    } catch (e) {
      if (!(e instanceof ModelNotFoundError) || !fallbackTool || tool.modelId === FALLBACK_MODEL) {
        throw e;
      }
      // Requested model id is not available on this key: run gpt-4o-mini at a
      // different temperature instead and label it so nobody is misled.
      used = fallbackTool;
      temperature = FALLBACK_TEMPERATURE;
      fallbackFor = tool.modelId;
      completion = await call({ model: used.modelId, messages, temperature });
    }
  } catch (e) {
    const msg =
      e instanceof Error
        ? e.name === "TimeoutError"
          ? "timed out after 25s"
          : e.message
        : "unknown error";
    return {
      card: {
        ...base,
        slug: tool.slug,
        label: tool.name,
        modelId: tool.modelId,
        fallbackFor: null,
        passed: false,
        qualityBand: "error",
        wordCount: null,
        tokensIn: null,
        tokensOut: null,
        estimatedCostUsd: null,
        costPerSuccessUsd: null,
        latencyMs: null,
        priceUnknown: tool.isUnknown,
        error: msg,
        why: `Call failed: ${msg}`,
        output: null,
      },
      audit: null,
      auditModel: tool.modelId,
    };
  }

  const check = runChecks(completion.text, c);
  const cost = estimateCostUsd(
    completion.tokensIn,
    completion.tokensOut,
    used.inputUsdPer1m,
    used.outputUsdPer1m
  );
  const why = check.passed
    ? `Passed: ${check.wordCount} words (cap ${c.wordCap}), no banned phrase.`
    : `Failed: ${check.reasons.join("; ")}.`;

  const slug = fallbackFor ? `${used.slug}@t${temperature}` : tool.slug;
  const label = fallbackFor
    ? `${used.name} at temperature ${temperature} (fallback: ${fallbackFor} unavailable)`
    : tool.name;

  return {
    card: {
      ...base,
      slug,
      label,
      modelId: used.modelId,
      fallbackFor,
      passed: check.passed,
      qualityBand: check.passed ? "good" : "fail",
      wordCount: check.wordCount,
      tokensIn: completion.tokensIn,
      tokensOut: completion.tokensOut,
      estimatedCostUsd: cost,
      costPerSuccessUsd: check.passed ? cost : null,
      latencyMs: completion.latencyMs,
      priceUnknown: cost === null,
      priceAsOf: used.lastChecked,
      error: null,
      why,
      output: completion.text,
    },
    audit: {
      model: used.modelId,
      tokensIn: completion.tokensIn,
      tokensOut: completion.tokensOut,
      estimatedCostUsd: cost,
      success: check.passed,
      createdAt: new Date().toISOString(),
    },
    auditModel: used.modelId,
  };
}

export type RunOutcome = { card: ResultCard; audit: AuditEvent | null; auditModel: string };

// Every model gets the same messages array, so the comparison is like for like.
export function runModels(
  models: Tool[],
  messages: ChatMessage[],
  c: Criteria,
  opts: { fallback: Tool | undefined; verifiedModelSlug: string | null; call: ChatFn }
): Promise<RunOutcome[]> {
  return Promise.all(
    models.map((m) => runOne(m, opts.fallback, messages, c, m.slug === opts.verifiedModelSlug, opts.call))
  );
}
