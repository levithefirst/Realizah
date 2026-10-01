import { parseBudget } from "../budget";
import { MAX_WORD_CAP, MIN_WORD_CAP, parseWordCap } from "../wordLimit";
import type { ComparisonInput } from "./service";

export const MAX_TASK_CHARS = 8_000;

export function parseComparisonInput(body: Record<string, unknown>): { ok: true; input: ComparisonInput } | { ok: false; error: string } {
  const toolInput = String(body.tool ?? "").slice(0, 80).trim();
  const useCase = String(body.useCase ?? "").slice(0, 200).trim();
  // The task is the experiment: sent exactly as typed, never trimmed or cut.
  const task = typeof body.task === "string" ? body.task : "";
  if (!toolInput) return { ok: false, error: "Tell us which AI tool you use now." };
  if (!useCase) return { ok: false, error: "Tell us what you use it for." };
  if (!task.trim()) return { ok: false, error: "Enter the task to compare." };
  if (task.length > MAX_TASK_CHARS) return { ok: false, error: `Task is too long. Keep it under ${MAX_TASK_CHARS} characters.` };
  const budget = parseBudget(body.budgetUsd);
  if (budget === "invalid") return { ok: false, error: "Budget must be a dollar amount, like 20 or 2.50." };
  let wordMaxOverride: number | null = null;
  if (body.wordMax !== undefined && body.wordMax !== null && body.wordMax !== "") {
    wordMaxOverride = parseWordCap(body.wordMax as string | number);
    if (wordMaxOverride === null) return { ok: false, error: `Word limit must be a whole number from ${MIN_WORD_CAP} to ${MAX_WORD_CAP}.` };
  }
  return { ok: true, input: { toolInput, useCase, task, budgetUsd: budget, wordMaxOverride } };
}
