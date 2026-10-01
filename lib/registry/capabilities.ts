// Capabilities come only from source metadata (modalities and the parameters
// a provider says it accepts). A model's name never grants a capability.
import type { NormalizedModel } from "./types";

export function deriveCapabilities(m: Pick<NormalizedModel, "inputModalities" | "outputModalities" | "supportedParameters">): string[] {
  const caps = new Set<string>();
  const out = new Set(m.outputModalities);
  const inp = new Set(m.inputModalities);
  const params = new Set(m.supportedParameters);
  if (out.has("text")) caps.add("text_generation");
  if (out.has("image")) caps.add("image_generation");
  if (out.has("audio")) caps.add("audio_generation");
  if (out.has("video")) caps.add("video_generation");
  if (inp.has("image")) caps.add("image_input");
  if (inp.has("audio")) caps.add("audio_input");
  if (inp.has("video")) caps.add("video_input");
  if (inp.has("file")) caps.add("file_input");
  if (params.has("tools")) caps.add("tool_use");
  if (params.has("structured_outputs") || params.has("response_format")) caps.add("structured_output");
  if (params.has("reasoning") || params.has("include_reasoning")) caps.add("reasoning");
  return [...caps].sort();
}
