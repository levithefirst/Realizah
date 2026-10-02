// Runs the selected candidates: the SAME messages to every model, bounded
// concurrency, normalized results, cost from each candidate's price snapshot,
// then task-aware evaluation. Pure apart from the adapters passed in.
import { evaluate, type Evaluation } from "../evaluation/evaluate";
import { taskCostUsd } from "../pricing";
import type { ChatMessage, ProviderAdapter, RunModelResult } from "../providers/types";
import type { Candidate } from "../selection/select";
import type { TaskUnderstanding } from "../task/understand";

export type CandidateOutcome = {
  candidate: Candidate;
  run: RunModelResult;
  estimatedCostUsd: number | null;
  costPerSuccessUsd: number | null;
  evaluation: Evaluation | null;
  passed: boolean;
};

// The prompt every candidate receives: the user's task, unchanged, as the
// only message. No per-model rewriting. The one addition: a word limit the
// user set explicitly (wordMax) is stated after the task, because every
// reply is judged against it and a model can't meet a limit it isn't told.
export function wordLimitInstruction(wordMax: number): string {
  return `Keep the response to ${wordMax} ${wordMax === 1 ? "word" : "words"} or fewer.`;
}

export function buildMessages(task: string, wordMax?: number | null): ChatMessage[] {
  const content = wordMax == null ? task : `${task}\n\n${wordLimitInstruction(wordMax)}`;
  return [{ role: "user", content }];
}

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// One candidate: call, cost from its own price snapshot, evaluate.
export async function runCandidate(opts: {
  candidate: Candidate;
  messages: ChatMessage[];
  adapters: Map<string, ProviderAdapter>;
  understanding: TaskUnderstanding;
  timeoutMs: number;
  wordMaxOverride?: number | null;
}): Promise<CandidateOutcome> {
  const c = opts.candidate;
  const adapter = opts.adapters.get(c.access.providerId);
  const run: RunModelResult = adapter
    ? await adapter.run({
        externalModelId: c.access.externalModelId,
        messages: opts.messages,
        maxTokens: c.maxOutputTokens,
        timeoutMs: opts.timeoutMs,
      })
    : {
        ok: false,
        text: "",
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        latencyMs: 0,
        finishReason: null,
        providerReportedCostUsd: null,
        error: `provider ${c.access.providerId} is not configured`,
        errorKind: "auth",
      };
  const estimatedCostUsd = run.ok ? taskCostUsd(run.inputTokens, run.outputTokens, c.access) : null;
  const source = opts.messages.map((m) => m.content).join("\n");
  const evaluation = run.ok ? evaluate(run.text, run.finishReason, opts.understanding, { wordMax: opts.wordMaxOverride, source }) : null;
  const passed = Boolean(run.ok && evaluation?.passed);
  return {
    candidate: c,
    run,
    estimatedCostUsd,
    // A failed result has no cost per success; neither does an unpriced one.
    costPerSuccessUsd: passed ? estimatedCostUsd : null,
    evaluation,
    passed,
  };
}

// Runs every given candidate with bounded concurrency and no spend control.
// Comparisons go through runProgressive (progressive.ts), which enforces the cap.
export async function executeCandidates(opts: {
  candidates: Candidate[];
  messages: ChatMessage[];
  adapters: Map<string, ProviderAdapter>;
  understanding: TaskUnderstanding;
  timeoutMs: number;
  maxConcurrent: number;
  wordMaxOverride?: number | null;
}): Promise<CandidateOutcome[]> {
  return pool(opts.candidates, opts.maxConcurrent, (candidate) => runCandidate({ ...opts, candidate }));
}
