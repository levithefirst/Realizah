// Server-side registry of execution adapters. Add a direct provider by
// writing an adapter and listing it here; nothing else changes.
import { openAIAdapter } from "./openai";
import { openRouterAdapter } from "./openrouter";
import type { ProviderAdapter } from "./types";

export function defaultAdapters(): ProviderAdapter[] {
  return [openRouterAdapter(), openAIAdapter()];
}

export function configuredAdapters(adapters: ProviderAdapter[] = defaultAdapters()): Map<string, ProviderAdapter> {
  return new Map(adapters.filter((a) => a.isConfigured()).map((a) => [a.id, a]));
}
