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

// Signals that the work *produces* something other than text. A media word
// alone is not enough ("a cold email offering an AI video service" is text);
// it must be the thing being made, edited or converted into.
const MAKE = "(?:make|makes|making|made|create|creates|creating|generate|generates|generating|produce|produces|producing|render|rendering|edit|edits|editing|animate|animating|design|designing|draw|drawing|record|recording|compose|composing|shoot|shooting|film|filming|paint|painting|upscale|upscaling|turn\\w*\\s+\\w+(?:\\s+\\w+){0,3}\\s+into|convert\\w*\\s+\\w+(?:\\s+\\w+){0,3}\\s+(?:in)?to)";
const FILL = "(?:\\s+\\w+){0,3}?";
const NOT_A_BUSINESS = "(?!\\s+(?:service|services|company|agency|startup|tool|tools|platform|business|product|brand|app|studio|team)\\b)";

function produces(nouns: string): RegExp {
  return new RegExp(`\\b${MAKE}${FILL}\\s+(?:${nouns})\\b${NOT_A_BUSINESS}`);
}
function named(nouns: string): RegExp {
  // "video editing", "image generation", "AI videos" as the work itself.
  return new RegExp(
    `\\b(?:(?:${nouns})\\s+(?:generation|generator|creation|editing|editor|production|design)|ai\\s+(?:${nouns}))\\b${NOT_A_BUSINESS}`
  );
}

const VIDEO = "videos?|films?|movies?|clips?|reels?|animations?|footage|b roll|tiktoks?";
const IMAGE = "images?|photos?|photographs?|pictures?|illustrations?|logos?|thumbnails?|artwork|art|drawings?|portraits?|headshots?|graphics?|posters?|memes?|banners?|icons?|avatars?";
const AUDIO = "audio|music|songs?|podcasts?|beats?|jingles?|sound effects?|voices?";

const TASK_SIGNALS: [Capability, RegExp[]][] = [
  ["video", [produces(VIDEO), named(VIDEO), /\blip ?sync\w*\b/]],
  ["image", [produces(IMAGE), named(IMAGE)]],
  ["audio", [produces(AUDIO), named(AUDIO), /\b(?:transcri(?:be|bes|bed|bing|ption|ptions)|text to speech|tts|voice ?overs?|voice clon\w*|dubbing)\b/]],
  [
    "code",
    [
      /\b(?:coding|programming|debugging|refactoring|unit tests?|pull requests?)\b/,
      /\b(?:write|writes|writing|generate|generating|create|creating|build|building|fix|fixing|review|reviewing|debug|refactor)(?:\s+\w+){0,3}?\s+(?:code|functions?|python|javascript|typescript|sql|html|css|regex|bash)\b/,
    ],
  ],
];

export function detectTaskType(text: string): Capability | null {
  const t = norm(text);
  for (const [cap, patterns] of TASK_SIGNALS) if (patterns.some((re) => re.test(t))) return cap;
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
