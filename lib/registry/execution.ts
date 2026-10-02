// Execution class of an access path. Realizah's comparisons are interactive:
// one synchronous chat-completions request per model, answered in the same
// HTTP call. Some catalog ids are variants of a model that can't be served
// that way (OpenRouter's ":batch" SKUs are submitted as asynchronous batch
// jobs). Those are access paths of the same model, never a separate
// interactive candidate.

export type ExecutionClass = "interactive" | "batch";

// Variant suffixes ("model:variant") that are access paths of the base model.
// ":free" is interactive (free tier); ":batch" is asynchronous.
const VARIANT_CLASS: Record<string, ExecutionClass> = { free: "interactive", batch: "batch" };

export function variantOf(externalModelId: string): string | null {
  const m = /:([a-z0-9-]+)$/i.exec(externalModelId);
  return m && m[1].toLowerCase() in VARIANT_CLASS ? m[1].toLowerCase() : null;
}

// The model id without a known access-path variant suffix.
export function baseModelId(externalModelId: string): string {
  const v = variantOf(externalModelId);
  return v ? externalModelId.slice(0, -(v.length + 1)) : externalModelId;
}

export function executionClass(externalModelId: string): ExecutionClass {
  const v = variantOf(externalModelId);
  return v ? VARIANT_CLASS[v] : "interactive";
}

export function isInteractive(a: { externalModelId: string }): boolean {
  return executionClass(a.externalModelId) === "interactive";
}
