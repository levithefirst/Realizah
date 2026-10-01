// Decides whether Realizah can run a comparison for a tool + task.
// Pure (no DB, no secrets) so the browser and the API share one rule.

export type Capability = "text" | "code" | "image" | "video" | "audio";

// v1 runs text-generation comparisons only.
export const SUPPORTED_CAPABILITIES: readonly Capability[] = ["text"];

export type AiTool = {
  slug: string;
  name: string;
  aliases: string[];
  capability: Capability;
  // Set only when ai_tools holds an explicit, sourced mapping. Never inferred.
  verifiedModelSlug: string | null;
};

export const UNSUPPORTED_MESSAGE =
  "We can't run this comparison yet. Realizah currently supports text-generation tasks.";

const LABEL: Record<Capability, string> = {
  text: "text-generation",
  code: "code",
  image: "image",
  video: "video",
  audio: "audio",
};

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Exact name/alias match, or the alias followed by more words
// ("ChatGPT Plus" -> ChatGPT). Longest alias wins.
export function matchTool(input: string, registry: AiTool[]): AiTool | null {
  const q = norm(input);
  if (!q) return null;
  let best: AiTool | null = null;
  let bestLen = 0;
  for (const t of registry) {
    for (const key of [t.name, t.slug, ...t.aliases].map(norm)) {
      if (!key) continue;
      if ((q === key || q.startsWith(key + " ")) && key.length > bestLen) {
        best = t;
        bestLen = key.length;
      }
    }
  }
  return best;
}

// Signals that the work produces something other than text.
const TASK_SIGNALS: [Capability, RegExp][] = [
  ["video", /\b(videos?|films?|movies?|clips?|reels?|animations?|animated|animate|footage|b roll|lip ?sync\w*)\b/],
  ["image", /\b(images?|photos?|photographs?|pictures?|illustrations?|logos?|thumbnails?|artwork|drawings?|portraits?|headshots?|graphics?|posters?|memes?)\b/],
  ["audio", /\b(audio|music|songs?|podcasts?|voice ?overs?|voice clon\w*|text to speech|tts|narration|dubbing|transcri\w*|sound effects?)\b/],
  ["code", /\b(code|coding|programming|debug\w*|refactor\w*|python|javascript|typescript|sql|unit tests?|pull requests?)\b/],
];

export function detectTaskType(text: string): Capability | null {
  const t = norm(text);
  for (const [cap, re] of TASK_SIGNALS) if (re.test(t)) return cap;
  return null;
}

export type SupportResult = {
  supported: boolean;
  tool: AiTool | null;
  // Capability of the work as far as we can tell: from the tool when we know
  // it, otherwise from the task wording.
  capability: Capability | "unknown";
  message: string;
};

export function checkSupport(
  input: { tool: string; useCase: string; task: string },
  registry: AiTool[]
): SupportResult {
  const tool = matchTool(input.tool, registry);
  if (tool && !SUPPORTED_CAPABILITIES.includes(tool.capability)) {
    return {
      supported: false,
      tool,
      capability: tool.capability,
      message: `${UNSUPPORTED_MESSAGE} ${tool.name} is a ${LABEL[tool.capability]} tool.`,
    };
  }
  const taskType = detectTaskType(`${input.useCase} ${input.task}`);
  if (taskType && !SUPPORTED_CAPABILITIES.includes(taskType)) {
    return {
      supported: false,
      tool,
      capability: taskType,
      message: `${UNSUPPORTED_MESSAGE} This looks like a ${LABEL[taskType]} task.`,
    };
  }
  return {
    supported: true,
    tool,
    capability: tool ? tool.capability : "unknown",
    message: tool
      ? `${tool.name} is a text-generation tool. Supported.`
      : "We don't have this tool on file, so we go by the task. It reads as text generation. Supported.",
  };
}
